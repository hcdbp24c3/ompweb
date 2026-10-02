// The custom-provider cards render one chip per model. A provider configured
// from a discovery probe can hold dozens of ids, and the chips wrapped freely
// until they pushed the Save bar off the bottom of the scroll area — the user
// had to scroll past every model to reach Save. Two behaviours are asserted
// here: the chip list is capped and expandable, and Save is pinned to the
// bottom of the scroll container so it never has to be scrolled to.
import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
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

beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
afterEach(cleanup);

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

const manyModels = (count) =>
  Array.from({ length: count }, (_, i) => ({ id: `model-${String(i).padStart(2, "0")}` }));

/** Mounts the editor on the custom-providers overview — the view where the
 *  chips are — with a single provider holding `count` models. */
async function overview(t, count) {
  const provider = {
    baseUrl: "http://127.0.0.1:8000/v1",
    api: "openai-completions",
    auth: "none",
    models: manyModels(count),
  };
  t.mock.method(globalThis, "fetch", async (url) => {
    const target = String(url);
    if (target === "/api/models-config") return jsonResponse({ providers: { lab: provider } });
    if (target === "/api/auth/providers") return jsonResponse({ providers: [] });
    if (target === "/api/auth/all-providers") return jsonResponse({ providers: [] });
    if (target === "/api/models") return jsonResponse({ modelList: [], connectedProviders: [] });
    return jsonResponse({ error: "not found" }, 404);
  });
  render(React.createElement(ModelsConfig, { onClose: () => {}, embedded: true }));
  await act(async () => { screen.getByText("Custom providers").click(); });
}

/** The per-model chips, i.e. every button whose label is exactly a model id. */
const chipButtons = () =>
  screen.getAllByRole("button").filter((button) => /^model-\d\d$/.test(button.textContent.trim()));

const moreButton = () =>
  screen.getAllByRole("button").find((button) => /^\+\d+ more$/.test(button.textContent.trim()));

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
  const provider = {
    baseUrl: "http://127.0.0.1:8000/v1",
    api: "openai-completions",
    auth: "none",
    models: manyModels(30),
  };
  t.mock.method(globalThis, "fetch", async (url) => {
    const target = String(url);
    if (target === "/api/models-config") {
      return jsonResponse({ providers: { lab: provider, small: { ...provider, models: [{ id: "only-one" }] } } });
    }
    if (target === "/api/auth/providers") return jsonResponse({ providers: [] });
    if (target === "/api/auth/all-providers") return jsonResponse({ providers: [] });
    if (target === "/api/models") return jsonResponse({ modelList: [], connectedProviders: [] });
    return jsonResponse({ error: "not found" }, 404);
  });
  render(React.createElement(ModelsConfig, { onClose: () => {}, embedded: true }));
  await act(async () => { screen.getByText("Custom providers").click(); });

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
