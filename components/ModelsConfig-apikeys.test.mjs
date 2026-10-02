// The "connect a provider" grid had two card kinds: OAuth ("Sign in") and API
// key ("Set Key"). The API-key half could never appear: /api/auth/all-providers
// derives its list from get_available_models — which omp documents as "models
// with valid API keys" — and then hardcodes `configured: true`, while the UI
// selected exactly the rows with `!configured`. So it was empty by construction
// on every install, not just a blank one, and "Set Key" led to a read-only
// status page that cannot store a key (the api-key route says so itself).
//
// The Sign in half was worse in a way this file also pins: its cards were dead
// on a fresh install because the login route spawned omp without `--model` and
// hit the zero-model guard before the flow began. That is fixed in the route;
// what the UI must not do is keep advertising a setup path that does not exist.
import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, render, screen } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ModelsConfig } = await jiti.import("./ModelsConfig.tsx");

beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
afterEach(cleanup);

const jsonResponse = (data) =>
  new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

const OAUTH_PROVIDERS = [
  { id: "anthropic", name: "Anthropic (Claude Pro/Max)", loggedIn: false },
  { id: "openrouter", name: "OpenRouter", loggedIn: false },
];

function mount({ apiKeyProviders = [] } = {}) {
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.startsWith("/api/auth/providers")) return jsonResponse({ providers: OAUTH_PROVIDERS });
    if (target.startsWith("/api/auth/all-providers")) return jsonResponse({ providers: apiKeyProviders });
    if (target.startsWith("/api/models-config")) {
      return jsonResponse({ providers: {}, models: [] });
    }
    if (target.startsWith("/api/models")) {
      return jsonResponse({ models: [], modelList: [], defaultModel: null, connectedProviders: [] });
    }
    return jsonResponse({});
  };
  render(
    React.createElement(ModelsConfig, {
      cwd: "/tmp/omp-web-test-project",
      embedded: true,
      onModelsSaved() {},
      onPluginsReloaded() {},
    }),
  );
  return act(async () => { await new Promise((r) => setTimeout(r, 40)); });
}

test("there is no Set Key button: omp-web cannot store an API key from the browser", async () => {
  await mount();
  assert.equal(
    screen.queryAllByRole("button", { name: "Set Key" }).length,
    0,
    "a button that opens a read-only status page must not be offered",
  );
});

test("the grid explains where an API key actually has to be set", async () => {
  await mount();
  // The three real paths, all outside the browser: omp's own /login, the
  // provider's environment variable, or a custom provider in models.yml.
  const hint = screen.getAllByText(/models\.yml/i).length;
  assert.ok(hint > 0, "models.yml is named as a supported path");
});

test("a provider that only has an env var configured is listed as connected, not as setup", async () => {
  await mount({
    apiKeyProviders: [{ id: "deepseek", displayName: "DeepSeek", configured: true, modelCount: 2 }],
  });
  // Configured providers belong in the connected list; they must not also be
  // offered in the connect grid as if they still needed a key.
  assert.ok(screen.getAllByText("DeepSeek").length > 0);
  assert.equal(screen.queryAllByRole("button", { name: "Set Key" }).length, 0);
});

test("Sign in cards are offered for providers with no stored credential", async () => {
  await mount();
  const signIn = screen.getAllByRole("button", { name: "Sign in" });
  assert.equal(signIn.length, OAUTH_PROVIDERS.length, "every unlinked provider is actionable");
});