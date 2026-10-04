import { NextResponse } from "next/server";
import { getSharedPtyRegistry, TooManyTerminalsError, type TerminalHandle } from "@/lib/terminal/pty-registry";
import { guardTerminalCwd } from "@/lib/terminal/guard";

export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;
const MAX_COLS = 500;
const MAX_ROWS = 300;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function dimension(raw: string | null, fallback: number, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, max);
}

/** SSE out: replays scrollback, then streams live output. Writes go the other
 *  way, through /api/terminal/input — a POST cannot be delivered over an SSE
 *  response, which is why there is no WebSocket here. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const guard = await guardTerminalCwd(searchParams.get("cwd"));
  if ("response" in guard) return guard.response;
  const { cwd } = guard;

  const cols = dimension(searchParams.get("cols"), DEFAULT_COLS, MAX_COLS);
  const rows = dimension(searchParams.get("rows"), DEFAULT_ROWS, MAX_ROWS);
  const registry = getSharedPtyRegistry();

  let handle: TerminalHandle;
  try {
    handle = registry.attach(cwd, cols, rows);
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

  // Hoisted so the stream's cancel() — a half-open disconnect that never fires
  // the abort signal — can reach the same teardown, exactly as the session
  // events route does.
  let teardown: (() => void) | null = null;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      const releases: Array<() => void> = [];

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat !== null) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        request.signal.removeEventListener("abort", cleanup);
        // Every path out of this stream — a failed write, the abort signal, the
        // reader's cancel, the shell exiting — comes through here, and that is
        // the whole point: releasing the subscriptions is what empties
        // entry.listeners, and an empty listener set is the only state that
        // re-arms the idle reaper. A shell somebody is watching can therefore
        // never be reaped out from under them.
        try {
          for (const release of releases.splice(0)) {
            try {
              release();
            } catch {
              // One broken unsubscribe must not strand the others.
            }
          }
        } finally {
          registry.detach(cwd);
        }
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      const write = (event: string, data: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: event, ...data })}\n\n`));
        } catch {
          // Cannot deliver, so this stream is over — and it has to go through
          // cleanup rather than just flipping `closed`, or the subscription
          // stays on the shell for good.
          cleanup();
        }
      };

      teardown = cleanup;

      try {
        // A client that disconnected while the guard was still awaiting has
        // already fired its signal, and addEventListener would never fire again
        // — so the subscription would outlive the browser and the shell would
        // never be reaped. Checked before anything is subscribed or written.
        if (request.signal.aborted) {
          cleanup();
          return;
        }

        // Subscribe BEFORE replaying, so output printed during the replay is not
        // lost between the two.
        releases.push(handle.addListener((chunk) => write("output", { data: chunk })));

        // A shell that dies must end the stream. Silence would leave a frozen
        // terminal on screen whose every later keystroke is dropped.
        releases.push(
          handle.onExit(() => {
            write("exit", { data: "" });
            cleanup();
          }),
        );

        write("replay", { data: handle.replay(), cols, rows });

        // An idle shell keeps its SSE open the way the login flow does: without
        // this a proxy drops a quiet shell at its read timeout.
        heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(":keepalive\n\n"));
          } catch {
            cleanup();
          }
        }, HEARTBEAT_MS);

        request.signal.addEventListener("abort", cleanup);
      } catch (error) {
        // A registration that threw part-way would otherwise strand a live
        // subscription on a stream that never opened.
        cleanup();
        throw error;
      }
    },
    cancel() {
      // The reader went away; detach so idle reaping can take the shell.
      teardown?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}