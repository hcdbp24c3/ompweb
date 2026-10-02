import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
const fakeBin = join(tmp, "fake-omp.sh");
const argvLog = join(tmp, "argv.log");

const script = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${argvLog}
args="$*"
case "$args" in
  "plugin marketplace")
    printf 'Configured Marketplaces:\\n\\n  demo-marketplace  http://127.0.0.1:8899/mkt.json\\n  local-demo  /tmp/opencode/mkt-local\\n'
    ;;
  "plugin marketplace add "*) printf '\\xe2\\x9c\\x94 Added marketplace: %s\\n' "\${args#plugin marketplace add }" ;;
  "plugin marketplace remove "*) printf '\\xe2\\x9c\\x94 Removed marketplace: %s\\n' "\${args#plugin marketplace remove }" ;;
  "plugin discover")
    printf 'Available Plugins:\\n\\n  acme-linter@1.2.0\\n    Lint helper\\n  acme-formatter@0.4.1\\n    Format helper\\n'
    ;;
  "plugin discover "*)
    printf 'Available Plugins (%s):\\n\\n  acme-linter@1.2.0\\n    Lint helper\\n' "\${args#plugin discover }"
    ;;
  "plugin list --json"*) printf '{"npm":[],"marketplace":[]}' ;;
  *) printf '{}' ;;
esac
`;
writeFileSync(fakeBin, script, "utf8");
if (process.platform !== "win32") {
  const { chmodSync } = await import("node:fs");
  chmodSync(fakeBin, 0o755);
}

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

  assert.equal(res.status, 200);
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

test("an unrecognised omp format surfaces a warning instead of an empty-but-confident catalog", async () => {
  // Rewrite the fake mid-test so omp "changes its output".
  writeFileSync(
    fakeBin,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${argvLog}\ncase "$*" in\n  "plugin marketplace") printf 'Your marketplaces:\\n\\n  drifted  https://example.test\\n';;\n  "plugin discover") printf 'Plugins you might like:\\n\\n  surprise@9.9.9\\n';;\n  "plugin list --json"*) printf '{"npm":[],"marketplace":[]}';;\n  *) printf '{}';;\nesac\n`,
    "utf8",
  );

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