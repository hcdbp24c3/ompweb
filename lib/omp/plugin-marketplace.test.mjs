// `omp plugin marketplace` and `omp plugin discover` are the only ways to reach
// a marketplace catalog, and neither honours `--json`: handleDiscover() takes
// `(args, _flags)` and never reads the flags, so both print the same human text
// whether or not you ask for JSON. Verified against omp 18.4.6.
//
// `omp plugin list --json` does emit JSON, but its `marketplace` array is
// listInstalledPlugins() — plugins already installed from a marketplace, not the
// browsable catalog — so it cannot stand in for either.
//
// That leaves parsing. The shapes are fixed and indentation-driven, and the
// caller forces FORCE_COLOR=0/NO_COLOR=1, so the output arrives plain:
//
//   Configured Marketplaces:
//
//     <name>  <source>
//
//   Available Plugins:
//
//     <name>[@<version>]
//       <description>
//
// Every parser returns `parseWarning` rather than throwing: a format change in
// omp must degrade to an empty list the UI can explain, never to a wrong one.
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const {
  parseMarketplaceList,
  parseDiscoverOutput,
  pluginInstallRef,
  marketplaceArgv,
} = await jiti.import("@/lib/omp/plugin-marketplace.ts");

const LIST_OUTPUT = [
  "Configured Marketplaces:",
  "",
  "  demo-marketplace  http://127.0.0.1:8899/mkt.json",
  "  acme  https://github.com/acme/plugins",
  "",
].join("\n");

const DISCOVER_OUTPUT = [
  "Available Plugins:",
  "",
  "  acme-linter@1.2.0",
  "    Lint helper",
  "  acme-formatter",
  "    Format helper that has no version",
  "",
].join("\n");

test("marketplace list parses name and source pairs", () => {
  const result = parseMarketplaceList(LIST_OUTPUT);
  assert.equal(result.warning, null);
  assert.deepEqual(result.marketplaces, [
    { name: "demo-marketplace", source: "http://127.0.0.1:8899/mkt.json" },
    { name: "acme", source: "https://github.com/acme/plugins" },
  ]);
});

test("an empty marketplace list is an empty list, not a parse failure", () => {
  const empty = parseMarketplaceList("No marketplaces configured\n\nAdd one with: omp plugin marketplace add <source>\n");
  assert.equal(empty.warning, null, "omp's own \"none configured\" line is not a format change");
  assert.deepEqual(empty.marketplaces, []);
});

test("discover parses name, version and description", () => {
  const result = parseDiscoverOutput(DISCOVER_OUTPUT);
  assert.equal(result.warning, null);
  assert.deepEqual(result.plugins, [
    { name: "acme-linter", version: "1.2.0", description: "Lint helper" },
    { name: "acme-formatter", version: null, description: "Format helper that has no version" },
  ]);
});

test("a plugin with no description still parses", () => {
  const result = parseDiscoverOutput("Available Plugins:\n\n  bare-plugin@2.0.0\n");
  assert.equal(result.warning, null);
  assert.deepEqual(result.plugins, [{ name: "bare-plugin", version: "2.0.0", description: null }]);
});

test("scoped names keep their leading @", () => {
  const result = parseDiscoverOutput("Available Plugins:\n\n  @acme/pkg@1.0.0\n    Scoped\n");
  assert.deepEqual(result.plugins, [{ name: "@acme/pkg", version: "1.0.0", description: "Scoped" }]);
});

test("discover can be filtered to one marketplace", () => {
  const filtered = parseDiscoverOutput("Available Plugins (acme):\n\n  only-this@1.0.0\n");
  assert.deepEqual(filtered.plugins, [{ name: "only-this", version: "1.0.0", description: null }]);
});

test("empty discover output is an empty list, not a warning", () => {
  const empty = parseDiscoverOutput("No plugins available\n");
  assert.equal(empty.warning, null);
  assert.deepEqual(empty.plugins, []);
});

