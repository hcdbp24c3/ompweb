import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// A session only records a `thinking_level_change` entry once the user has
// CHANGED the level inside it. So every untouched session reported a hardcoded
// "off" — while the user's own config.yml said `defaultThinkingLevel: auto`.
// Opening such a session therefore contradicted the setting they had
// configured, and looked like the app had silently reset their choice.

const jiti = createJiti(import.meta.url, { tryNative: false, alias: { "@/": new URL("../", import.meta.url).pathname } });
const { buildSessionContext } = await jiti.import("../lib/session-reader.ts");


const header = { type: "session", version: 3, id: "abc", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" };

test("buildSessionContext reports the configured default for a session with no entry", () => {
  const parsed = [
    { ...header, id: "h" },
    { type: "message", id: "m1", parentId: "h", message: { role: "user", content: "hi" } },
  ];
  const withDefault = buildSessionContext(parsed, "m1", { defaultThinkingLevel: "auto" });
  assert.equal(withDefault.thinkingLevel, "auto",
    "an untouched session must not claim the user is on off when config.yml says auto");

  const explicit = buildSessionContext(parsed, "m1", { defaultThinkingLevel: "high" });
  assert.equal(explicit.thinkingLevel, "high");
});

test("without the option the behaviour is unchanged, so empty paging calls are unaffected", () => {
  const parsed = [{ ...header, id: "h" }];
  assert.equal(buildSessionContext(parsed, null).thinkingLevel, "off");
});

test("an explicit entry still wins over the default", () => {
  const parsed = [
    { ...header, id: "h" },
    { type: "message", id: "m1", parentId: "h", message: { role: "user", content: "hi" } },
    { type: "thinking_level_change", id: "t1", parentId: "m1", thinkingLevel: "low", configured: null },
  ];
  const context = buildSessionContext(parsed, "t1", { defaultThinkingLevel: "auto" });
  assert.equal(context.thinkingLevel, "low",
    "a level the user actually picked must not be overwritten by the global default");
});

test("an Auto entry survives a configured default too", () => {
  const parsed = [
    { ...header, id: "h" },
    { type: "message", id: "m1", parentId: "h", message: { role: "user", content: "hi" } },
    { type: "thinking_level_change", id: "t1", parentId: "m1", thinkingLevel: null, configured: "auto" },
  ];
  assert.equal(buildSessionContext(parsed, "t1", { defaultThinkingLevel: "off" }).thinkingLevel, "auto");
});

