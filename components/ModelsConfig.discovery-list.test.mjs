// The Discover-models result list. An aggregator's `/models` endpoint answers
// with 100-800 entries, and the list rendered every one of them into an uncapped
// flex column, so the settings pane grew by the full result height and the user
// had no way to find one model in it.
//
// This asserts the shape `ModelCatalogPicker` already uses for the same job: a
// filter that matches name *and* id, a presentational cap with a "Showing N of
// M" line and a show-more control, and a bounded scroll region. The cap is
// presentational only — every discovered model is still pre-ticked and still
// reaches "Add selected", so nothing becomes unreachable because it is hidden.
import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

/** Must match DISCOVERY_RESULT_LIMIT in ModelsConfig.tsx. */
const DISCOVERY_RESULT_LIMIT = 30;

// A successful save arms a 2s "Saved" lockout that would outlive the file-level
// teardown and fail the run with "window is not defined", so long timers are
// clamped (same reason as ModelsConfig.provider-ui.test.mjs).
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (handler, timeout, ...args) =>
  realSetTimeout(handler, typeof timeout === "number" && timeout > 500 ? 5 : timeout, ...args);
const settle = () => act(async () => { await new Promise((resolve) => realSetTimeout(resolve, 20)); });

const en = JSON.parse(readFileSync(new URL("../lib/i18n/locales/en.json", import.meta.url), "utf8"));
/** Renders an en.json template the way `translate()` does, so no assertion here
 *  hardcodes English and breaks when the copy is reworded. `translate()` echoes a
 *  missing key back as the key; the same fallback keeps a missing key a readable
 *  per-test failure instead of a module-level crash that takes the file with it. */
const copy = (key, vars) => {
  const raw = en[key] ?? key;
  if (!vars) return raw;
  return Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), raw);
};

const FILTER_LABEL = copy("modelsConfig.discoveryFilterPlaceholder");
/** The invariant prefix of the show-more label — everything before `{count}`. */
const SHOW_MORE_PREFIX = copy("modelsConfig.discoveryShowMore").split("{count}")[0];
const NO_MATCH = copy("modelsConfig.noModelsMatch");
const CLEAR = copy("modelsConfig.clearFilter");

const BASE_PROVIDER = {
  baseUrl: "http://127.0.0.1:8000/v1",
  api: "openai-completions",
  auth: "none",
  discovery: { type: "openai-models-list" },
};

beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
afterEach(cleanup);

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

/** `count` discovered models whose display name shares no substring with the id
 *  (`Widget 042` vs `zz-042`), so a filter that only reads one of the two can be
 *  told apart from one that reads both. */
const makeModels = (count) =>
  Array.from({ length: count }, (_, i) => {
    const n = String(i).padStart(3, "0");
    return { id: `zz-${n}`, name: `Widget ${n}` };
  });

/** Mounts the provider detail and runs a discovery against `models`. */
async function runDiscovery(t, models) {
  const saved = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const target = String(url);
    const method = init?.method ?? "GET";
    if (target === "/api/models-config" && method === "PUT") {
      saved.push(JSON.parse(init.body));
      return jsonResponse({ success: true });
    }
    if (target === "/api/models-config/discover") return jsonResponse({ ok: true, models, latencyMs: 7 });
    if (target === "/api/models-config") return jsonResponse({ providers: { lab: BASE_PROVIDER } });
    if (target === "/api/auth/providers") return jsonResponse({ providers: [] });
    if (target === "/api/auth/all-providers") return jsonResponse({ providers: [] });
    if (target === "/api/models") return jsonResponse({ modelList: [], connectedProviders: [] });
    return jsonResponse({ error: "not found" }, 404);
  });

  const user = userEvent.setup();
  render(React.createElement(ModelsConfig, { onClose: () => {}, embedded: true }));
  await act(async () => { screen.getByText("Custom providers").click(); });
  await act(async () => { screen.getByRole("button", { name: "Edit" }).click(); });
  await user.click(screen.getByRole("button", { name: "Discover models" }));
  await waitFor(() => assert.ok(rows().length > 0, "the discovery result never rendered"));

  return {
    user,
    saved,
    filter: () => screen.getByLabelText(FILTER_LABEL),
    typeFilter: (text) => user.type(screen.getByLabelText(FILTER_LABEL), text),
    /** The whole batch path: append the ticked models, then write models.yml. */
    async appendAndSave() {
      await user.click(screen.getByRole("button", { name: "Add selected" }));
      await act(async () => { screen.getByRole("button", { name: "Save" }).click(); });
      await waitFor(() => assert.ok(saved.length > 0, "the PUT never fired"));
      await settle();
      return saved.at(-1).providers.lab;
    },
    /** Clicks show-more until nothing is hidden. */
    async revealAll() {
      let clicks = 0;
      while (showMoreButton()) {
        await user.click(showMoreButton());
        clicks += 1;
      }
      return clicks;
    },
  };
}