test("a changed omp format degrades to a warning, never to wrong data", () => {
  // Headers omp prints today. If they ever change, say so instead of reporting
  // an empty catalog as "this marketplace has nothing".
  const drifted = parseDiscoverOutput("Plugins you might like:\n\n  surprise@9.9.9\n");
  assert.deepEqual(drifted.plugins, [], "nothing is invented");
  assert.ok(drifted.warning, "and the caller is told the format moved");
});

test("marketplace list degrades the same way", () => {
  const drifted = parseMarketplaceList("Your marketplaces:\n\n  surprise  https://example.test\n");
  assert.deepEqual(drifted.marketplaces, []);
  assert.ok(drifted.warning);
});

test("ANSI escapes are stripped before parsing", () => {
  // The 2-space indent matters and must survive the colour codes — real omp output
// indents before colourising (verified with `cat -v`).
  const coloured = `Available Plugins:\n\n  \x1B[36macme-linter\x1B[39m@1.2.0\n    Lint helper\n`;
  assert.deepEqual(parseDiscoverOutput(coloured).plugins, [
    { name: "acme-linter", version: "1.2.0", description: "Lint helper" },
  ]);
});

test("windows line endings parse the same", () => {
  const crlf = DISCOVER_OUTPUT.replace(/\n/g, "\r\n");
  assert.deepEqual(parseDiscoverOutput(crlf).plugins, parseDiscoverOutput(DISCOVER_OUTPUT).plugins);
});

test("a plugin id is shaped the way omp installs it: name@marketplace", () => {
  // omp's install reference is `name@marketplace`; the UI needs to build it.
  assert.equal(pluginInstallRef("acme-linter", "demo-marketplace"), "acme-linter@demo-marketplace");
  // A scoped name keeps its own @; only the last one separates the marketplace.
  assert.equal(pluginInstallRef("@acme/pkg", "demo"), "@acme/pkg@demo");
});
// `omp plugin marketplace` switches on `args[0] ?? "list"`, so the bare
// invocation is the listing. These pin the argv omp-web builds, which the route
// itself cannot test: it spawns via `import { execFile } from "child_process"`,
// and jiti binds that named import to a local const at module-eval time, so
// `t.mock.method(childProcess, "execFile", ...)` never intercepts it (checked
// with moduleCache:false, tryNative:false and interopDefault alike).
test("the marketplace listing is the bare subcommand", () => {
  assert.deepEqual(marketplaceArgv("list"), ["plugin", "marketplace"]);
  assert.deepEqual(marketplaceArgv("list", "ignored"), ["plugin", "marketplace"]);
});

test("add and remove carry their target", () => {
  assert.deepEqual(marketplaceArgv("add", "https://github.com/acme/plugins"), [
    "plugin", "marketplace", "add", "https://github.com/acme/plugins",
  ]);
  // remove takes the marketplace NAME, not its source path.
  assert.deepEqual(marketplaceArgv("remove", "local-demo"), ["plugin", "marketplace", "remove", "local-demo"]);
});

test("update refreshes one marketplace by name, or all of them when unnamed", () => {
  assert.deepEqual(marketplaceArgv("update", "local-demo"), ["plugin", "marketplace", "update", "local-demo"]);
  assert.deepEqual(marketplaceArgv("update"), ["plugin", "marketplace", "update"]);
  assert.deepEqual(marketplaceArgv("update", ""), ["plugin", "marketplace", "update"]);
  assert.deepEqual(marketplaceArgv("update", null), ["plugin", "marketplace", "update"]);
});

test("add and remove refuse to drop their target, so they cannot reach omp half-built", () => {
  assert.deepEqual(marketplaceArgv("add", ""), ["plugin", "marketplace", "add"]);
  assert.deepEqual(marketplaceArgv("remove", undefined), ["plugin", "marketplace", "remove"]);
});
