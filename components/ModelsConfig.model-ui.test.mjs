// Model-level editor controls added for omp's models.yml schema (per-model
// baseUrl override, tokenizer, maxContextWindow, omitMaxOutputTokens,
// supportsTools, premiumMultiplier) plus the ThinkingEditor data-loss fix and
// its two new selects. Driven through the real ModelsConfig tree because the
// only honest place to observe the result is the PUT /api/models-config body
// the editor finally writes.
import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react/pure.js";
import userEvent from "@testing-library/user-event";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ModelsConfig } = await jiti.import("./ModelsConfig.tsx");
// Same module instance ModelsConfig.tsx resolves through `@/…`, so patching the
// exported object's method is enough to observe what the editor reports.
const { toast } = await jiti.import("@/components/ui/toast");

// A successful save arms a 2s "Saved" lockout (`setTimeout` in handleSave). Left
// pending it fires after setup-dom.mjs's file-level teardown deleted `window`
// and fails the run with "window is not defined", so long timers are clamped to
// a delay that always expires inside the test.
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
const BASE_MODEL = { id: "qwen3-coder", reasoning: true, contextWindow: 262144 };

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
function editor(t, { model = BASE_MODEL } = {}) {
  const file = { provider: { ...BASE_PROVIDER, models: [JSON.parse(JSON.stringify(model))] } };
  const saved = [];

  t.mock.method(globalThis, "fetch", async (url, init) => {
    const target = String(url);
    const method = init?.method ?? "GET";
    if (target === "/api/models-config" && method === "PUT") {
      const body = JSON.parse(init.body);
      saved.push(body);
      file.provider = JSON.parse(JSON.stringify(body.providers.lab));
      return jsonResponse({ success: true });
    }
    if (target === "/api/models-config") return jsonResponse({ providers: { lab: file.provider } });
    if (target === "/api/auth/providers") return jsonResponse({ providers: [] });
    if (target === "/api/auth/all-providers") return jsonResponse({ providers: [] });
    if (target === "/api/models") return jsonResponse({ modelList: [], connectedProviders: [] });
    return jsonResponse({ error: "not found" }, 404);
  });

  /** Opens the model detail straight from the provider card's model chip. The
   *  chip's accessible name also carries the reasoning "T" badge, so it is
   *  reached through its own id text rather than by role name. */
  const open = async () => {
    render(React.createElement(ModelsConfig, { onClose: () => {}, embedded: true }));
    await act(async () => { screen.getByText("Custom providers").click(); });
    await act(async () => { screen.getByText(model.id).closest("button").click(); });
    await settle();
  };

  /** Saves and returns the model entry exactly as it reached the wire.
   *  `reopen` is the editor's own post-save reload, so a test that edits twice
   *  must call it (a fresh mount also clears the "Saved" lockout). */
  const save = async () => {
    const before = saved.length;
    await act(async () => { screen.getByRole("button", { name: "Save" }).click(); });
    await waitFor(() => assert.ok(saved.length > before, "the PUT never fired"));
    await settle();
    return saved.at(-1).providers.lab.models[0];
  };

  const reopen = async () => { cleanup(); await open(); await settle(); };

  return { open, save, reopen, saved };
}

/** One level row of the thinking ladder, as a scope for its buttons. */
const levelRow = (level) => screen.getByRole("group", { name: level });
const levelButton = (level, name) => within(levelRow(level)).getByRole("button", { name });

test("an effort omp-web has no name for survives an unrelated edit", async (t) => {
  const user = userEvent.setup();
  const { open, save } = await editor(t, {
    model: { ...BASE_MODEL, thinking: { efforts: ["low", "medium", "ultra"] } },
  });
  await open();

  assert.ok(levelRow("ultra"), "an unknown effort must be a visible row, not invisible and doomed");
  await user.click(levelButton("high", "Default"));

  assert.deepEqual(
    (await save()).thinking,
    { mode: "effort", efforts: ["low", "medium", "high", "ultra"] },
    "enabling one known level must not delete the hand-written effort next to it",
  );
});

