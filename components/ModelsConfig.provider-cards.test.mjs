// The custom-provider cards show a provider's models two different ways, because
// they come from two different places:
//
//   - `providers[p].models[]` in ~/.omp/agent/models.yml — persisted, editable,
//     and rendered as chips. Clicking a chip opens the index-addressed model
//     editor, which writes back to that file.
//   - what omp resolved at runtime (`get_available_models`, via /api/models) —
//     not persisted anywhere, so a chip would be a lie: clicking it would address
//     a `models[]` entry that does not exist.
//
// Two behaviours are asserted here. First, the chip list is capped and
// expandable (a discovery-filled provider holds dozens of ids, and unbounded
// chips pushed the Save bar off the bottom of the scroll area). Second, the
// resolved models appear alongside the persisted ones as a flat, non-interactive
// list, and a provider with neither keeps a true empty state — which, before this
// list existed, was the only thing a `discovery:` provider ever showed even
// though the composer listed dozens of models for it.
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
const { ModelsConfig } = await jiti.import("./ModelsConfig.tsx");

/** Must match CHIPS_VISIBLE in ModelsConfig.tsx. */
const CHIPS_VISIBLE = 24;

const en = JSON.parse(readFileSync(new URL("../lib/i18n/locales/en.json", import.meta.url), "utf8"));
const RESOLVED_CAPTION = en["modelsConfig.resolvedModelsCaption"];
const NO_MODELS_COPY = en["modelsConfig.noModelsResolved"];

beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
afterEach(cleanup);

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

const manyModels = (count) =>
  Array.from({ length: count }, (_, i) => ({ id: `model-${String(i).padStart(2, "0")}` }));

const baseProvider = {
  baseUrl: "http://127.0.0.1:8000/v1",
  api: "openai-completions",
  auth: "none",
};

/** A provider that asks its server which models exist, so models.yml declares no
 *  `models:` list at all — the state that used to read as "no models defined". */
const discoveryProvider = { ...baseProvider, discovery: { type: "openai-models-list" } };

/** What `get_available_models` reports for one provider key. `provider` is the
 *  models.yml provider key verbatim (measured on omp 18.4.6), which is the only
 *  reason the client-side join below can work. */
const resolved = (ids) => ids.map((id) => ({ id, name: id, provider: "lab" }));

/** Mounts the editor on the custom-providers overview — the view where the cards
 *  are. `providers` is the models.yml payload, `modelList` the /api/models one. */
async function mount(t, providers, modelList = [], { holdModels = false } = {}) {
  let releaseModels;
  const held = holdModels ? new Promise((resolve) => { releaseModels = resolve; }) : null;
  t.mock.method(globalThis, "fetch", async (url) => {
    const target = String(url);
    if (target === "/api/models-config") return jsonResponse({ providers });
    if (target === "/api/auth/providers") return jsonResponse({ providers: [] });
    if (target === "/api/auth/all-providers") return jsonResponse({ providers: [] });
    if (target === "/api/models") {
      if (held) await held;
      return jsonResponse({ modelList, connectedProviders: [] });
    }
    return jsonResponse({ error: "not found" }, 404);
  });
  render(React.createElement(ModelsConfig, { onClose: () => {}, embedded: true }));
  await act(async () => { screen.getByText("Custom providers").click(); });
  return {
    async releaseModels() {
      await act(async () => { releaseModels(); await Promise.resolve(); });
    },
  };
}

/** The per-model chips, i.e. every button whose label is exactly a model id. */
const chipButtons = () =>
  screen.getAllByRole("button").filter((button) => /^model-\d\d$/.test(button.textContent.trim()));

const buttonsLabelled = (labels) =>
  screen.getAllByRole("button").filter((button) => labels.includes(button.textContent.trim()));

const moreButton = () =>
  screen.getAllByRole("button").find((button) => /^\+\d+ more$/.test(button.textContent.trim()));

/** The resolved (runtime) rows — marked by the component so they can be told
 *  apart from chips, which are buttons and these are not. */
const resolvedRows = () => Array.from(document.querySelectorAll("[data-model-source='resolved']"));

/** A single provider holding `count` persisted models and nothing resolved. */
const overview = (t, count) => mount(t, { lab: { ...baseProvider, models: manyModels(count) } });

test("a provider with many models shows a capped chip list and a +N more control", async (t) => {
  await overview(t, 30);

  assert.equal(chipButtons().length, CHIPS_VISIBLE, "the chip list is capped rather than wrapping forever");
  const more = moreButton();
  assert.ok(more, "the remainder is reachable through a +N more control");
  assert.equal(more.textContent.trim(), `+${30 - CHIPS_VISIBLE} more`);
});

test("+N more reveals the rest of the models and collapses again", async (t) => {
  await overview(t, 30);

  await act(async () => { moreButton().click(); });
  assert.equal(chipButtons().length, 30, "every model is reachable after expanding");
  assert.equal(moreButton(), undefined, "and the control retires when nothing is hidden");

  await act(async () => { screen.getAllByRole("button").find((b) => /^Show fewer/.test(b.textContent)).click(); });
  assert.equal(chipButtons().length, CHIPS_VISIBLE, "collapsing restores the cap");
});

test("a provider with few models is left exactly as it was", async (t) => {
  await overview(t, 5);

  assert.equal(chipButtons().length, 5, "nothing is hidden when the list already fits");
  assert.equal(moreButton(), undefined, "and no +N more control is offered");
});

test("a provider at exactly the cap gets no expander", async (t) => {
  await overview(t, CHIPS_VISIBLE);

  assert.equal(chipButtons().length, CHIPS_VISIBLE);
  assert.equal(moreButton(), undefined, "the control appears only when something is actually hidden");
});

