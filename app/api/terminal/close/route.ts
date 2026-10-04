import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { getSharedPtyRegistry } from "@/lib/terminal/pty-registry";
import { guardTerminalCwd } from "@/lib/terminal/guard";

export const dynamic = "force-dynamic";

// { cwd } and nothing else, so this is small enough that any request near the
// cap is already nonsense. Bounded while reading rather than after, so a
// chunked POST cannot stream an unbounded body in first.
const MAX_CLOSE_REQUEST_BYTES = 4 * 1024;

/** POST { cwd } — kill the shell now instead of waiting for idle reaping.
 *  Reached only from an explicit "stop shell" control; closing a browser tab
 *  detaches, it does not call this. */
export async function POST(request: Request) {
  let body: { cwd?: unknown };
  try {
    body = await parseJsonWithinLimit<{ cwd?: unknown }>(request, MAX_CLOSE_REQUEST_BYTES);
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

  // The registry has no lookup-then-kill, and attach() *spawns* when the cwd is
  // not already live — so attaching here would start a shell just to kill it.
  // activeCwds() narrows that to the shells that are running.
  const registry = getSharedPtyRegistry();
  if (registry.activeCwds().includes(guard.cwd)) {
    try {
      registry.attach(guard.cwd, 80, 24).kill();
    } catch {
      // The entry was disposed between the check and the attach, so attach took
      // the spawn branch — and losing that race means the shell is already gone,
      // which is what close wanted. A 500 here would be worse than the no-op:
      // close is idempotent from the UI's side.
      //
      // Follow-up: an atomic `killIfRunning(cwd)` on PtyRegistry would remove
      // this window entirely. Not added here because pty-registry.ts is Task 1's
      // and out of scope for this task.
    }
  }

  return NextResponse.json({ ok: true });
}
