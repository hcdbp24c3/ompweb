// Provider-level editor controls added for omp's models.yml schema: model
// discovery (+ the Discover models flow), custom request headers, authHeader and
// disableStrictTools. Everything is driven through the real ModelsConfig tree
// because the only honest place to observe the result is the PUT
// /api/models-config body the editor finally writes.
import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react/pure.js";
import userEvent from "@testing-library/user-event";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ModelsConfig } = await jiti.import("./ModelsConfig.tsx");
const { discoveredToModelEntry } = await jiti.import("./ModelsConfig-types.ts");

// A successful save arms a 2s "Saved" lockout (`setTimeout` in handleSave). Left
// pending it fires after setup-dom.mjs's file-level teardown deleted `window`
// and fails the run with "window is not defined", so long timers are clamped to
// a delay that always expires inside the test. Everything else (React's
// scheduler, userEvent, waitFor) uses sub-100ms delays and is untouched.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (handler, timeout, ...args) =>
  realSetTimeout(handler, typeof timeout === "number" && timeout > 500 ? 5 : timeout, ...args);
/** Lets any clamped timer (and the microtask queue) settle. */
const settle = () => act(async () => { await new Promise((resolve) => realSetTimeout(resolve, 20)); });

const BASE_PROVIDER = {
  baseUrl: "http://127.0.0.1:8000/v1",
  api: "openai-completions",
  auth: "none",
};

beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
afterEach(cleanup);

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

/** A stand-in for ~/.omp/agent/models.yml: GET reads it, PUT replaces the
 *  provider. Without it a save would reload the pristine fixture and every
 *  multi-step edit would silently vanish. */
function editor(t, { provider = BASE_PROVIDER, discover } = {}) {
  const file = { provider: JSON.parse(JSON.stringify(provider)) };
  const saved = [];
  const discoverCalls = [];

  t.mock.method(globalThis, "fetch", async (url, init) => {
    const target = String(url);
    const method = init?.method ?? "GET";
    if (target === "/api/models-config" && method === "PUT") {
      const body = JSON.parse(init.body);
      saved.push(body);
      file.provider = JSON.parse(JSON.stringify(body.providers.lab));
      return jsonResponse({ success: true });
    }
    if (target === "/api/models-config/discover") {
      discoverCalls.push(JSON.parse(init.body));
      return typeof discover === "function" ? discover() : jsonResponse(discover ?? { ok: true, models: [], latencyMs: 5 });
    }
    if (target === "/api/models-config") return jsonResponse({ providers: { lab: file.provider } });
    if (target === "/api/auth/providers") return jsonResponse({ providers: [] });
    if (target === "/api/auth/all-providers") return jsonResponse({ providers: [] });
    if (target === "/api/models") return jsonResponse({ modelList: [], connectedProviders: [] });
    return jsonResponse({ error: "not found" }, 404);
  });

  const open = async () => {
    const view = render(React.createElement(ModelsConfig, { onClose: () => {}, embedded: true }));
    await act(async () => { screen.getByText("Custom providers").click(); });
    await act(async () => { screen.getByRole("button", { name: "Edit" }).click(); });
    return view;
  };

  /** Saves and returns the provider entry exactly as it reached the wire.
   *  `reopen` is the editor's own post-save reload, so a test that edits twice
   *  must call it (a fresh mount also clears the "Saved" lockout). */
  const save = async () => {
    const before = saved.length;
    await act(async () => { screen.getByRole("button", { name: "Save" }).click(); });
    await waitFor(() => assert.ok(saved.length > before, "the PUT never fired"));
    await settle();
    return saved.at(-1).providers.lab;
  };

  const reopen = async () => { cleanup(); await open(); await settle(); };

  return { open, save, reopen, saved, discoverCalls };
}

const openProvider = async (t, options) => { await editor(t, options).open(); };

test("the discovery source select offers every omp discovery type and clears the block", async (t) => {
  const user = userEvent.setup();
  const { open, save, reopen } = await editor(t, { provider: BASE_PROVIDER });
  await open();

  const select = screen.getByLabelText("Source");
  assert.deepEqual(
    [...select.options].map((option) => option.value),
    ["", "ollama", "llama.cpp", "lm-studio", "openai-models-list", "proxy", "litellm", "apple-foundation-models"],
    "all 7 omp discovery types plus the \"no discovery\" placeholder",
  );
  assert.equal(select.value, "");

  await user.selectOptions(select, "openai-models-list");
  assert.deepEqual((await save()).discovery, { type: "openai-models-list" });

  await reopen();
  await user.selectOptions(screen.getByLabelText("Source"), "");
  const cleared = await save();
  assert.equal(cleared.discovery, undefined, "the placeholder drops the block instead of writing discovery: {}");
});

