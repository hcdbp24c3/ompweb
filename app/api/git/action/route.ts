import { statSync } from "fs";
import { NextResponse } from "next/server";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
} from "@/lib/file-access";
import { AmbiguousGitCredentialError } from "@/lib/git-credential-resolve";
import {
  GitWriteError,
  commit,
  pull,
  push,
  stage,
  type GitWriteOptions,
  type GitWriteResult,
} from "@/lib/git-write";

// POST /api/git/action  body: { cwd, action, paths?, message?, refspec?, id? }
//
// One door for the four write operations. Two of them answer JSON (stage and
// commit are local and finish in milliseconds); the two that talk to a remote
// answer an NDJSON stream, because a push or a pull is minutes of output the
// user should watch rather than a spinner they cannot cancel. A caller therefore
// has exactly ONE way to read a given action: `Content-Type` decides, and for
// the streamed pair EVERY outcome — including a refusal that happens before git
// is spawned — arrives as a frame, never as a status code. Mixing the two would
// mean a client parsing two shapes and guessing which one it got.
//
// The cwd gate is /api/git/status's gate, verbatim. A write endpoint that
// skipped it would be the one route in the app that could be pointed at any
// directory on the host.
//
// `id` names an in-flight streamed operation so DELETE can cancel it while its
// stream stays open to report the cancellation, exactly as /api/projects/clone
// does. A client that simply disconnects gets the same abort through the
// stream's own `cancel` — there is no path here that leaves a child running.

// The two operations that stream. Everything about the response shape follows
// from this one set.
const STREAMED = new Set(["push", "pull"]);
const ACTION_ID = /^[A-Za-z0-9-]{1,64}$/;
const running = new Map<string, AbortController>();

type ActionFrame =
  | { type: "output"; text: string }
  | { type: "done" }
  | { type: "cancelled" }
  | { type: "error"; error: string; code: string };

/** Same checks, same order and same codes as /api/git/status: absolute, inside
 *  an allowed root, an existing directory, and still allowed once the path is
 *  resolved — the first check is against the request, the last against the disk. */
async function checkCwdAllowed(cwd: string): Promise<NextResponse | null> {
  if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
    return NextResponse.json({ error: "cwd must be an absolute path", code: "cwd_must_be_absolute" }, { status: 400 });
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(cwd, allowedRoots)) {
    return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
  }
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(cwd);
  } catch {
    return NextResponse.json({ error: "Directory not found", code: "directory_not_found" }, { status: 404 });
  }
  if (!stat.isDirectory()) {
    return NextResponse.json({ error: "Not a directory", code: "not_a_directory" }, { status: 400 });
  }
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
  }
  return null;
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof GitWriteError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
  }
  // Refusing beats guessing: an undecidable store must not push as whichever
  // record happened to be first.
  if (error instanceof AmbiguousGitCredentialError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
  }
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
}

function errorFrame(error: unknown): ActionFrame {
  if (error instanceof GitWriteError) return { type: "error", error: error.message, code: error.code };
  if (error instanceof AmbiguousGitCredentialError) return { type: "error", error: error.message, code: error.code };
  // An unexpected failure is still a frame (the operation already started), so it
  // carries the generic code rather than borrowing one that blames git.
  return { type: "error", error: error instanceof Error ? error.message : String(error), code: "generic" };
}

/** The four operations, behind the one shape the request body uses. */
function operate(
  action: string,
  cwd: string,
  body: Record<string, unknown>,
  options: GitWriteOptions,
): Promise<GitWriteResult> {
  // An absent or non-array `paths` becomes an empty list, which the layer refuses
  // — "choose at least one file" rather than "everything".
  const paths = Array.isArray(body.paths) ? body.paths as string[] : [];
  switch (action) {
    case "stage":
      return stage(cwd, paths, options);
    case "commit":
      return commit(cwd, { message: body.message, paths }, options);
    case "push":
      return push(cwd, { refspec: body.refspec }, options);
    default:
      return pull(cwd, options);
  }
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request", code: "invalid_request" }, { status: 400 });
  }

  const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
  const denied = await checkCwdAllowed(cwd);
  if (denied) return denied;

  const action = typeof body.action === "string" ? body.action : "";
  if (!STREAMED.has(action) && action !== "stage" && action !== "commit") {
    return NextResponse.json({ error: "Unknown action", code: "git_action_required" }, { status: 400 });
  }

  const streamed = STREAMED.has(action);
  // Registered before any await, so a cancel sent while the child is being
  // started is not a 404.
  const controller = new AbortController();
  const id = streamed && typeof body.id === "string" && ACTION_ID.test(body.id) ? body.id : null;
  if (id) {
    if (running.has(id)) {
      return NextResponse.json({ error: "That action is already running", code: "git_action_in_progress" }, { status: 400 });
    }
    running.set(id, controller);
  }
  req.signal.addEventListener("abort", () => controller.abort(), { once: true });
  if (req.signal.aborted) controller.abort();

  // One options object for both shapes of answer, so there is exactly one place
  // the child's lifetime is decided: the streamed branch below only adds where
  // its output goes.
  const options: GitWriteOptions = { signal: controller.signal };

  if (!streamed) {
    try {
      const result = await operate(action, cwd, body, options);
      return NextResponse.json({ ok: true, output: result.output });
    } catch (error) {
      return errorResponse(error);
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(streamController) {
      const send = (frame: ActionFrame) => {
        try {
          streamController.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        } catch {
          // The client is gone; the operation still finishes its cleanup.
        }
      };
      options.onOutput = (text) => send({ type: "output", text });
      try {
        const result = await operate(action, cwd, body, options);
        if (result.cancelled) send({ type: "cancelled" });
        else send({ type: "done" });
      } catch (error) {
        send(errorFrame(error));
      } finally {
        if (id) running.delete(id);
        try {
          streamController.close();
        } catch {
          // Already closed by a disconnect.
        }
      }
    },
    cancel() {
      controller.abort();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// DELETE /api/git/action  body: { id } — cancel an in-flight push or pull.
export async function DELETE(req: Request) {
  const body = await req.json().catch(() => ({})) as { id?: unknown };
  const controller = typeof body.id === "string" ? running.get(body.id) : undefined;
  if (!controller) {
    return NextResponse.json({ error: "No action in progress", code: "git_action_not_running" }, { status: 404 });
  }
  controller.abort();
  return NextResponse.json({ ok: true });
}