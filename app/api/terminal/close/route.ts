import { NextResponse } from "next/server";
import { getSharedPtyRegistry } from "@/lib/terminal/pty-registry";
import { guardTerminalCwd } from "@/lib/terminal/guard";

export const dynamic = "force-dynamic";

/** POST { cwd } — kill the shell now instead of waiting for idle reaping.
 *  Reached only from an explicit "stop shell" control; closing a browser tab
 *  detaches, it does not call this. */
export async function POST(request: Request) {
  let body: { cwd?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body", code: "terminal_invalid_body" }, { status: 400 });
  }

  const guard = await guardTerminalCwd(body?.cwd);
  if ("response" in guard) return guard.response;

  // The registry has no lookup-then-kill, and attach() *spawns* when the cwd is
  // not already live — so attaching here would start a shell just to kill it,
  // and would throw the cap error once four are open. Only kill what is running.
  const registry = getSharedPtyRegistry();
  if (registry.activeCwds().includes(guard.cwd)) {
    registry.attach(guard.cwd, 80, 24).kill();
  }

  return NextResponse.json({ ok: true });
}