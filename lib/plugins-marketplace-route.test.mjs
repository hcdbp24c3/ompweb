import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

// Scope note: this file covers only what the route does WITHOUT spawning omp —
// its validation, its allowlist, and how it reports a failed launch. The argv
// omp-web sends is pinned by marketplaceArgv() in
// lib/omp/plugin-marketplace.test.mjs, and the stdout parsing by the parser
// tests there.
//
// That split is forced. The route spawns through
// `import { execFile } from "child_process"`, and jiti binds that named import
// to a local const at module-eval time, so `t.mock.method(childProcess,
// "execFile", ...)` never intercepts it — verified with moduleCache:false,
// tryNative:false and interopDefault alike, all reporting mockHit=false.
// Substituting a fake omp binary instead failed on CI in ways that did not
// reproduce locally, including ENOENT against a file the test had just written.
//
// `@/lib/file-access` is stubbed because its allowlist is derived from live
// session cwds, which a unit test cannot stand up.
const tmp = mkdtempSync(join(tmpdir(), "omp-web-plugins-stub-"));
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

const post = (body) =>
  POST(new Request("http://local/api/plugins", { method: "POST", body: JSON.stringify(body) }));

after(() => rmSync(tmp, { recursive: true, force: true }));

test("cwd is required", async () => {
  const res = await POST(new Request("http://local/api/plugins", {
    method: "POST",
    body: JSON.stringify({ action: "discover" }),
  }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "cwd_required");
});

test("an action is required", async () => {
  const res = await post({ cwd: CWD });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "action_required");
});

// `marketplace_argv` takes the name, not the source path — omp resolves these
// against its own registry — so an empty target must never reach the spawn.
test("marketplace_add requires a source", async () => {
  const res = await post({ action: "marketplace_add", cwd: CWD });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "source_required");
});

test("marketplace_remove requires a name", async () => {
  const res = await post({ action: "marketplace_remove", cwd: CWD });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "source_required");
});

test("a cwd outside the allowlist is refused", async () => {
  const res = await post({ action: "discover", cwd: "/etc" });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "access_denied");
});

test("GET refuses a cwd outside the allowlist", async () => {
  const res = await GET(new Request("http://local/api/plugins?cwd=/etc"));
  assert.equal(res.status, 403);
});

test("an unknown action is refused rather than passed to omp", async () => {
  const res = await post({ action: "nonsense", cwd: CWD });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "plugin_unsupported_action");
});

test("a missing omp binary is reported on the write path, not swallowed", async (t) => {
  const previous = process.env.OMP_WEB_OMP_BIN;
  process.env.OMP_WEB_OMP_BIN = join(tmp, "no-such-omp");
  t.after(() => {
    if (previous === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previous;
  });

  const res = await post({ action: "marketplace_add", source: "https://example.test/x", cwd: CWD });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.ok(/omp binary not found/.test(body.error), `saw ${JSON.stringify(body)}`);
});

test("the read paths still render when omp is unavailable, with the reason attached", async (t) => {
  // Degrading rather than erroring is deliberate: the panel must open and show
  // the installed plugins even when omp cannot be launched, so the marketplace
  // section explains itself instead of blanking the whole panel.
  const previous = process.env.OMP_WEB_OMP_BIN;
  process.env.OMP_WEB_OMP_BIN = join(tmp, "no-such-omp");
  t.after(() => {
    if (previous === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previous;
  });

  const res = await GET(new Request(`http://local/api/plugins?cwd=${CWD}`));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.packages, []);
  assert.deepEqual(data.marketplaces, []);
  assert.ok(data.marketplaceWarning, "the failure is reported, not hidden");
});