test("discovery sub-controls stay hidden until a type is picked and injectV1 is openai-only", async (t) => {
  const user = userEvent.setup();
  await openProvider(t, { provider: BASE_PROVIDER });

  assert.equal(screen.queryByLabelText("Timeout (ms)"), null);
  assert.equal(screen.queryByLabelText("Append /v1 to the model list URL"), null);

  await user.selectOptions(screen.getByLabelText("Source"), "ollama");
  assert.ok(screen.getByLabelText("Timeout (ms)"), "the timeout is shown once a type exists");
  assert.equal(screen.queryByLabelText("Append /v1 to the model list URL"), null, "injectV1 is openai-models-list only");

  await user.selectOptions(screen.getByLabelText("Source"), "openai-models-list");
  assert.equal(screen.getByLabelText("Append /v1 to the model list URL").checked, true, "omp defaults injectV1 to true");
});

test("injectV1 round-trips and is dropped when the type stops being openai-models-list", async (t) => {
  const user = userEvent.setup();
  const { open, save, reopen } = await editor(t, {
    provider: { ...BASE_PROVIDER, discovery: { type: "openai-models-list", injectV1: true } },
  });
  await open();

  const inject = screen.getByLabelText("Append /v1 to the model list URL");
  assert.equal(inject.checked, true);
  await user.click(inject);
  assert.deepEqual((await save()).discovery, { type: "openai-models-list", injectV1: false });

  await reopen();
  await user.selectOptions(screen.getByLabelText("Source"), "ollama");
  assert.deepEqual(
    (await save()).discovery,
    { type: "ollama" },
    "injectV1 is schema-rejected outside openai-models-list, so it must not survive the switch",
  );
});

test("a non-positive discovery timeout is reported and never written", async (t) => {
  const user = userEvent.setup();
  const { open, save, reopen } = await editor(t, { provider: BASE_PROVIDER });
  await open();

  await user.selectOptions(screen.getByLabelText("Source"), "ollama");
  const timeout = screen.getByLabelText("Timeout (ms)");
  await user.type(timeout, "0");
  await act(async () => { timeout.blur(); });

  assert.match(screen.getByRole("alert").textContent, /positive number/);
  assert.deepEqual(
    (await save()).discovery,
    { type: "ollama" },
    "the invalid timeout stays out of models.yml instead of relying on the server to reject it",
  );

  await reopen();
  await user.type(screen.getByLabelText("Timeout (ms)"), "2500");
  assert.deepEqual((await save()).discovery, { type: "ollama", timeoutMs: 2500 });
});

test("Discover models asks the provider endpoint and appends the ticked models", async (t) => {
  const user = userEvent.setup();
  const { open, save, discoverCalls } = await editor(t, {
    provider: { ...BASE_PROVIDER, discovery: { type: "openai-models-list" } },
    discover: () => jsonResponse({
      ok: true,
      latencyMs: 12,
      models: [
        { id: "qwen3-coder", name: "Qwen3 Coder", reasoning: true, contextWindow: 262144, maxTokens: 8192 },
        { id: "llama-3.3", name: "Llama 3.3", contextWindow: null, maxTokens: null },
      ],
    }),
  });
  await open();

  await user.click(screen.getByRole("button", { name: "Discover models" }));
  assert.deepEqual(discoverCalls, [{
    providerName: "lab",
    provider: { ...BASE_PROVIDER, discovery: { type: "openai-models-list" } },
  }], "the provider is posted as-is, at provider level (no model)");

  assert.equal(screen.getByText("2 models found").textContent, "2 models found");
  const ticks = screen.getAllByRole("checkbox", { name: /^(qwen3-coder|llama-3.3)$/ });
  assert.equal(ticks.length, 2);
  assert.equal(ticks[0].checked, true, "discovered models start ticked");
  await user.click(ticks[1]);

  await user.click(screen.getByRole("button", { name: "Add selected" }));
  assert.deepEqual(
    (await save()).models,
    [{ id: "qwen3-coder", name: "Qwen3 Coder", reasoning: true, contextWindow: 262144, maxTokens: 8192 }],
    "only the ticked model is written, and the unreported limits of the other one never reach the file",
  );
});