test("an unknown effort keeps its own wire value and can be disabled", async (t) => {
  const user = userEvent.setup();
  const { open, save } = await editor(t, {
    model: { ...BASE_MODEL, thinking: { efforts: ["low", "ultra"], effortMap: { ultra: "ULTRA" } } },
  });
  await open();

  assert.equal(within(levelRow("ultra")).getByRole("textbox").value, "ULTRA");
  await user.click(levelButton("ultra", "Disabled"));
  assert.deepEqual(
    (await save()).thinking,
    { mode: "effort", efforts: ["low"] },
    "disabling removes the effort and its wire value together",
  );
});

test("every known level is still offered when the file pins a short ladder", async (t) => {
  await editor(t, { model: { ...BASE_MODEL, thinking: { efforts: ["high"] } } }).open();

  for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.ok(levelRow(level), `${level} must stay toggleable so a disabled level can be re-enabled`);
  }
});

test("a ladder holding an unknown effort is not mistaken for the auto-derived one", async (t) => {
  const user = userEvent.setup();
  // Six rows, all Default, no wire overrides — exactly the shape "reset to auto"
  // looks for, except that one of them is a level the editor has no name for.
  const { open, save } = await editor(t, {
    model: { ...BASE_MODEL, thinking: { mode: "effort", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] } },
  });
  await open();

  await user.click(levelButton("low", "Default"));
  assert.deepEqual(
    (await save()).thinking,
    { mode: "effort", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    "re-picking an unchanged default must not wipe the block, because auto-derivation would lose ultra",
  );
});

test("the thinking mode select offers omp's five modes and never invents one", async (t) => {
  const user = userEvent.setup();
  const { open, save, reopen } = await editor(t, {
    model: { ...BASE_MODEL, thinking: { efforts: ["low", "high"] } },
  });
  await open();

  const mode = screen.getByLabelText("Mode");
  assert.deepEqual(
    [...mode.options].map((option) => option.value),
    ["", "effort", "budget", "google-level", "anthropic-adaptive", "anthropic-budget-effort"],
    "the placeholder plus every mode in omp's ModelThinkingSchema",
  );
  assert.equal(mode.value, "", "an unpinned mode stays unpinned");

  await user.selectOptions(mode, "anthropic-adaptive");
  assert.equal((await save()).thinking.mode, "anthropic-adaptive");

  await reopen();
  await user.selectOptions(screen.getByLabelText("Mode"), "");
  assert.equal((await save()).thinking.mode, undefined, "the placeholder drops the key instead of writing a guess");
});

test("editing a level never changes the mode the file already pins", async (t) => {
  const user = userEvent.setup();
  const { open, save } = await editor(t, {
    model: { ...BASE_MODEL, thinking: { mode: "google-level", efforts: ["low", "high"] } },
  });
  await open();

  await user.click(levelButton("high", "Disabled"));
  const thinking = (await save()).thinking;
  assert.equal(thinking.mode, "google-level", "a level toggle must not fall back to omp's own default");
  assert.deepEqual(thinking.efforts, ["low"]);
});

test("the default level select is built from the efforts the file already enables", async (t) => {
  const user = userEvent.setup();
  const { open, save, reopen } = await editor(t, {
    model: { ...BASE_MODEL, thinking: { efforts: ["low", "medium", "ultra"] } },
  });
  await open();

  const level = screen.getByLabelText("Default level");
  assert.deepEqual(
    [...level.options].map((option) => option.value),
    ["", "low", "medium", "ultra"],
    "only an enabled effort can be the default, and the unknown one is listed too",
  );

  await user.selectOptions(level, "ultra");
  assert.equal((await save()).thinking.defaultLevel, "ultra");

  await reopen();
  await user.selectOptions(screen.getByLabelText("Default level"), "");
  assert.equal((await save()).thinking.defaultLevel, undefined);
});

test("with no explicit ladder there is no level to pin as the default", async (t) => {
  await editor(t, { model: { ...BASE_MODEL, thinking: { mode: "effort" } } }).open();

  assert.deepEqual(
    [...screen.getByLabelText("Default level").options].map((option) => option.value),
    [""],
    "omp derives the ladder itself here, so no effort is enabled for a default to point at",
  );
});

// omp's `clampThinkingLevelForModel` silently snaps a `defaultLevel` that is no
// longer in `efforts` down to the nearest one it knows — `defaultLevel: max` over
// `efforts: [low, high]` runs as `high` with no warning. A value that quietly
// disagrees with itself is worse than no value, so disabling the level the
// default names drops the default with it and says so.

