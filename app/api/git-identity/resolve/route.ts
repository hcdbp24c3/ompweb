import { NextResponse } from "next/server";
import { isApiRequestOriginAllowed, shouldCheckApiRequestOrigin } from "@/lib/request-security";
import { GitIdentityError, resolveGitIdentity } from "@/lib/git-identity";

export const dynamic = "force-dynamic";

/**
 * GET /api/git-identity/resolve?cwd=
 *
 * Which identity actually applies to a workspace, and WHY — `via` is
 * "selected" | "project" | "default". The Git tab's picker needs this rather
 * than reproducing the resolution order client-side, because a second copy of
 * that order is precisely what drifts out of step with the server.
 *
 * The cwd is query-gated by the caller (the right panel only offers the picker
 * for an allowed workspace); it resolves to a canonical project root server-side
 * and a worktree maps to its main checkout, so a client cannot point one
 * repository's identity at another's.
 *
 * Returns the identity itself, not a secret: a name and an email are personal
 * data the settings panel already shows back.
 */
export async function GET(request: Request) {
  if (shouldCheckApiRequestOrigin(request) && !isApiRequestOriginAllowed(request)) {
    return NextResponse.json({ error: "Cross-origin API requests are not allowed", code: "cross_origin_forbidden" }, { status: 403 });
  }
  const cwd = new URL(request.url).searchParams.get("cwd") ?? undefined;
  try {
    const resolved = await resolveGitIdentity({ cwd });
    if (!resolved) {
      return NextResponse.json({ identityId: null, via: null, identity: null }, { headers: { "Cache-Control": "no-store" } });
    }
    const store = await import("@/lib/git-identity").then((module) => module.loadGitIdentityStore());
    const identityId = resolved.via === "selected"
      ? (store.selection?.[store.selection ? Object.keys(store.selection).find((key) => key === resolved.projectRoot) ?? "" : ""] ?? null)
      : null;
    return NextResponse.json(
      { identityId, via: resolved.via, identity: resolved.identity },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof GitIdentityError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}