test("the first appended discovered model is the one that opens", async (t) => {
  const user = userEvent.setup();
  await openProvider(t, {
    provider: { ...BASE_PROVIDER, models: [{ id: "existing" }], discovery: { type: "ollama" } },
    discover: () => jsonResponse({ ok: true, models: [{ id: "a" }, { id: "b" }], latencyMs: 3 }),
  });

  await user.click(screen.getByRole("button", { name: "Discover models" }));
  await user.click(screen.getByRole("button", { name: "Add selected" }));
  assert.equal(screen.getByLabelText(/^ID/).value, "a", "addDiscoveredModels selects the first new entry, not the last");
});

test("a discovery failure surfaces the localized error and stays retryable", async (t) => {
  const user = userEvent.setup();
  await openProvider(t, {
    provider: { ...BASE_PROVIDER, discovery: { type: "openai-models-list" } },
    discover: () => jsonResponse({ ok: false, error: "connection refused", code: "discover_failed" }, 500),
  });

  await user.click(screen.getByRole("button", { name: "Discover models" }));
  assert.equal(screen.queryByRole("button", { name: "Add selected" }), null);
  assert.match(document.body.textContent, /Could not reach the model server/);
  assert.equal(screen.getByRole("button", { name: "Discover models" }).disabled, false, "the button is retryable");
});

test("an empty discovery result is a valid answer, not a failure", async (t) => {
  const user = userEvent.setup();
  await openProvider(t, {
    provider: { ...BASE_PROVIDER, discovery: { type: "ollama" } },
    discover: () => jsonResponse({ ok: true, models: [], latencyMs: 4 }),
  });

  await user.click(screen.getByRole("button", { name: "Discover models" }));
  assert.match(document.body.textContent, /did not report any models/);
  assert.equal(screen.queryByRole("button", { name: "Add selected" }), null);
});

test("an empty discovery that carries a reason names the server that was asked", async (t) => {
  const user = userEvent.setup();
  await openProvider(t, {
    provider: { ...BASE_PROVIDER, discovery: { type: "openai-models-list" } },
    discover: () => jsonResponse({
      ok: true,
      models: [],
      reason: "discovery_returned_nothing",
      baseUrl: "http://127.0.0.1:8000/v1",
    }),
  });

  await user.click(screen.getByRole("button", { name: "Discover models" }));

  const body = document.body.textContent;
  assert.doesNotMatch(
    body,
    /did not report any models/,
    "the generic empty-list line is the wrong explanation when the server was asked and answered",
  );
  assert.match(body, /found no models/);
  assert.match(body, /127\.0\.0\.1:8000\/v1/, "the url omp actually asked is named");
});

test("an empty discovery with no baseUrl to name still explains itself", async (t) => {
  const user = userEvent.setup();
  await openProvider(t, {
    provider: { ...BASE_PROVIDER, discovery: { type: "ollama" } },
    // A provider can legitimately have no baseUrl (omp's own default endpoint),
    // so the sentence must not degrade into an empty code span.
    discover: () => jsonResponse({ ok: true, models: [], reason: "discovery_returned_nothing" }),
  });

  await user.click(screen.getByRole("button", { name: "Discover models" }));

  const body = document.body.textContent;
  assert.match(body, /found no models/);
  assert.match(body, /the configured server/);
  assert.doesNotMatch(body, /``/, "an unknown url must not leave an empty interpolation behind");
});

test("a discovered model is not printed twice when its name is its id", async (t) => {
  const user = userEvent.setup();
  await openProvider(t, {
    provider: { ...BASE_PROVIDER, discovery: { type: "ollama" } },
    discover: () => jsonResponse({
      ok: true,
      latencyMs: 3,
      models: [{ id: "qwen3-coder" }, { id: "llama-3.3", name: "Llama 3.3" }],
    }),
  });

  await user.click(screen.getByRole("button", { name: "Discover models" }));

  /** The row is a <label> wrapping the tick, the label and the id, so the
   *  checkbox's own aria-label is not enough to judge what was rendered. */
  const rowText = (id) => screen.getByLabelText(id).closest("label").textContent;
  assert.equal(rowText("qwen3-coder").match(/qwen3-coder/g).length, 1, "an unnamed model shows its id once");
  assert.match(rowText("llama-3.3"), /Llama 3\.3/, "a named model still shows its name");
  assert.match(rowText("llama-3.3"), /llama-3\.3/, "…and its id, which is not the name");
});