/** Captures what the editor reports through the shared toast module. */
function captureToasts(t) {
  const calls = [];
  t.mock.method(toast, "info", (title, description) => { calls.push({ title: String(title), description }); });
  return calls;
}

test("disabling the level the default names drops the default with it", async (t) => {
  const user = userEvent.setup();
  const toasts = captureToasts(t);
  const { open, save } = await editor(t, {
    model: {
      ...BASE_MODEL,
      thinking: { mode: "effort", efforts: ["low", "high"], defaultLevel: "high", effortMap: { low: "LOW" } },
    },
  });
  await open();

  await user.click(levelButton("high", "Disabled"));
  const thinking = (await save()).thinking;

  assert.deepEqual(thinking.efforts, ["low"], "the disabled level leaves the ladder");
  assert.equal(
    thinking.defaultLevel,
    undefined,
    "a defaultLevel outside efforts is silently clamped by omp, so it must not survive the edit",
  );
  assert.equal(thinking.mode, "effort", "clearing the default must not disturb the mode");
  assert.deepEqual(thinking.effortMap, { low: "LOW" }, "clearing the default must not disturb the wire overrides");

  assert.equal(toasts.length, 1, `the user has to be told, saw ${JSON.stringify(toasts)}`);
  assert.match(toasts[0].title + (toasts[0].description ?? ""), /high/);
});

test("disabling a level the default does not name leaves the default alone", async (t) => {
  const user = userEvent.setup();
  const toasts = captureToasts(t);
  const { open, save } = await editor(t, {
    model: { ...BASE_MODEL, thinking: { mode: "effort", efforts: ["low", "high"], defaultLevel: "high" } },
  });
  await open();

  await user.click(levelButton("low", "Disabled"));
  const thinking = (await save()).thinking;

  assert.deepEqual(thinking.efforts, ["high"]);
  assert.equal(
    thinking.defaultLevel,
    "high",
    "the default still names an enabled level, so there is nothing to clear",
  );
  assert.deepEqual(toasts, [], "a routine edit must not cry wolf about a default it did not touch");
});

test("with no default level, disabling the last level leaves no thinking block behind", async (t) => {
  const user = userEvent.setup();
  captureToasts(t);
  const { open, save } = await editor(t, {
    model: { ...BASE_MODEL, thinking: { mode: "effort", efforts: ["high"] } },
  });
  await open();

  await user.click(levelButton("high", "Disabled"));
  assert.equal(
    (await save()).thinking,
    undefined,
    "an empty ladder is not a thinking config; the whole block goes",
  );
});

test("disabling the only enabled level, which was the default, still reports the cleared default", async (t) => {
  const user = userEvent.setup();
  const toasts = captureToasts(t);
  const { open, save } = await editor(t, {
    model: { ...BASE_MODEL, thinking: { mode: "effort", efforts: ["high"], defaultLevel: "high" } },
  });
  await open();

  await user.click(levelButton("high", "Disabled"));
  assert.equal((await save()).thinking, undefined, "an empty ladder is not a thinking config");
  assert.equal(
    toasts.length,
    1,
    "the block is wiped wholesale here, which drops the default just as silently as the surgical path",
  );
});

test("maxContextWindow round-trips and the invalid range is never written", async (t) => {
  const user = userEvent.setup();
  const { open, save, reopen } = await editor(t);
  await open();

  const maxContext = screen.getByLabelText("Max context window (tokens)");
  await user.type(maxContext, "1000000");
  assert.equal((await save()).maxContextWindow, 1000000);

  await reopen();
  const capped = screen.getByLabelText("Max context window (tokens)");
  await user.clear(capped);
  await user.type(capped, "1024");
  await act(async () => { capped.blur(); });
  assert.match(screen.getByRole("alert").textContent, /no smaller than the context window/);
  assert.equal(
    (await save()).maxContextWindow,
    undefined,
    "a cap below contextWindow stays out of models.yml instead of relying on the server to reject it",
  );
});

