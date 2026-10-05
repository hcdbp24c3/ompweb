// The `known_hosts` file is the whole reason `accept-new` is a decision rather
// than a rubber stamp: ssh only ever *fails* on a changed host key because it can
// compare against a file that survives between clones. So the properties that
// matter here are entirely about that file — it exists, only the owner may read
// or write it, it is never truncated, and there is exactly ONE path for it.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@/": repoRoot } });
const { KNOWN_HOSTS_FILE, ensureKnownHostsFile, knownHostsPath } = await jiti.import("./ssh-known-hosts.ts");

let root;
let originalAgentDir;

before(() => {
  root = mkdtempSync(join(tmpdir(), "omp-web-known-hosts-"));
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
});

after(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => rmSync(join(root, "agent"), { recursive: true, force: true }));

// Windows has no POSIX permission bits: Node synthesises 0o666 for every
// ordinary file and OpenSSH-for-Windows reads these through Win32 without
// enforcing a mode, so a mode assertion there measures nothing and only
// reports a failure that cannot happen.
const modeOf = (path) =>
  process.platform === "win32" ? 0o600 : statSync(path).mode & 0o777;
const line = "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterialForTests\n";

test("the file lives in the agent dir, which is the only path on the persisted volume", () => {
  const path = knownHostsPath();

  assert.equal(path, join(process.env.PI_CODING_AGENT_DIR, "known_hosts"));
  assert.equal(KNOWN_HOSTS_FILE, "known_hosts");
});

test("ensureKnownHostsFile creates it owner-only, and reports the same path", () => {
  const path = ensureKnownHostsFile();

  assert.equal(path, knownHostsPath());
  assert.ok(existsSync(path), "ssh appends to the file, so it must exist before git runs");
  assert.equal(modeOf(path), 0o600, "ssh refuses a group/world-writable known_hosts, and nothing else may write it");
  assert.equal(readFileSync(path, "utf8"), "");
});

test("a host already recorded survives — the file is opened, never truncated", () => {
  mkdirSync(join(root, "agent"), { recursive: true });
  const path = join(process.env.PI_CODING_AGENT_DIR, KNOWN_HOSTS_FILE);
  writeFileSync(path, line, { mode: 0o600 });

  ensureKnownHostsFile();
  ensureKnownHostsFile();

  assert.equal(readFileSync(path, "utf8"), line, "losing a recorded host key means every clone is TOFU again");
});

test("a file restored from a backup with loose permissions is tightened, not trusted", () => {
  mkdirSync(join(root, "agent"), { recursive: true });
  const path = join(process.env.PI_CODING_AGENT_DIR, KNOWN_HOSTS_FILE);
  writeFileSync(path, line, { mode: 0o666 });
  chmodSync(path, 0o666);

  ensureKnownHostsFile();

  assert.equal(modeOf(path), 0o600);
  assert.equal(readFileSync(path, "utf8"), line);
});

test("a missing agent dir is created rather than failing the clone", () => {
  assert.equal(existsSync(join(root, "agent")), false);

  ensureKnownHostsFile();

  assert.ok(existsSync(knownHostsPath()));
});