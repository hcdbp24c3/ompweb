import { NextResponse } from "next/server";
import { existsSync, statSync } from "fs";
import { isAbsolute, resolve } from "path";
import { getAllowedFileRoots, isExistingPathWithinRoots } from "@/lib/file-access";
import { isWebPasswordEnabled } from "@/lib/web-auth";

export type TerminalGuardResult = { cwd: string } | { response: NextResponse };

/**
 * The single gate every terminal route passes through.
 *
 * Three checks, and the order matters:
 *   1. password — checked first so an open instance never reaches the
 *      filesystem, and so the user gets an actionable message instead of a
 *      silently dead terminal;
 *   2. allowlist — the same boundary /api/files uses, so the terminal adds no
 *      permission surface;
 *   3. existence — a cwd that vanished must not spawn a shell that fails
 *      silently.
 */
export async function guardTerminalCwd(cwd: unknown): Promise<TerminalGuardResult> {
  if (!isWebPasswordEnabled()) {
    return {
      response: NextResponse.json(
        {
          error: "The terminal requires a web password. Set OMP_WEB_PASSWORD and restart omp-web.",
          code: "terminal_auth_required",
        },
        { status: 503 },
      ),
    };
  }

  if (typeof cwd !== "string" || !cwd.trim()) {
    return {
      response: NextResponse.json({ error: "cwd required", code: "terminal_cwd_required" }, { status: 400 }),
    };
  }

  const target = isAbsolute(cwd) ? resolve(cwd) : resolve(process.cwd(), cwd);
  const roots = await getAllowedFileRoots();
  if (!isExistingPathWithinRoots(target, roots)) {
    return {
      response: NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 }),
    };
  }

  if (!existsSync(target) || !statSync(target).isDirectory()) {
    return {
      response: NextResponse.json(
        { error: "Terminal directory not found", code: "terminal_cwd_not_found" },
        { status: 404 },
      ),
    };
  }

  return { cwd: target };
}