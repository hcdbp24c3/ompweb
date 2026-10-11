import { NextResponse } from "next/server";
import { isApiRequestOriginAllowed, shouldCheckApiRequestOrigin } from "@/lib/request-security";
import { deleteProviderKey, listProviderKeys, saveProviderKey } from "@/lib/api-key-store";

export const dynamic = "force-dynamic";

/**
 * GET/PUT/DELETE /api/provider-keys
 *
 * Sets and clears model-provider credentials. `GET` answers `hasValue` flags
 * only — the decrypted secret has no route, the same line AGENTS.md draws for
 * API-key status endpoints and the one `gh-env` route breaks deliberately.
 */
export function GET() {
  try {
    return NextResponse.json(listProviderKeys());
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  if (shouldCheckApiRequestOrigin(request) && !isApiRequestOriginAllowed(request)) {
    return NextResponse.json({ error: "Cross-origin API requests are not allowed", code: "cross_origin_forbidden" }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Body must be an object", code: "invalid_request" }, { status: 400 });
  }
  const { providerId, envVar, value } = body as { providerId?: unknown; envVar?: unknown; value?: unknown };
  if (typeof providerId !== "string" || typeof envVar !== "string" || typeof value !== "string") {
    return NextResponse.json({ error: "providerId, envVar and value must be strings", code: "invalid_request" }, { status: 400 });
  }
  try {
    const status = saveProviderKey(providerId, envVar, value);
    return NextResponse.json({ success: true, provider: status, providers: listProviderKeys().providers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error), code: "invalid_request" }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  if (shouldCheckApiRequestOrigin(request) && !isApiRequestOriginAllowed(request)) {
    return NextResponse.json({ error: "Cross-origin API requests are not allowed", code: "cross_origin_forbidden" }, { status: 403 });
  }
  const params = new URL(request.url).searchParams;
  const providerId = params.get("providerId") ?? "";
  if (!providerId) {
    return NextResponse.json({ error: "providerId is required", code: "invalid_request" }, { status: 400 });
  }
  try {
    const envVar = params.get("envVar");
    return NextResponse.json({ success: true, ...deleteProviderKey(providerId, envVar ?? undefined), providers: listProviderKeys().providers });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}