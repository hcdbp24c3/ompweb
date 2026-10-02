import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

// The plugins route reaches omp through an internal runOmp() helper, so there is
// nothing to stub at the module boundary. Instead the real binary is replaced:
// OMP_WEB_OMP_BIN points at a script that reproduces omp's marketplace text
// output verbatim (captured from omp 18.4.6) and appends every argv to a log.
// That exercises the real execFile path, FORCE_COLOR/NO_COLOR handling and the
// real parsers, rather than a mocked seam.
//
// `@/lib/file-access` is stubbed instead: its allowlist is derived from live
// session cwds, which a unit test cannot stand up.
const tmp = mkdtempSync(join(tmpdir(), "omp-web-plugins-route-"));
const argvLog = join(tmp, "argv.log");

// The fake omp is a Node script, not a shell script. It has to be executable by
// execFile on ubuntu AND windows: a .sh cannot run on Windows at all, and its
// printf/permission behaviour is an extra variable this test does not need. Node
// is guaranteed present — it is running the tests.
//
// It reproduces omp's marketplace text output verbatim (captured from omp
// 18.4.6) and appends every argv to a log, so the real runOmp/execFile path, the
// FORCE_COLOR/NO_COLOR handling and the real parsers are all exercised.
//
// `@/lib/file-access` is stubbed instead: its allowlist is derived from live
// session cwds, which a unit test cannot stand up.
const fakeScript = join(tmp, "fake-omp.mjs");
writeFileSync(
  fakeScript,
  `import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_OMP_ARGV_LOG, argv.join(" ") + "\\n");
const line = argv.join(" ");
const LIST = "Configured Marketplaces:\\n\\n  demo-marketplace  http://127.0.0.1:8899/mkt.json\\n  local-demo  /tmp/opencode/mkt-local\\n";
const CATALOG = "Available Plugins:\\n\\n  acme-linter@1.2.0\\n    Lint helper\\n  acme-formatter@0.4.1\\n    Format helper\\n";
const drift = process.env.FAKE_OMP_DRIFT === "1";
if (drift && (line === "plugin marketplace" || line === "plugin discover" || line.startsWith("plugin discover "))) {
  // Stands in for omp changing the shape of its marketplace output.
  process.stdout.write(line === "plugin discover" ? "Plugins you might like:\\n\\n  surprise@9.9.9\\n" : "Your marketplaces:\\n\\n  drifted  https://example.test\\n");
} else if (line === "plugin marketplace") process.stdout.write(LIST);
else if (line === "plugin marketplace add " + argv[3]) process.stdout.write("Added marketplace: " + argv[3] + "\\n");
else if (line === "plugin marketplace remove " + argv[3]) process.stdout.write("Removed marketplace: " + argv[3] + "\\n");
else if (line === "plugin marketplace update " + argv[3]) process.stdout.write("Updated marketplace: " + argv[3] + "\\n");
else if (line === "plugin marketplace update") process.stdout.write("Updated marketplaces\\n");
else if (line === "plugin discover") process.stdout.write(CATALOG);
else if (line === "plugin discover " + argv[2]) process.stdout.write("Available Plugins (" + argv[2] + "):\\n\\n  acme-linter@1.2.0\\n    Lint helper\\n");
else if (line.startsWith("plugin list --json")) process.stdout.write('{"npm":[],"marketplace":[]}');
else process.stdout.write("{}\\n");
`,
  "utf8",
);

// POSIX: execFile needs the shebang file itself to be executable.
// Windows: a .cmd launcher, which resolveOmpBin/wrapWindowsScript route through
// cmd.exe. %* forwards the argv omp-web built.
const fakeBin = process.platform === "win32" ? join(tmp, "fake-omp.cmd") : join(tmp, "fake-omp");
if (process.platform === "win32") {
  writeFileSync(fakeBin, `@echo off\r\nnode "${fakeScript}" %*\r\n`, "utf8");
} else {
  writeFileSync(fakeBin, `#!/usr/bin/env node\nimport(${JSON.stringify(fakeScript)});\n`, "utf8");
  chmodSync(fakeBin, 0o755);
}

// runOmp forwards process.env to the child, so the log path reaches the fake.
process.env.FAKE_OMP_ARGV_LOG = argvLog;

process.env.OMP_WEB_OMP_BIN = fakeBin;

