import { NextResponse } from "next/server";
import { syncInterruptibleSessions } from "@/lib/rpc-manager";
import { loadWebServerSettings, saveWebServerSettings, type WebServerSettings } from "@/lib/web-settings";

export const dynamic = "force-dynamic";

const SETTING_KEYS = ["autoResumeSessions", "autoUpdateOmp"] as const;
type SettingKey = (typeof SETTING_KEYS)[number];

function isSettingKey(key: string): key is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(key);
}

// GET/PUT /api/web-settings - omp-web's own server-side settings.
export async function GET() {
  return NextResponse.json(loadWebServerSettings());
}

export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Settings must be an object", code: "invalid_settings" }, { status: 400 });
  }
  const entries = Object.entries(body as Record<string, unknown>);

  // An unknown key is rejected rather than ignored. This route has no other way
  // to say "I did not understand you": a misspelt `autoUpdateOML` used to look
  // like a successful save and then change nothing, which is the worst possible
  // outcome for a setting that decides whether a runtime gets replaced.
  const unknown = entries.map(([key]) => key).filter((key) => !isSettingKey(key));
  if (unknown.length > 0) {
    return NextResponse.json({ error: `Unknown setting: ${unknown.join(", ")}`, code: "invalid_settings" }, { status: 400 });
  }

  // A PARTIAL patch, not a whole document. Each toggle owns one field, so a
  // client turning one on sends only that field; requiring the others made the
  // second toggle impossible to ever set.
  const patch: Partial<WebServerSettings> = {};
  for (const [key, value] of entries) {
    if (typeof value !== "boolean") {
      return NextResponse.json({ error: `${key} must be a boolean`, code: "invalid_settings" }, { status: 400 });
    }
    patch[key as SettingKey] = value;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No settings supplied", code: "invalid_settings" }, { status: 400 });
  }

  const settings = saveWebServerSettings(patch);
  // Only sessions are affected by this toggle, and only when it actually
  // changed — an auto-update save must not disturb anything that is running.
  if (patch.autoResumeSessions !== undefined) syncInterruptibleSessions();
  return NextResponse.json(settings);
}