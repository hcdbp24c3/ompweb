import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import {
  GitCredentialError,
  deleteGitCredential,
  gitCredentialsFiles,
  listGitCredentials,
  saveGitCredential,
  type GitCredentialSummary,
} from "@/lib/git-credentials";

// Auth is proxy.ts's job: every /api/ route sits behind the same web-password
// gate, so there is no per-route authorization to extend here.

export const dynamic = "force-dynamic";
const MAX_REQUEST_BYTES = 512 * 1024;

function errorResponse(error: unknown) {
  if (error instanceof RequestBodyTooLargeError) {
    return NextResponse.json({ error: "Git credential request is too large", code: "too_large" }, { status: 413 });
  }
  if (error instanceof GitCredentialError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
  }
  console.error("[api/git-credentials] request failed:", error);
  return NextResponse.json({ error: "Could not read the git credential store" }, { status: 500 });
}

/** The browser-facing shape: a freshly built summary, so no secret field can
 *  reach the client even if the summary type grows one by accident. */
function toSummary(credential: GitCredentialSummary): GitCredentialSummary {
  return {
    id: credential.id,
    name: credential.name,
    host: credential.host,
    account: credential.account,
    type: credential.type,
    isDefaultForHost: credential.isDefaultForHost,
    hasToken: credential.hasToken,
    hasPrivateKey: credential.hasPrivateKey,
    hasPassphrase: credential.hasPassphrase,
  };
}

export async function GET() {
  try {
    const { keyPath } = gitCredentialsFiles();
    const store = listGitCredentials();
    return NextResponse.json({ path: store.path, keyPath, credentials: store.credentials.map(toSummary) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const body = await parseJsonWithinLimit<Record<string, unknown>>(request, MAX_REQUEST_BYTES);
    // saveGitCredential never returns a secret, but the stored record is
    // re-summarized here so a future return-shape change cannot leak one.
    const saved = saveGitCredential(body);
    return NextResponse.json({ success: true, credential: toSummary(saved) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await parseJsonWithinLimit<{ id?: unknown }>(request, MAX_REQUEST_BYTES);
    return NextResponse.json({ success: true, ...deleteGitCredential(body.id) });
  } catch (error) {
    return errorResponse(error);
  }
}