const accessStub = join(tmp, "file-access-stub.ts");
writeFileSync(
  accessStub,
  `export async function getAllowedFileRoots() { return ["/tmp"]; }
export function isExistingFilePathAllowed(p) { return typeof p === "string" && p.startsWith("/tmp"); }
export function allowFileRoot() {}
`,
  "utf8",
);

const jiti = createJiti(import.meta.url, {
  alias: { "@/lib/file-access": accessStub, "@/": repoRoot },
});
const { GET, POST } = await jiti.import("../app/api/plugins/route.ts");

const CWD = "/tmp/opencode";
const argv = () => (existsSync(argvLog) ? readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean) : []);

beforeEach(() => rmSync(argvLog, { force: true }));
after(() => rmSync(tmp, { recursive: true, force: true }));

const post = (body) => POST(new Request("http://local/api/plugins", { method: "POST", body: JSON.stringify(body) }));

test("GET hands the panel its configured marketplaces, parsed", async () => {
  const res = await GET(new Request(`http://local/api/plugins?cwd=${CWD}`));
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.marketplaceWarning, null);
  assert.deepEqual(data.marketplaces, [
    { name: "demo-marketplace", source: "http://127.0.0.1:8899/mkt.json" },
    { name: "local-demo", source: "/tmp/opencode/mkt-local" },
  ]);
});

test("discover returns the browsable catalog", async () => {
  const res = await post({ action: "discover", cwd: CWD });
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.catalogWarning, null);
  assert.deepEqual(data.catalog, [
    { name: "acme-linter", version: "1.2.0", description: "Lint helper" },
    { name: "acme-formatter", version: "0.4.1", description: "Format helper" },
  ]);
  assert.ok(argv().includes("plugin discover"));
});

test("discover passes a marketplace filter through as omp's positional arg", async () => {
  await post({ action: "discover", source: "local-demo", cwd: CWD });
  assert.ok(argv().includes("plugin discover local-demo"), `saw ${JSON.stringify(argv())}`);
});

test("marketplace_add shells the add subcommand and returns the refreshed list", async () => {
  const res = await post({ action: "marketplace_add", source: "https://github.com/acme/plugins", cwd: CWD });
  const data = await res.json();

  assert.equal(res.status, 200, `omp-web said: ${JSON.stringify(data).slice(0, 300)}`);
  assert.ok(argv().includes("plugin marketplace add https://github.com/acme/plugins"));
  assert.equal(data.marketplaces.length, 2, "the client does not need a second round trip");
});

test("marketplace_remove targets a marketplace by name, not by source", async () => {
  await post({ action: "marketplace_remove", source: "local-demo", cwd: CWD });
  assert.ok(argv().includes("plugin marketplace remove local-demo"), `saw ${JSON.stringify(argv())}`);
});

test("marketplace_update with no name updates every marketplace", async () => {
  await post({ action: "marketplace_update", cwd: CWD });
  assert.ok(argv().includes("plugin marketplace update"));
});

test("marketplace_add requires a source", async () => {
  const res = await post({ action: "marketplace_add", cwd: CWD });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "source_required");
});

test("a cwd outside the allowlist is refused before omp is spawned", async () => {
  const res = await post({ action: "discover", cwd: "/etc" });
  assert.equal(res.status, 403);
  assert.deepEqual(argv(), [], "omp must not have been invoked at all");
});

test("an unrecognised omp format surfaces a warning instead of an empty-but-confident catalog", async (t) => {
  // Make the fake answer with a shape omp does not print today.
  process.env.FAKE_OMP_DRIFT = "1";
  t.after(() => { delete process.env.FAKE_OMP_DRIFT; });

  const listed = await (await GET(new Request(`http://local/api/plugins?cwd=${CWD}`))).json();
  assert.deepEqual(listed.marketplaces, [], "nothing is invented");
  assert.ok(listed.marketplaceWarning, "and the UI is told the format moved");

  const browsed = await (await post({ action: "discover", cwd: CWD })).json();
  assert.deepEqual(browsed.catalog, []);
  assert.ok(browsed.catalogWarning);
});

test("the pre-existing install action still reaches omp with --json", async () => {
  await post({ action: "install", source: "github:acme/pkg", cwd: CWD });
  assert.ok(argv().includes("plugin install github:acme/pkg --json"));
});

test("an unknown action is still refused", async () => {
  const res = await post({ action: "nonsense", cwd: CWD });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "plugin_unsupported_action");
});