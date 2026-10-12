import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import {
  GitIdentityError,
  applyGitIdentitySelection,
  applyGitIdentityUpdate,
  applyNamedGitIdentityUpdate,
  invalidateGitIdentityCache,
  listGitIdentities,
} from "@/lib/git-identity";

// Auth is proxy.ts's job: every /api/ route sits behind the same web-password
// gate, so there is no per-route authorization to extend here.
//
// GET deliberately takes no Request. The store is one global-plus-overrides
// record, so the browser is told what exists — never "which identity does this
// directory use", which would turn this into a probe over paths the caller
// chooses.

export const dynamic = "force-dynamic";
const MAX_REQUEST_BYTES = 8 * 1024;

function errorResponse(error: unknown) {
  if (error instanceof RequestBodyTooLargeError) {
    return NextResponse.json({ error: "Git identity request is too large", code: "too_large" }, { status: 413 });
  }
  if (error instanceof GitIdentityError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
  }
  console.error("[api/git-identity] request failed:", error);
  return NextResponse.json({ error: "Could not read the git identity store" }, { status: 500 });
}

export async function GET() {
  try {
    return NextResponse.json(listGitIdentities());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const body = await parseJsonWithinLimit<Record<string, unknown>>(request, MAX_REQUEST_BYTES);
    // `action` keeps the existing payloads untouched: the Settings panel still
    // posts `{ name, email }` / `{ project }`, and the Git tab's combo box posts
    // the two new shapes. Overloading `project` for a workspace choice would
    // have made the old and new meanings indistinguishable.
    const action = body.action;
    if (action === "select") await applyGitIdentitySelection(body);
    else if (action === "named") applyNamedGitIdentityUpdate(body);
    else await applyGitIdentityUpdate(body);
    // An identity edited in Settings has to reach the next child at once, not
    // after the per-cwd cache window.
    invalidateGitIdentityCache();
    return NextResponse.json({ success: true, ...listGitIdentities() });
  } catch (error) {
    return errorResponse(error);
  }
}