/** The discovered-model checkboxes, identified by their aria-label (the id). */
const rows = () => screen.queryAllByRole("checkbox", { name: /^zz-\d\d\d$/ });
/** Their ids as plain strings — comparing node arrays with assert.deepEqual walks
 *  them through util.inspect while building the message and OOM-kills the run. */
const rowIds = () => rows().map((box) => box.getAttribute("aria-label"));
const showMoreButton = () =>
  screen
    .queryAllByRole("button")
    .find((button) => (button.getAttribute("aria-label") ?? "").startsWith(SHOW_MORE_PREFIX));
/** The cap line: `Showing <shown> of <total>`. */
const summary = (shown, total) => screen.queryByText(copy("modelsConfig.discoveryShowingOf", { shown, total }));

test("a 500-model result renders at most the cap plus a total", async (t) => {
  await runDiscovery(t, makeModels(500));

  assert.equal(rows().length, DISCOVERY_RESULT_LIMIT, "the result list is capped, not 500 rows tall");
  assert.ok(
    summary(DISCOVERY_RESULT_LIMIT, 500) !== null,
    `the cap is reported as "${copy("modelsConfig.discoveryShowingOf", { shown: DISCOVERY_RESULT_LIMIT, total: 500 })}"`,
  );
  assert.equal(
    screen.getByText("500 models found").textContent,
    "500 models found",
    "and the unfiltered total is still stated, so a capped list never reads as the whole result",
  );
});

test("the filter narrows by name", async (t) => {
  const view = await runDiscovery(t, makeModels(500));

  await view.typeFilter("idget 0");

  assert.ok(
    summary(DISCOVERY_RESULT_LIMIT, 100) !== null,
    "`Widget 000`..`Widget 099` match, and no id contains `idget` — the cap still applies to the narrowed set",
  );
  assert.deepEqual(rowIds().slice(0, 2), ["zz-000", "zz-001"]);
});

test("the filter narrows by id, which a display name does not carry", async (t) => {
  const view = await runDiscovery(t, makeModels(500));

  await view.typeFilter("zz-0");

  assert.ok(
    summary(DISCOVERY_RESULT_LIMIT, 100) !== null,
    "`zz-000`..`zz-099` match by id; a name-only filter would have found none, since no name contains `zz-`",
  );
  assert.ok(rowIds().every((id) => id.startsWith("zz-0")), "and nothing outside that prefix leaked in");
});

test("a filter that narrows below the cap still reports the narrowed total", async (t) => {
  const view = await runDiscovery(t, makeModels(500));

  await view.typeFilter("idget 49");

  assert.equal(rows().length, 10, "`Widget 490`..`Widget 499` all fit under the cap");
  assert.ok(
    summary(10, 10) !== null,
    "so the cap line carries no information — but 490 rows are still hidden by the filter, and saying nothing would read as \"these 10 are all there is\"",
  );
});

test("the filter is case-insensitive on both fields", async (t) => {
  const view = await runDiscovery(t, makeModels(500));

  await view.typeFilter("WIDGET 499");

  assert.deepEqual(rowIds(), ["zz-499"], "typing the name in a different case still finds it");
});

test("show-more pages the list, and every revealed row is selectable", async (t) => {
  const view = await runDiscovery(t, makeModels(500));

  const first = showMoreButton();
  assert.equal(
    first.getAttribute("aria-label"),
    copy("modelsConfig.discoveryShowMore", { count: 500 - DISCOVERY_RESULT_LIMIT }),
    "the control says how many rows are still hidden",
  );
  await view.user.click(first);
  assert.equal(rows().length, DISCOVERY_RESULT_LIMIT * 2, "one page at a time, not all 500 in one go");
  assert.equal(
    showMoreButton().getAttribute("aria-label"),
    copy("modelsConfig.discoveryShowMore", { count: 500 - DISCOVERY_RESULT_LIMIT * 2 }),
    "and the remaining count follows",
  );

  await view.revealAll();
  assert.equal(rows().length, 500, "the whole result becomes reachable");
  assert.equal(showMoreButton(), undefined, "and the control retires once nothing is hidden");

  assert.equal(rows()[499].checked, true, "a revealed row is pre-ticked like every other one");
  await view.user.click(rows()[499]);
  assert.equal(rows()[499].checked, false, "and it can be unticked like any other row");
});