test("the cap is per provider, so one long provider cannot hide another's", async (t) => {
  await mount(t, {
    lab: { ...baseProvider, models: manyModels(30) },
    small: { ...baseProvider, models: [{ id: "only-one" }] },
  });

  assert.ok(screen.getByRole("button", { name: "only-one" }), "the short provider is unaffected by the long one");
  assert.equal(chipButtons().length, CHIPS_VISIBLE, "only the long provider is capped");
});

test("Save is pinned to the bottom of the scroll area instead of scrolling away", async (t) => {
  await overview(t, 30);

  const save = screen.getByRole("button", { name: "Save" });
  const style = save.parentElement.parentElement.getAttribute("style") ?? "";
  assert.match(
    style,
    /position:\s*sticky/,
    "the Save bar must be sticky, otherwise a long provider still hides it below the fold",
  );
  assert.match(style, /bottom:\s*0/, "sticky to the bottom of the scroll container");
  // A sticky bar needs an opaque background or the rows scroll through it.
  assert.match(style, /background:\s*var\(--bg-panel\)/);
});

// ── Resolved (runtime) models ───────────────────────────────────────────────

test("a discovery provider with no models.yml list shows what omp resolved for it", async (t) => {
  await mount(t, { lab: discoveryProvider }, resolved(["zz-alpha", "zz-beta", "zz-gamma"]));

  assert.deepEqual(
    resolvedRows().map((row) => row.textContent.trim()),
    ["zz-alpha", "zz-beta", "zz-gamma"],
    "the resolved models are listed on the card, in registry order",
  );
  assert.ok(
    screen.queryByText(RESOLVED_CAPTION) !== null,
    "under a caption that says where they come from and that they are not persisted",
  );
  assert.equal(
    /No models/i.test(document.body.textContent ?? ""),
    false,
    "the empty state must not claim there are no models while omp reports three",
  );
});

test("a resolved row is a plain label, never an editable chip", async (t) => {
  await mount(t, { lab: discoveryProvider }, resolved(["zz-alpha", "zz-beta"]));

  assert.equal(resolvedRows().length, 2, "the models are on the card to begin with");
  // Every chip is a button that opens the index-addressed editor writing back to
  // models.yml. A resolved model has no such entry, so it must not be one.
  // Compared as text, not as nodes: assert.deepEqual on jsdom elements walks them
  // while building the failure message and kills the process.
  assert.deepEqual(
    buttonsLabelled(["zz-alpha", "zz-beta"]).map((button) => button.textContent.trim()),
    [],
    "resolved models are not clickable chips",
  );
  for (const row of resolvedRows()) {
    assert.equal(row.tagName, "LI", "the row is list content, not a control");
  }
});

test("persisted and resolved models are shown as two separate lists", async (t) => {
  await mount(t, { lab: { ...baseProvider, models: [{ id: "pinned-one" }] } }, resolved(["zz-a", "zz-b", "zz-c"]));

  assert.equal(buttonsLabelled(["pinned-one"]).length, 1, "the persisted model keeps its chip");
  assert.equal(resolvedRows().length, 3, "and the resolved ones are listed beside it, not folded into it");
  assert.equal(moreButton(), undefined, "one persisted model needs no expander");
});

test("+N more counts persisted models only — resolved ones do not inflate it", async (t) => {
  await mount(t, { lab: { ...baseProvider, models: manyModels(CHIPS_VISIBLE + 2) } }, resolved(["zz-a", "zz-b", "zz-c"]));

  assert.equal(chipButtons().length, CHIPS_VISIBLE);
  assert.equal(
    moreButton().textContent.trim(),
    `+2 more`,
    "the chip cap counts models.yml entries, so three resolved models cannot hide one of them",
  );
  assert.equal(resolvedRows().length, 3, "and the resolved list is not itself capped by CHIPS_VISIBLE");
});

test("a provider with neither persisted nor resolved models keeps the empty state", async (t) => {
  await mount(t, { lab: { ...baseProvider } });

  assert.equal(resolvedRows().length, 0);
  assert.ok(screen.queryByText(NO_MODELS_COPY) !== null, "the empty state survives, now localized");
  assert.ok(chipButtons().length === 0);
});

test("the resolved list is bounded, because a discovery provider can resolve hundreds", async (t) => {
  await mount(t, { lab: discoveryProvider }, resolved(Array.from({ length: 400 }, (_, i) => `zz-${i}`)));

  const region = resolvedRows()[0].parentElement.getAttribute("style") ?? "";
  assert.match(region, /max-height/, "the resolved list needs a scroll region, or it re-creates the chip problem");
  assert.match(region, /overflow-y:\s*auto/);
});

test("the empty state waits for omp's answer instead of claiming nothing resolved first", async (t) => {
  const gate = await mount(t, { lab: discoveryProvider }, [], { holdModels: true });

  assert.ok(screen.queryByText(NO_MODELS_COPY) === null, "a pending registry load is not an empty registry");

  await gate.releaseModels();
  assert.ok(screen.queryByText(NO_MODELS_COPY) !== null, "and the copy appears once omp has said it found none");
});

test("the empty-state key says 'resolved', not 'defined' — omp, not this file, resolves them", () => {
  assert.ok(
    /resolved/i.test(NO_MODELS_COPY),
    "the copy used to claim nothing was 'defined', which is a statement about models.yml, not about omp",
  );
  assert.ok(
    RESOLVED_CAPTION.includes("models.yml"),
    "the caption has to name models.yml, otherwise the reader cannot tell what is not being saved",
  );
  assert.equal(RESOLVED_CAPTION, en["modelsConfig.resolvedModelsCaption"], "the key is a real string, not the key");
});