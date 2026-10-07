import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { getSharedPtyRegistry, TooManyTerminalsError, type TerminalHandle } from "@/lib/terminal/pty-registry";
import { guardTerminalCwd } from "@/lib/terminal/guard";
import { ghEnvForSpawn } from "@/lib/gh-env";
import { loadWebSearchEnv } from "@/lib/api-key-store";
import { gitIdentityEnvForSpawn } from "@/lib/git-identity";

export const dynamic = "force-dynamic";

// Applied while the body is read, so a chunked POST with no Content-Length
// cannot push arbitrary bytes through before anything notices. Well above a
// keystroke burst (one write per xterm onData) and above a large paste, and far
// below the point where buffering matters.
const MAX_INPUT_REQUEST_BYTES = 256 * 1024;
// Narrower cap on the `data` field alone: it is what actually reaches a pty
// write, and it is checked on the parsed value.
const MAX_INPUT_BYTES = 64 * 1024;
// Duplicated verbatim in app/api/terminal/stream/route.ts — there is no shared
// constant, so raising one limit without the other means a shell the stream
// spawned at that size refuses to be resized to it.
const MAX_COLS = 500;
const MAX_ROWS = 300;

interface TerminalInputBody {
  cwd?: unknown;
  data?: unknown;
  cols?: unknown;
  rows?: unknown;
}

/**
 * POST body: { cwd, data? } for keystrokes, { cwd, cols, rows } for a resize.
 *
 * A single endpoint rather than two because both are "the shell changed" and
 * they race each other on one stream — splitting them would let a resize land
 * before the keystrokes it belongs to.
 */
export async function POST(request: Request) {
  let body: TerminalInputBody;
  try {
    body = await parseJsonWithinLimit<TerminalInputBody>(request, MAX_INPUT_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json(
        { error: "Request body too large", code: "terminal_request_too_large" },
        { status: 413 },
      );
    }
    return NextResponse.json({ error: "Invalid JSON body", code: "terminal_invalid_body" }, { status: 400 });
  }

  const guard = await guardTerminalCwd(body?.cwd);
  if ("response" in guard) return guard.response;
  const { cwd } = guard;

  const hasData = body.data !== undefined;
  const hasSize = body.cols !== undefined || body.rows !== undefined;

  if (!hasData && !hasSize) {
    return NextResponse.json(
      { error: "Expected data or cols/rows", code: "terminal_input_empty" },
      { status: 400 },
    );
  }

  if (hasData && typeof body.data !== "string") {
    // Coercing here would turn an object into "[object Object]" and write that
    // into the user's shell.
    return NextResponse.json(
      { error: "data must be a string", code: "terminal_input_invalid" },
      { status: 400 },
    );
  }
  if (typeof body.data === "string" && Buffer.byteLength(body.data, "utf8") > MAX_INPUT_BYTES) {
    return NextResponse.json({ error: "Input too large", code: "terminal_input_too_large" }, { status: 413 });
  }

  // A resize is one value: the pty takes both dimensions, so half of one is not
  // a resize the server could apply. xterm always sends the pair. The validated
  // pair is carried forward rather than re-read off `body` with a cast, because
  // the cast is what let a missing dimension reach resize() as `undefined`.
  let resize: { cols: number; rows: number } | null = null;
  if (hasSize) {
    const { cols, rows } = body;
    if (
      typeof cols !== "number" || !Number.isInteger(cols) || cols < 1 || cols > MAX_COLS ||
      typeof rows !== "number" || !Number.isInteger(rows) || rows < 1 || rows > MAX_ROWS
    ) {
      return NextResponse.json(
        { error: "cols and rows must be whole numbers in range", code: "terminal_size_invalid" },
        { status: 400 },
      );
    }
    resize = { cols, rows };
  }

  const registry = getSharedPtyRegistry();
  let handle: TerminalHandle;
  try {
    // Attach rather than look up: posting to a shell that was reaped should
    // start a new one, not silently drop the keystroke. That is also why the gh
    // token is resolved here as well as on the stream route — this attach can
    // spawn. It is cached per cwd, so the common case (a live shell, where the
    // override is discarded) costs one map lookup per keystroke. The commit
    // identity is resolved with it, for the same reason.
    handle = registry.attach(cwd, 80, 24, { env: { ...(await ghEnvForSpawn(cwd)), ...(await gitIdentityEnvForSpawn(cwd)), ...loadWebSearchEnv() } });
  } catch (error) {
    if (error instanceof TooManyTerminalsError) {
      return NextResponse.json(
        { error: "Too many terminals are open. Close one and try again.", code: "terminal_limit_reached" },
        { status: 429 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), code: "terminal_spawn_failed" },
      { status: 500 },
    );
  }

  if (typeof body.data === "string") handle.write(body.data);
  if (resize) handle.resize(resize.cols, resize.rows);

  return NextResponse.json({ ok: true });
}
