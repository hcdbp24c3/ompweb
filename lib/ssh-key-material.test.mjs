// A private key that only exists in memory has to reach `ssh -i` as a file, so
// this task is really about one thing: a key on disk for exactly as long as it
// is being used, and a GIT_SSH_COMMAND that cannot hang or silently trust.
//
// The tests are written against the filesystem rather than against a mock
// because every property that matters here IS a filesystem property — the mode
// bits, the fact that the directory is a fresh mkdtemp and not a predictable
// path somebody could pre-create as a symlink, and the fact that the file is
// gone on every exit path.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@/": repoRoot } });
const {
  SSH_KEY_DIR_PREFIX,
  buildGitSshCommand,
  materializeSshKey,
} = await jiti.import("./ssh-key-material.ts");

const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----";

let root;
let originalAgentDir;
let originalTmpDir;

before(() => {
  root = mkdtempSync(join(tmpdir(), "omp-web-ssh-key-test-"));
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  // The leak assertions below scan tmpdir(). Other test files run in parallel
  // and stage their own keys there, so the scan needs its own directory.
  originalTmpDir = process.env.TMPDIR;
  process.env.TMPDIR = join(root, "tmp");
  mkdirSync(process.env.TMPDIR, { recursive: true });
});

after(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalTmpDir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpDir;
  rmSync(root, { recursive: true, force: true });
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(SSH_KEY_DIR_PREFIX)) continue;
    rmSync(join(tmpdir(), name), { recursive: true, force: true });
  }
});

// Windows has no POSIX permission bits: Node synthesises 0o666 for every
// ordinary file and OpenSSH-for-Windows reads these through Win32 without
// enforcing a mode, so a mode assertion there measures nothing and only
// reports a failure that cannot happen.
const modeOf = (path) =>
  process.platform === "win32" ? 0o600 : statSync(path).mode & 0o777;

/** Directories this module may have created, so a leak is visible. */
function keyDirs() {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(SSH_KEY_DIR_PREFIX));
}

test("the key is written 0o600 inside a 0o700 mkdtemp directory", () => {
  const material = materializeSshKey(KEY);
  try {
    assert.equal(modeOf(material.keyPath), 0o600, "ssh refuses a group/world-readable identity file");
    assert.equal(modeOf(material.dir), 0o700, "so nothing else in a shared tmpdir can list or replace the key");
    assert.equal(relative(material.dir, material.keyPath).includes("/"), false, "the key lives directly in the private directory");
    assert.equal(readFileSync(material.keyPath, "utf8"), `${KEY}\n`, "one trailing newline, no stray blank lines");
  } finally {
    material.dispose();
  }
});

test("the directory is a fresh mkdtemp in the system tmpdir, never under the agent dir", () => {
  const before = keyDirs();
  const first = materializeSshKey(KEY);
  const second = materializeSshKey(KEY);

  try {
    assert.notEqual(first.dir, second.dir, "a predictable path in a shared tmpdir is a symlink-attack surface");
    assert.equal(relative(tmpdir(), first.dir).startsWith(".."), false, `expected the key under ${tmpdir()}, got ${first.dir}`);
    assert.ok(first.dir.startsWith(join(tmpdir(), SSH_KEY_DIR_PREFIX)));
    assert.equal(first.dir.startsWith(process.env.PI_CODING_AGENT_DIR), false, "the private key must never be plaintext on the persisted volume");
    assert.equal(keyDirs().length, before.length + 2);
  } finally {
    first.dispose();
    second.dispose();
  }
});

test("dispose removes the whole directory, and twice is harmless", () => {
  const material = materializeSshKey(KEY);
  assert.ok(existsSync(material.keyPath));

  material.dispose();

  assert.equal(existsSync(material.dir), false, "the key must not outlive the operation that needed it");
  assert.doesNotThrow(() => material.dispose(), "the abort listener and the finally block both call it");
});

test("an abort disposes the key without anyone calling dispose()", () => {
  const controller = new AbortController();
  const material = materializeSshKey(KEY, { signal: controller.signal });
  assert.ok(existsSync(material.keyPath));

  // The clone route cancels through an AbortController and kills the process
  // group, so `close` on the child can arrive long after — or never. A key that
  // is only removed in a `finally` around the child's exit leaks in exactly that
  // window.
  controller.abort();

  assert.equal(existsSync(material.dir), false, "a cancelled clone must not leave a private key in the tmpdir");
  assert.doesNotThrow(() => material.dispose());
});

test("a signal that is already aborted disposes immediately", () => {
  const controller = new AbortController();
  controller.abort();

  const material = materializeSshKey(KEY, { signal: controller.signal });

  assert.equal(existsSync(material.dir), false);
});

test("a key that cannot authenticate is refused here, and leaves nothing behind", () => {
  const before = keyDirs();
  // A *public* key pasted into the private-key field is the realistic mistake:
  // it loads as an identity and then fails opaquely inside ssh.
  assert.throws(() => materializeSshKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample user@host"), (error) => {
    assert.equal(error.code, "ssh_key_invalid");
    assert.equal(error.message.includes("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample"), false, "the message must not echo key material");
    return true;
  });
  assert.throws(() => materializeSshKey("   \n  "), (error) => error.code === "ssh_key_invalid");

  assert.deepEqual(keyDirs(), before, "a rejected key must not leave a directory behind");
});

test("GIT_SSH_COMMAND names the identity, the shared known_hosts and every flag that forbids a hang", () => {
  const command = buildGitSshCommand({ keyPath: "/tmp/omp-web-ssh-key-abc/id_ed25519", knownHosts: "/home/u/.omp/agent/known_hosts" });

  assert.match(command, /-i "\/tmp\/omp-web-ssh-key-abc\/id_ed25519"/);
  assert.match(command, /-o IdentitiesOnly=yes/, "offer only the stored key, never every key in the agent's default files");
  assert.match(command, /-o PasswordAuthentication=no/);
  // PasswordAuthentication=no says nothing about an ENCRYPTED key: only
  // BatchMode stops ssh from blocking on a passphrase prompt it can never answer.
  assert.match(command, /-o BatchMode=yes/);
  assert.match(command, /-o StrictHostKeyChecking=accept-new/);
  assert.match(command, /-o UserKnownHostsFile="\/home\/u\/\.omp\/agent\/known_hosts"/);

  // The three ways this design could quietly become "trust anything".
  assert.equal(/StrictHostKeyChecking=(no|off)/.test(command), false);
  assert.equal(/StrictHostKeyChecking=yes/.test(command), false, "a changed key must fail, not prompt");
  assert.equal(command.includes("/dev/null"), false, "a discarded known_hosts is the same as trusting every host");
});

test("the command starts with ssh and takes no more than one identity", () => {
  const command = buildGitSshCommand({ keyPath: "/tmp/k/id", knownHosts: "/tmp/kh" });

  assert.ok(command.startsWith("ssh "), `expected an ssh command, got ${command}`);
  assert.equal(command.split(" -i ").length - 1, 1);
  // git appends `git-upload-pack '<host>'`, so the command must not end with a
  // positional argument of its own.
  assert.equal(command.includes("git-upload-pack"), false);
});