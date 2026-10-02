// The Plugins panel could install a plugin only by pasting an opaque spec
// string; there was no way to see what a marketplace offers or to add, refresh
// or drop a marketplace at all. These tests pin the marketplace block: that it
// lists the configured sources, browses their catalog, installs an entry with
// the `name@marketplace` reference omp actually accepts, and — the important
// one — says so when omp's marketplace output stops being parseable instead of
// rendering as "this marketplace is empty".
import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { PluginsConfig } = await jiti.import("./PluginsConfig.tsx");

beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
afterEach(cleanup);

const jsonResponse = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const MARKETPLACES = [
  { name: "demo-marketplace", source: "http://127.0.0.1:8899/mkt.json" },
  { name: "local-demo", source: "/tmp/opencode/mkt-local" },
];
const CATALOG = [
  { name: "acme-linter", version: "1.2.0", description: "Lint helper" },
  { name: "acme-formatter", version: "0.4.1", description: "Format helper" },
];

/** Records every POST body so the tests can assert the exact action + source
 *  omp-web sends — the ref format in particular is easy to get subtly wrong. */
function mount({ list, discover, marketplaceWarning, catalogWarning } = {}) {
  const posts = [];
  globalThis.fetch = async (url, init) => {
    if (init?.method === "POST") {
      const body = JSON.parse(init.body);
      posts.push(body);
      if (body.action === "discover") {
        return jsonResponse({
          packages: [],
          totals: {},
          diagnostics: [],
          catalog: discover ?? CATALOG,
          catalogWarning: catalogWarning ?? null,
        });
      }
      return jsonResponse({
        packages: [],
        totals: {},
        diagnostics: [],
        marketplaces: list ?? MARKETPLACES,
        marketplaceWarning: marketplaceWarning ?? null,
      });
    }
    return jsonResponse({
      packages: [],
      totals: {},
      diagnostics: [],
      marketplaces: list ?? MARKETPLACES,
      marketplaceWarning: marketplaceWarning ?? null,
    });
  };

  render(
    React.createElement(PluginsConfig, {
      cwd: "/tmp/omp-web-test-project",
      sessionId: null,
      onClose() {},
      embedded: true,
    }),
  );
  return { posts };
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

/** AddPluginPanel renders its own button labelled "Install", so catalog
 *  controls are looked up inside the catalog group, never document-wide. */
const catalog = () => within(screen.getByRole("group", { name: "Available plugins" }));

test("the configured marketplaces and their sources are listed", async () => {
  mount();
  await flush();

  assert.ok(screen.getByText("demo-marketplace"), "marketplace name is shown");
  assert.ok(screen.getByText("http://127.0.0.1:8899/mkt.json"), "and its source");
  assert.ok(screen.getByText("local-demo"));
});

test("browsing sends a discover and lists the catalog with versions and descriptions", async () => {
  const { posts } = mount();
  await flush();

  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Browse marketplace" })); });
  await flush();

  assert.deepEqual(posts, [{ action: "discover", cwd: "/tmp/omp-web-test-project" }]);
  assert.ok(screen.getByText(/acme-linter/));
  assert.ok(screen.getByText("@1.2.0"), "the version rides with the name");
  assert.ok(screen.getByText("Lint helper"));
});

test("browsing one marketplace scopes the request to it", async () => {
  const { posts } = mount();
  await flush();

  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Browse local-demo" })); });
  await flush();

  assert.deepEqual(posts[0], { action: "discover", source: "local-demo", cwd: "/tmp/omp-web-test-project" });
});

test("adding a marketplace posts the typed source", async () => {
  const { posts } = mount();
  await flush();

  const input = screen.getByLabelText("https://owner/repo, ./path, or a catalog URL");
  await act(async () => {
    fireEvent.change(input, { target: { value: "https://github.com/acme/plugins" } });
  });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add" })); });
  await flush();

  assert.ok(
    posts.some((p) => p.action === "marketplace_add" && p.source === "https://github.com/acme/plugins"),
    `saw ${JSON.stringify(posts)}`,
  );
});

test("removing targets the marketplace by name, not by its source path", async () => {
  const { posts } = mount();
  await flush();

  await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Remove marketplace" })[1]); });
  await flush();

  assert.deepEqual(posts[0], {
    action: "marketplace_remove",
    source: "local-demo",
    cwd: "/tmp/omp-web-test-project",
  });
});

test("an unparseable catalog warns instead of claiming the marketplace is empty", async () => {
  // `omp plugin discover` and `omp plugin marketplace` have no JSON mode, so a
  // format change in omp is the failure mode this guards. A silently empty list
  // would tell the user their marketplace has nothing in it.
  mount({ catalog: [], catalogWarning: "unrecognised `omp plugin discover` output" });
  await flush();

  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Browse marketplace" })); });
  await flush();

  assert.ok(
    screen.getByText(/Could not read this catalog/),
    "the warning is shown",
  );
  assert.ok(
    screen.getByText("unrecognised `omp plugin discover` output"),
    "with omp's own wording so the cause is visible",
  );
  assert.equal(
    screen.queryByText("No plugins in this catalog."),
    null,
    "and it is NOT passed off as an empty marketplace",
  );
});

test("an unparseable marketplace list says the installed plugins are unaffected", async () => {
  mount({ list: [], marketplaceWarning: "unrecognised `omp plugin marketplace` output" });
  await flush();

  assert.ok(screen.getByText(/Could not read the marketplace list/));
  assert.ok(screen.getByText(/installed plugins are unaffected/i));
});

test("a genuinely empty marketplace is not reported as a parse failure", async () => {
  mount({ list: [], marketplaceWarning: null });
  await flush();

  assert.equal(screen.queryByText(/Could not read the marketplace list/), null);
});

test("the catalog stays open after installing, so several can be added in a row", async () => {
  const { posts } = mount();
  await flush();

  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Browse local-demo" })); });
  await flush();
  await act(async () => { fireEvent.click(catalog().getAllByRole("button", { name: "Install" })[0]); });
  await flush();

  // Still showing both entries means add mode was not torn down by the install.
  assert.ok(screen.getByText(/acme-formatter/));
  assert.equal(posts.filter((p) => p.action === "install").length, 1);
});
// Regression guard, found by running the real route against the real omp binary:
// `omp plugin install <bare-name>` does NOT fall back to a marketplace — omp
// treats the bare name as an npm spec and runs `bun install <name>`. So an
// Install button offered while browsing *every* marketplace would send an
// unqualified name and silently try to install a same-named npm package
// instead of the catalog entry the user clicked.
test("browsing every marketplace is discovery-only: no unqualified install", async () => {
  mount();
  await flush();

  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Browse marketplace" })); });
  await flush();

  assert.equal(
    catalog().queryAllByRole("button", { name: "Install" }).length,
    0,
    "no Install button, because the reference would be ambiguous",
  );
  assert.ok(
    screen.getByText(/pick a marketplace to install from/i),
    "and the user is told how to get one",
  );
});

test("the same plugin name in two marketplaces is listed once, not twice", async () => {
  // `omp plugin discover` over all catalogs concatenates them and attributes
  // nothing, so a duplicate name would render as two identical rows.
  mount({ discover: [...CATALOG, ...CATALOG] });
  await flush();

  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Browse marketplace" })); });
  await flush();

  assert.equal(catalog().queryAllByText("acme-linter").length, 1);
  assert.equal(catalog().queryAllByText("acme-formatter").length, 1);
});

test("a marketplace-scoped catalog still offers a qualified install", async () => {
  const { posts } = mount();
  await flush();

  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Browse local-demo" })); });
  await flush();

  await act(async () => { fireEvent.click(catalog().getAllByRole("button", { name: "Install" })[0]); });
  await flush();

  assert.ok(
    posts.some((p) => p.action === "install" && p.source === "acme-linter@local-demo"),
    `expected a qualified ref, saw ${JSON.stringify(posts)}`,
  );
});