test("the headers editor writes, renames and removes key/value pairs", async (t) => {
  const user = userEvent.setup();
  const { open, save, reopen } = await editor(t, { provider: BASE_PROVIDER });
  await open();

  await user.click(screen.getByRole("button", { name: "+ Header" }));
  await user.type(screen.getByLabelText("Header 1"), "X-Team");
  await user.type(screen.getByLabelText("Value 1"), "platform");
  await user.click(screen.getByRole("button", { name: "+ Header" }));
  await user.type(screen.getByLabelText("Header 2"), "X-Trace");
  await user.type(screen.getByLabelText("Value 2"), "1");
  assert.deepEqual((await save()).headers, { "X-Team": "platform", "X-Trace": "1" });

  await reopen();
  await user.clear(screen.getByLabelText("Header 1"));
  await user.type(screen.getByLabelText("Header 1"), "X-Org");
  assert.deepEqual((await save()).headers, { "X-Org": "platform", "X-Trace": "1" }, "a rename re-keys the pair");

  await reopen();
  await user.click(screen.getByRole("button", { name: "Remove header X-Trace" }));
  assert.deepEqual((await save()).headers, { "X-Org": "platform" });

  await reopen();
  await user.click(screen.getByRole("button", { name: "Remove header X-Org" }));
  assert.equal((await save()).headers, undefined, "removing the last pair drops the key entirely");
});

test("a header row with no name yet is not written to the file", async (t) => {
  const user = userEvent.setup();
  const { open, save } = await editor(t, { provider: BASE_PROVIDER });
  await open();

  await user.click(screen.getByRole("button", { name: "+ Header" }));
  await user.type(screen.getByLabelText("Value 1"), "platform");
  assert.equal((await save()).headers, undefined, "a nameless row is still a draft, not a header");
});

test("authHeader appears only once an apiKey is set, and follows the key", async (t) => {
  const user = userEvent.setup();
  const { open, save, reopen } = await editor(t, { provider: { baseUrl: BASE_PROVIDER.baseUrl, api: BASE_PROVIDER.api } });
  await open();

  assert.equal(screen.queryByLabelText(/Authorization: Bearer/), null, "no key, no authHeader control");

  await user.type(screen.getByLabelText(/API Key/), "sk-test");
  const authHeader = screen.getByLabelText(/Authorization: Bearer/);
  assert.equal(authHeader.checked, false, "omp treats authHeader as opt-in");
  await user.click(authHeader);
  const written = await save();
  assert.equal(written.apiKey, "sk-test");
  assert.equal(written.authHeader, true);

  await reopen();
  await user.clear(screen.getByLabelText(/API Key/));
  assert.equal(screen.queryByLabelText(/Authorization: Bearer/), null, "clearing the key hides the control");
  assert.equal((await save()).authHeader, undefined, "and clears the flag rather than stranding it");
});

test("disableStrictTools is offered only for anthropic-messages providers", async (t) => {
  const user = userEvent.setup();
  const { open, save, reopen } = await editor(t, { provider: BASE_PROVIDER });
  await open();

  assert.equal(screen.queryByLabelText(/strict tool schema/), null, "not an anthropic provider yet");
  await user.selectOptions(screen.getByLabelText("API"), "anthropic-messages");
  await user.click(screen.getByLabelText(/strict tool schema/));
  const written = await save();
  assert.equal(written.api, "anthropic-messages");
  assert.equal(written.disableStrictTools, true);

  await reopen();
  await user.selectOptions(screen.getByLabelText("API"), "openai-completions");
  assert.equal(screen.queryByLabelText(/strict tool schema/), null, "the control follows the api choice");
  assert.equal((await save()).disableStrictTools, undefined, "and switching api away clears the flag");
});

test("changing the endpoint discards a result set fetched from the old one", async (t) => {
  const user = userEvent.setup();
  await openProvider(t, {
    provider: { ...BASE_PROVIDER, discovery: { type: "ollama" } },
    discover: () => jsonResponse({ ok: true, models: [{ id: "a" }], latencyMs: 3 }),
  });

  await user.click(screen.getByRole("button", { name: "Discover models" }));
  assert.ok(screen.getByRole("checkbox", { name: "a" }));

  await user.clear(screen.getByLabelText("Base URL"));
  await user.type(screen.getByLabelText("Base URL"), "http://127.0.0.1:9000/v1");
  assert.equal(
    screen.queryByRole("checkbox", { name: "a" }),
    null,
    "a model list fetched from the previous endpoint must not stay tickable",
  );
});

test("discoveredToModelEntry drops the nulls the endpoint can return", () => {
  assert.deepEqual(discoveredToModelEntry({ id: "a", contextWindow: null, maxTokens: null }), {
    id: "a",
    name: undefined,
    reasoning: undefined,
    thinking: undefined,
    input: undefined,
    contextWindow: undefined,
    maxTokens: undefined,
    cost: undefined,
  });
});
