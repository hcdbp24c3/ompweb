// "Extensions & Tools" advertises "MCP servers, managed skills, and OMP
// plugins", but it rendered McpConfig alone: the skills and plugins panels were
// mounted behind `currentTab === "skills"` / `"plugins"`, and
// getNormalizedActive() folded both onto "mcp", so neither condition could ever
// be true. PluginsConfig had a complete install flow no user could reach.
// These tests pin the three sub-panels and that the tab strip is untouched.
import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, render, screen } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { SettingsConfig } = await jiti.import("./SettingsConfig.tsx");
const { getNormalizedActive } = await jiti.import("./SettingsTabs.tsx");

beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
afterEach(cleanup);

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

/** SettingsConfig is fully controlled, so the mcp tab is entered by passing
 *  activeTab rather than by clicking the strip. Every endpoint the panels hit
 *  answers; anything else 404s, which is enough because only one panel is on
 *  screen at a time. */
function mockEndpoints() {
  globalThis.fetch = async (url) => {
    const target = String(url);
    // Matched by prefix: PluginsConfig requests `/api/plugins?cwd=…`, and the
    // query string is the difference between a served panel and a 404 screen.
    if (target.startsWith("/api/plugins")) {
      return jsonResponse({ packages: [], totals: { npm: 0, marketplace: 0, local: 0 }, diagnostics: [] });
    }
    if (target.startsWith("/api/skills")) return jsonResponse({ skills: [], matches: [], results: [] });
    if (target.startsWith("/api/mcp")) return jsonResponse({ servers: [], user: null });
    if (target.startsWith("/api/omp-settings")) return jsonResponse({ settings: {} });
    return jsonResponse({ error: "not found" }, 404);
  };
}

const PROPS = {
  activeTab: "mcp",
  toolCallsDefaultCollapsed: false,
  onToolCallsDefaultCollapsedChange() {},
  onHideThinkingBlockChange() {},
  providerUsageVisible: true,
  onProviderUsageVisibleChange() {},
  scopeNativeSelectAll: false,
  onScopeNativeSelectAllChange() {},
  openUrlAutomatically: true,
  onOpenUrlAutomaticallyChange() {},
  cwd: "/tmp/omp-web-test-project",
  sessionId: "sess-1",
  onModelsSaved() {},
  onPluginsReloaded() {},
  appUpdate: null,
  ompUpdatesDisabled: false,
  onRefreshAppUpdate: async () => null,
  onOmpUpdateAvailabilityChange() {},
  onRequestAppUpdate() {},
  onSelectTab() {},
  onClose() {},
};

async function mountExtensionsTab() {
  mockEndpoints();
  render(React.createElement(SettingsConfig, PROPS));
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
}

const subPanel = (name) => screen.getByRole("button", { name });

test("Extensions & Tools offers the three sub-panels the tab advertises", async () => {
  await mountExtensionsTab();

  for (const name of ["MCP servers", "Skills", "Plugins"]) {
    assert.ok(subPanel(name), `"${name}" is reachable`);
  }
});

test("MCP is the default sub-panel", async () => {
  await mountExtensionsTab();

  const active = screen.getAllByRole("button").filter((b) => b.className.includes("active"));
  assert.equal(active.length, 1, "exactly one sub-panel is active");
  assert.match(active[0].textContent, /MCP servers/i);
});

test("clicking Plugins mounts the plugin panel with its install control", async () => {
  await mountExtensionsTab();

  await act(async () => { subPanel("Plugins").click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });

  // The whole point of the change: an empty plugin list auto-opens the add
  // panel, which is where "npm:@scope/pkg", git URLs and local paths get
  // installed. Matched on the placeholder because the accessible name is the
  // generic "Source".
  const input = await screen.findByPlaceholderText("npm:@scope/package", {}, { timeout: 4000 });
  assert.ok(input, "the plugin source input is reachable once Plugins is selected");
  assert.ok(
    screen.getByRole("button", { name: "Install" }),
    "and so is the install action that runs `omp plugin install`",
  );
});

test("clicking Skills makes it the active sub-panel", async () => {
  await mountExtensionsTab();
  assert.match(subPanel("MCP servers").className, /active/, "MCP starts active");

  await act(async () => { subPanel("Skills").click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });

  assert.match(subPanel("Skills").className, /active/, "Skills takes over");
  assert.doesNotMatch(subPanel("MCP servers").className, /active/, "and MCP releases it");
});

test("getNormalizedActive no longer folds skills/plugins onto the mcp tab", () => {
  assert.equal(getNormalizedActive("plugins"), "plugins");
  assert.equal(getNormalizedActive("skills"), "skills");
  // The legacy alias still resolves, so an old deep link keeps working.
  assert.equal(getNormalizedActive("extensions"), "mcp");
});

test("the dead conditional panels are gone from the source", () => {
  const source = readFileSync(new URL("./SettingsConfig.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /currentTab === "(plugins|skills)"/,
    "the old unreachable branches would double-mount the panels",
  );
});

test("the tab strip itself is unchanged — still 9 categories, no new entries", () => {
  const source = readFileSync(new URL("./SettingsTabs.tsx", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("SETTINGS_CATEGORIES"), source.indexOf("export const getNormalizedActive"));
  const ids = [...block.matchAll(/id: "([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, [
    "general", "safety", "models", "providers", "usage",
    "intelligence", "agents", "mcp", "system",
  ], "the sub-panels live inside 'Extensions & Tools', they do not become tabs");
});
