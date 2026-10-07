import { NextResponse } from "next/server";
import { isApiRequestOriginAllowed, shouldCheckApiRequestOrigin } from "@/lib/request-security";
import { deleteWebSearchBackend, listWebSearchKeys, saveWebSearchBackend } from "@/lib/api-key-store";
import { webSearchBackend, WEB_SEARCH_BACKENDS } from "@/lib/web-search-backends";

export const dynamic = "force-dynamic";

/**
 * GET/PUT/DELETE /api/web-search-keys
 *
 * The browser may set and clear credentials, and see WHETHER each one is
 * present. It may never read one back: `listWebSearchKeys` reports `hasValue`,
 * and the decrypted environment has no route at all — the same line AGENTS.md
 * draws for API-key status endpoints. `/api/git-credentials/gh-env` is the one
 * existing exception, and it is a deliberate tradeoff, not a pattern.
 */
function forbidden(): NextResponse {
  return NextResponse.json({ error: "Cross-origin API requests are not allowed", code: "cross_origin_forbidden" }, { status: 403 });
}

export function GET() {
  try {
    // The field schema travels with the listing so a settings screen cannot
    // hardcode env var names and drift from what omp actually reads.
    return NextResponse.json({
      ...listWebSearchKeys(),
      backendsSchema: WEB_SEARCH_BACKENDS.map((entry) => ({ id: entry.id, label: entry.label, fields: entry.fields })),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

/** The schema a settings screen renders from, so the editor cannot drift from
 *  what omp reads. `hasValue` starts false and `value` is never sent. */
export async function PUT(request: Request) {
  if (shouldCheckApiRequestOrigin(request) && !isApiRequestOriginAllowed(request)) return forbidden();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Body must be an object", code: "invalid_request" }, { status: 400 });
  }
  const { backend, values } = body as { backend?: unknown; values?: unknown };
  if (typeof backend !== "string" || !webSearchBackend(backend)) {
    return NextResponse.json({ error: "Unknown web search backend", code: "invalid_request" }, { status: 400 });
  }
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    return NextResponse.json({ error: "values must be an object", code: "invalid_request" }, { status: 400 });
  }
  const plain: Record<string, string> = {};
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (typeof value === "string") plain[key] = value;
  }
  try {
    const status = saveWebSearchBackend(backend, plain);
    return NextResponse.json({ success: true, backend: status, backends: listWebSearchKeys().backends });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error), code: "invalid_request" }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  if (shouldCheckApiRequestOrigin(request) && !isApiRequestOriginAllowed(request)) return forbidden();
  const backend = new URL(request.url).searchParams.get("backend") ?? "";
  if (!webSearchBackend(backend)) {
    return NextResponse.json({ error: "Unknown web search backend", code: "invalid_request" }, { status: 400 });
  }
  try {
    return NextResponse.json({ success: true, ...deleteWebSearchBackend(backend), backends: listWebSearchKeys().backends });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

/** The field schema, for a settings screen that must not hardcode env names. */
export const BACKEND_FIELDS = WEB_SEARCH_BACKENDS.map((entry) => ({ id: entry.id, label: entry.label, fields: entry.fields }));