test("a short result needs no cap, no summary and no show-more control", async (t) => {
  await runDiscovery(t, makeModels(4));

  assert.equal(rows().length, 4);
  assert.equal(summary(4, 4), null, "nothing is hidden, so nothing is reported as hidden");
  assert.equal(showMoreButton(), undefined);
});

test("the list lives in a bounded scroll region", async (t) => {
  await runDiscovery(t, makeModels(500));

  const region = rows()[0].closest("label").parentElement.getAttribute("style") ?? "";
  assert.match(region, /max-height/, "otherwise the cap still pushes the pane to the height of 500 rows");
  assert.match(region, /overflow-y:\s*auto/);
});

test("the cap is presentational: hidden models are still appended", async (t) => {
  const view = await runDiscovery(t, makeModels(500));

  assert.equal(rows().length, DISCOVERY_RESULT_LIMIT, "precondition: 470 of them are not on screen");
  const written = await view.appendAndSave();

  assert.equal(
    written.models.length,
    500,
    "`Add selected` reads the whole result set, so a cap must not drop the rows it is hiding",
  );
  assert.deepEqual(
    written.models.slice(0, 2),
    [{ id: "zz-000", name: "Widget 000" }, { id: "zz-001", name: "Widget 001" }],
    "and the appended entries are unchanged — the cap added nothing to the batch body",
  );
});

test("unticking a row inside the filter affects only that row", async (t) => {
  const view = await runDiscovery(t, makeModels(500));

  await view.typeFilter("zz-0");
  await view.user.click(rows()[0]);
  const written = await view.appendAndSave();

  assert.equal(written.models.length, 499, "unticking one of 500 pre-ticked rows removes exactly one");
  assert.ok(
    !written.models.some((model) => model.id === "zz-000"),
    "and it is the row that was unticked",
  );
});

test("a filter that matches nothing says so instead of rendering an empty box", async (t) => {
  const view = await runDiscovery(t, makeModels(500));

  await view.typeFilter("no-such-model");

  assert.equal(rows().length, 0);
  assert.ok(
    screen.queryByText(NO_MATCH.replace("{query}", "no-such-model")) !== null,
    "an empty filtered result needs its own copy; the 500-model total is not an answer to the query",
  );
  assert.equal(showMoreButton(), undefined, "and nothing to page through");
});

test("the filter can be cleared back to the whole result", async (t) => {
  const view = await runDiscovery(t, makeModels(500));

  await view.typeFilter("zz-0");
  assert.equal(rows().length, DISCOVERY_RESULT_LIMIT);
  assert.ok(summary(DISCOVERY_RESULT_LIMIT, 100) !== null, "the narrowed total while the filter is up");
  await view.user.click(screen.getByRole("button", { name: CLEAR }));

  assert.equal(view.filter().value, "", "the filter input is emptied");
  assert.ok(summary(DISCOVERY_RESULT_LIMIT, 500) !== null, "and the cap summary comes back, because 500 rows no longer fit");
});

test("a second discovery resets the filter and the expansion", async (t) => {
  const view = await runDiscovery(t, makeModels(500));

  await view.typeFilter("zz-0");
  await view.revealAll();
  assert.equal(rows().length, 100, "precondition: the expansion covered the whole narrowed set");

  await view.user.click(screen.getByRole("button", { name: "Discover models" }));
  await waitFor(() => assert.equal(rows().length, DISCOVERY_RESULT_LIMIT, "a fresh result starts at the cap"));
  assert.equal(view.filter().value, "", "a filter over the previous result set is meaningless");
});

test("the new keys are real copy, not key echoes", () => {
  for (const key of ["discoveryFilterPlaceholder", "discoveryShowingOf", "discoveryShowMore"]) {
    const value = en[`modelsConfig.${key}`];
    assert.ok(value && !value.startsWith("modelsConfig."), `${key} resolves to a string, not to itself`);
  }
  assert.match(en["modelsConfig.discoveryShowingOf"], /\{shown\}/, "the summary needs both counts");
  assert.match(en["modelsConfig.discoveryShowingOf"], /\{total\}/);
  assert.match(en["modelsConfig.discoveryShowMore"], /\{count\}/, "the show-more label needs the remaining count");
});