test("a maxContextWindow that is not a safe integer is reported and dropped", async (t) => {
  const { open, save } = await editor(t);
  await open();

  // 1e300 is above contextWindow and finite, so only the safe-integer rule can
  // reject it. It cannot be typed into a number input, so it arrives the way a
  // stale draft or a paste would.
  const maxContext = screen.getByLabelText("Max context window (tokens)");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(maxContext, "1e300");
    maxContext.dispatchEvent(new window.Event("input", { bubbles: true }));
    maxContext.focus();
  });
  await act(async () => { maxContext.blur(); });
  assert.match(screen.getByRole("alert").textContent, /positive whole number/);
  assert.equal((await save()).maxContextWindow, undefined);
});

test("omitMaxOutputTokens is opt-in and unchecking drops the key", async (t) => {
  const user = userEvent.setup();
  const { open, save, reopen } = await editor(t);
  await open();

  const omit = screen.getByLabelText(/provider set the output cap/);
  assert.equal(omit.checked, false, "omp reads the model's maxTokens unless this is set");
  await user.click(omit);
  assert.equal((await save()).omitMaxOutputTokens, true);

  await reopen();
  await user.click(screen.getByLabelText(/provider set the output cap/));
  assert.equal((await save()).omitMaxOutputTokens, undefined);
});

test("the capabilities group writes supportsTools and premiumMultiplier", async (t) => {
  const user = userEvent.setup();
  const { open, save, reopen } = await editor(t);
  await open();

  await user.click(screen.getByLabelText(/accepts tool calls/));
  await user.type(screen.getByLabelText("Premium multiplier"), "0.33");
  const written = await save();
  assert.equal(written.supportsTools, true);
  assert.equal(written.premiumMultiplier, 0.33);

  await reopen();
  await user.clear(screen.getByLabelText("Premium multiplier"));
  const cleared = await save();
  assert.equal(cleared.supportsTools, true, "clearing one field must not disturb the other");
  assert.equal(cleared.premiumMultiplier, undefined, "an empty box drops the key");

  await reopen();
  await user.click(screen.getByLabelText(/accepts tool calls/));
  assert.equal((await save()).supportsTools, undefined, "unchecking drops the key rather than writing false");
});

test("the tokenizer select offers every omp tokenizer and the placeholder inherits", async (t) => {
  const user = userEvent.setup();
  const { open, save, reopen } = await editor(t);
  await open();

  const tokenizer = screen.getByLabelText("Tokenizer");
  assert.deepEqual(
    [...tokenizer.options].map((option) => option.value),
    ["", "claude-v3", "claude-v47", "claude-v5", "claude-v5-sonnet", "qwen3", "deepseek-v3", "kimi-k2", "glm5"],
  );
  assert.equal(tokenizer.value, "", "inherited until the user picks one");

  await user.selectOptions(tokenizer, "qwen3");
  assert.equal((await save()).tokenizer, "qwen3");

  await reopen();
  await user.selectOptions(screen.getByLabelText("Tokenizer"), "");
  assert.equal((await save()).tokenizer, undefined);
});

test("a per-model base URL override round-trips and clears", async (t) => {
  const user = userEvent.setup();
  const { open, save, reopen } = await editor(t);
  await open();

  const baseUrl = screen.getByLabelText("Base URL override");
  await user.type(baseUrl, "https://api.example.com/v1");
  assert.equal((await save()).baseUrl, "https://api.example.com/v1");

  await reopen();
  await user.clear(screen.getByLabelText("Base URL override"));
  assert.equal((await save()).baseUrl, undefined, "an empty override hands the endpoint back to the provider");
});

test("editing one model field leaves the rest of the entry alone", async (t) => {
  const user = userEvent.setup();
  const { open, save } = await editor(t, {
    model: {
      ...BASE_MODEL,
      contextWindow: 262144,
      maxTokens: 8192,
      thinking: { mode: "effort", efforts: ["low", "ultra"], effortMap: { ultra: "ULTRA" }, defaultLevel: "ultra" },
    },
  });
  await open();

  await user.type(screen.getByLabelText("Max context window (tokens)"), "400000");
  const written = await save();
  assert.equal(written.maxContextWindow, 400000);
  assert.deepEqual(
    written.thinking,
    { mode: "effort", efforts: ["low", "ultra"], effortMap: { ultra: "ULTRA" }, defaultLevel: "ultra" },
    "a token-limit edit must not rewrite the thinking block or drop the effortMap",
  );
  assert.equal(written.maxTokens, 8192);
});
