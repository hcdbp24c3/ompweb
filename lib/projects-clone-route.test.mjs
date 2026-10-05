// `/api/projects/clone` is the only place a user-supplied ref reaches git, and
// nothing else in the repo tests it: the route spawns a real `git`, streams
// NDJSON, and deletes the partial clone itself.
//
// The argv is asserted through a fake `git` earlier on PATH that records its own
// arguments and exits 0, because the interesting property is positional and
// argv is the only place a position exists: `--branch <ref>` must land *before*
// the `--` separator, because after it `--branch` is a repository URL and
// `<ref>` is a directory name. Reading a helper that builds the array could not
// prove the route passes that array to git.
//
// The same shim records its environment and echoes its argv back on stdout, so
// the credential tests can assert where a token does and does not appear: in
// the child's environment and nowhere else — not in argv, not in the URL, not
// in the streamed output the user reads.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { after, before } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@/": new URL("../", import.meta.url).pathname } });
const { POST, DELETE } = await jiti.import("../app/api/projects/clone/route.ts");
const { GIT_CREDENTIAL_FILE, saveGitCredential } = await jiti.import("./git-credentials.ts");
const { SSH_KEY_DIR_PREFIX } = await jiti.import("./ssh-key-material.ts");

const REPO_URL = "https://github.com/octocat/repo.git";
const SSH_REPO_URL = "git@github.com:octocat/repo.git";
let root;
let argvPath;
let envPath;
let sshCommandPath;
let identityPath;
let originalPath;
let originalAgentDir;
let workspaceCount = 0;
let originalTmpDir;
/** Ambient git credential variables (GIT_CONFIG_*, GIT_SSH_COMMAND), removed
 *  and restored around the suite. This container injects both of them itself. */
const ambientGitConfig = [];
const AMBIENT_GIT_CONFIG = /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/;

before(() => {
  root = mkdtempSync(join(tmpdir(), "omp-web-clone-route-"));
  argvPath = join(root, "git-argv.txt");
  envPath = join(root, "git-env.txt");
  sshCommandPath = join(root, "git-ssh-command.txt");
  identityPath = join(root, "git-identity.txt");
  // One argument per line, so an argv holding `--` or an empty string still
  // reads back unambiguously. The last loop echoes argv onto stdout, which the
  // route streams back to the browser as `output` frames. The GIT_SSH_COMMAND
  // branch records the command and what the identity file looked like AT THE
  // TIME GIT RAN, because "the key existed while it was needed and is gone
  // afterwards" cannot be checked after the fact.
  const shim = join(root, "git");
  writeFileSync(
    shim,
    [
      '#!/bin/sh',
      `for arg in "$@"; do printf '%s\\n' "$arg"; done > "${argvPath}"`,
      `env > "${envPath}"`,
      'if [ -n "$GIT_SSH_COMMAND" ]; then',
      `  printf '%s\\n' "$GIT_SSH_COMMAND" > "${sshCommandPath}"`,
      `  key=$(printf '%s\\n' "$GIT_SSH_COMMAND" | sed -n 's/.*-i "\\([^"]*\\)".*/\\1/p')`,
      '  if [ -n "$key" ]; then',
      `    { ls -l "$key"; printf '--- content ---\\n'; cat "$key"; } > "${identityPath}" 2>&1`,
      "  fi",
      "fi",
      'if [ -n "$FAKE_GIT_SLEEP" ]; then sleep "$FAKE_GIT_SLEEP"; fi',
      'for arg in "$@"; do printf \'git: %s\\n\' "$arg"; done',
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(shim, 0o755);
  // Point tmpdir() at a private directory so the "no key was left behind"
  // assertions below can scan it. Test files run in parallel processes, each
  // staging keys of its own; scanning the shared /tmp would make those tests
  // fail for another file's temporary directory. os.tmpdir() reads TMPDIR on
  // every call, so this applies to mkdtemp as well.
  originalTmpDir = process.env.TMPDIR;
  process.env.TMPDIR = join(root, "tmp");
  mkdirSync(process.env.TMPDIR, { recursive: true });
  originalPath = process.env.PATH;
  process.env.PATH = `${root}${delimiter}${originalPath}`;
  // The route resolves credentials from the store, so the tests must not read
  // whatever is in the real ~/.omp on the machine running them.
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  // Some environments (this container among them) inject their own git
  // credentials through GIT_CONFIG_COUNT/KEY_n/VALUE_n, and hostChildEnv keeps
  // them: "no credential was added" is only assertable against a clean start.
  // GIT_SSH_COMMAND is in the same class — it arrives from the image, and
  // "nothing was added" would otherwise be true of somebody else's value.
  for (const name of Object.keys(process.env)) {
    if (!AMBIENT_GIT_CONFIG.test(name) && name !== "GIT_SSH_COMMAND") continue;
    ambientGitConfig.push([name, process.env[name]]);
    delete process.env[name];
  }
});

after(() => {
  process.env.PATH = originalPath;
  if (originalTmpDir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpDir;
  for (const [name, value] of ambientGitConfig) process.env[name] = value;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(root, { recursive: true, force: true });
});

/** A parent directory of its own, so one test's clone cannot 409 another's. */
function workspace() {
  const dir = join(root, `ws-${workspaceCount++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Posts one clone and returns { status, frames, rejection } — `rejection` is
 *  the JSON error body of a 400, `frames` the NDJSON stream of a 200. */
async function clone(parent, payload) {
  const response = await POST(
    new Request("http://localhost/api/projects/clone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent, url: REPO_URL, ...payload }),
    }),
  );
  const text = await response.text();
  const frames = [];
  let rejection = null;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const parsed = JSON.parse(line);
    // A 200 streams one JSON object per line; a 4xx has exactly one such line.
    if (parsed.type) frames.push(parsed);
    else rejection = parsed;
  }
  return { status: response.status, frames, rejection };
}

/** The argv the fake git recorded, or null when it was never spawned. */
function recordedArgv() {
  if (!existsSync(argvPath)) return null;
  const lines = readFileSync(argvPath, "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function clearArgv() {
  rmSync(argvPath, { force: true });
  rmSync(envPath, { force: true });
  rmSync(sshCommandPath, { force: true });
  rmSync(identityPath, { force: true });
}

/** The environment the fake git saw, as a plain object. */
function recordedEnv() {
  if (!existsSync(envPath)) return null;
  const environment = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) environment[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return environment;
}

/** Stores exactly these credentials, replacing whatever was stored before. */
function storeCredentials(records) {
  rmSync(join(process.env.PI_CODING_AGENT_DIR, GIT_CREDENTIAL_FILE), { force: true });
  for (const record of records) saveGitCredential(record);
}

// The recorded argv comes from a POSIX shell shim, so Windows skips rather than
// asserting an argv it cannot produce.
test("a valid ref reaches git as --branch, before the -- separator", { skip: process.platform === "win32" }, async () => {
  clearArgv();
  const parent = workspace();

  const result = await clone(parent, { id: "clone-ref", branch: "release/2.0" });

  assert.equal(result.status, 200);
  assert.equal(result.frames.at(-1).type, "done");
  const argv = recordedArgv();
  const separator = argv.indexOf("--");
  assert.ok(separator > 0, `expected a -- separator in ${JSON.stringify(argv)}`);
  assert.deepEqual(
    argv.slice(0, separator),
    ["clone", "--progress", "--branch", "release/2.0"],
    "--branch and its value must precede --, or git reads them as the URL and the target",
  );
  assert.deepEqual(argv.slice(separator + 1), [REPO_URL, join(parent, "repo")]);
});

test("the ref never changes the target directory, so a second clone of the same URL collides", { skip: process.platform === "win32" }, async () => {
  clearArgv();
  const parent = workspace();

  const first = await clone(parent, { id: "clone-main", branch: "main" });
  assert.equal(first.frames.at(-1).type, "done");
  assert.equal(first.frames.at(-1).path, join(parent, "repo"));
  assert.ok(existsSync(join(parent, "repo")), "the directory name comes from the URL alone");

  // mkdir answered 409 for the second one, which is only reachable when a
  // different ref resolves to the same directory name.
  const second = await clone(parent, { id: "clone-sha", branch: "a1b2c3d" });
  assert.equal(second.status, 409);
  assert.equal(second.rejection.code, "clone_target_exists");
});

test("an omitted ref adds no --branch at all", { skip: process.platform === "win32" }, async () => {
  clearArgv();
  const parent = workspace();

  const result = await clone(parent, { id: "clone-plain" });

  assert.equal(result.frames.at(-1).type, "done");
  const argv = recordedArgv();
  assert.deepEqual(argv, ["clone", "--progress", "--", REPO_URL, join(parent, "repo")]);
  assert.equal(argv.includes("--branch"), false, "an empty --branch would fail the clone instead of taking the default branch");
});

test("an invalid ref is a 400 with a stable code, and no clone is started", async () => {
  clearArgv();
  const parent = workspace();

  for (const [id, branch] of [
    ["clone-opt", "--upload-pack=touch /tmp/pwned"],
    ["clone-dash", "-main"],
    ["clone-space", "a b"],
    ["clone-tab", "a\tb"],
    ["clone-range", "a..b"],
    ["clone-tilde", "a~b"],
    ["clone-caret", "a^b"],
    ["clone-colon", "a:b"],
    ["clone-question", "a?b"],
    ["clone-star", "a*b"],
    ["clone-bracket", "a[b"],
    ["clone-backslash", "a\\b"],
    ["clone-newline", "a\nb"],
  ]) {
    const result = await clone(parent, { id, branch });
    assert.equal(result.status, 400, JSON.stringify(branch));
    assert.equal(result.rejection.code, "invalid_git_ref", JSON.stringify(branch));
  }
  assert.equal(recordedArgv(), null, "no clone may start before the ref is checked");
  assert.deepEqual(readdirSync(parent), [], "and no target directory may be created");
});
// --- credentials ------------------------------------------------------------

const OCTOCAT = { name: "octocat", host: "github.com", account: "octocat", type: "pat", token: "ghp_octocat_token" };
const OTHER = { name: "org default", host: "github.com", account: "some-org", type: "pat", token: "ghp_other_token" };

/** Everything the route must never put a credential into. */
function leakedToken(env, frames) {
  const secrets = ["ghp_octocat_token", "ghp_other_token"].map((token) => ({
    token,
    encoded: Buffer.from(`x-access-token:${token}`, "utf8").toString("base64"),
  }));
  const haystack = JSON.stringify([...frames, recordedArgv() ?? []]);
  for (const { token, encoded } of secrets) {
    for (const [label, value] of [["token", token], ["encoded token", encoded]]) {
      assert.equal(haystack.includes(value), false, `${label} ${value} leaked into argv or the output frames`);
    }
  }
  assert.equal(JSON.stringify(env).includes(secrets[0].token), false, "the token must never be a plain env value");
  return secrets[0].encoded;
}

test("the remote owner's credential reaches git as one extra header in its environment", { skip: process.platform === "win32" }, async () => {
  clearArgv();
  storeCredentials([OTHER, { ...OCTOCAT, isDefaultForHost: false }]);
  const parent = workspace();

  const result = await clone(parent, { id: "clone-owner" });

  assert.equal(result.status, 200);
  assert.equal(result.frames.at(-1).type, "done");
  const env = recordedEnv();
  assert.equal(env.GIT_CONFIG_COUNT, "1");
  assert.equal(env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
  const encoded = leakedToken(env, result.frames);
  assert.equal(
    Buffer.from(env.GIT_CONFIG_VALUE_0.replace("AUTHORIZATION: basic ", ""), "base64").toString("utf8"),
    "x-access-token:ghp_octocat_token",
  );
  // Exactly one credential: git applies extraheader unconditionally, so a second
  // one for the same host would send a second Authorization header.
  const carrying = Object.entries(env).filter(([, value]) => value.includes(encoded));
  assert.deepEqual(carrying.map(([name]) => name), ["GIT_CONFIG_VALUE_0"]);

  // The credential replaces the empty askpass; it must not relax it.
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_ASKPASS, "");
  assert.equal(env.SSH_ASKPASS, "");
  assert.equal(env.GIT_ALLOW_PROTOCOL, "https:ssh");
});

test("the host default is used when the remote's owner has no credential of its own", { skip: process.platform === "win32" }, async () => {
  clearArgv();
  storeCredentials([{ ...OTHER, isDefaultForHost: true }]);
  const parent = workspace();

  const result = await clone(parent, { id: "clone-default" });

  assert.equal(result.frames.at(-1).type, "done");
  const env = recordedEnv();
  assert.equal(
    Buffer.from(env.GIT_CONFIG_VALUE_0.replace("AUTHORIZATION: basic ", ""), "base64").toString("utf8"),
    "x-access-token:ghp_other_token",
  );
});

test("an ambiguous store is refused before git runs and before a directory is created", async () => {
  clearArgv();
  // Neither account is the remote's owner, so the owner rule decides nothing
  // and the host has two candidates with no default between them.
  storeCredentials([OTHER, { ...OCTOCAT, account: "another-org", name: "another org", token: "ghp_third_token" }]);
  const parent = workspace();

  const result = await clone(parent, { id: "clone-ambiguous" });

  assert.equal(result.status, 400);
  assert.equal(result.rejection.code, "credential_ambiguous");
  assert.match(result.rejection.error, /another org/, "the error names the candidates so the user can choose");
  assert.equal(result.rejection.error.includes("ghp_"), false, "never a token, not even in the rejection");
  assert.equal(recordedArgv(), null, "no clone may start");
  assert.deepEqual(readdirSync(parent), [], "and no target directory may be created");
});

test("two credentials for a host are not ambiguous when one matches the remote's owner", { skip: process.platform === "win32" }, async () => {
  clearArgv();
  storeCredentials([OTHER, OCTOCAT]);
  const parent = workspace();

  const result = await clone(parent, { id: "clone-owner-wins" });

  assert.equal(result.frames.at(-1).type, "done");
  const env = recordedEnv();
  assert.equal(
    Buffer.from(env.GIT_CONFIG_VALUE_0.replace("AUTHORIZATION: basic ", ""), "base64").toString("utf8"),
    "x-access-token:ghp_octocat_token",
  );
});

test("with no stored credential the clone environment gains nothing", { skip: process.platform === "win32" }, async () => {
  clearArgv();
  storeCredentials([]);
  const parent = workspace();

  const result = await clone(parent, { id: "clone-anonymous" });

  assert.equal(result.frames.at(-1).type, "done");
  const env = recordedEnv();
  assert.equal(env.GIT_CONFIG_COUNT, undefined);
  assert.deepEqual(Object.keys(env).filter((name) => name.startsWith("GIT_CONFIG")), []);
});

test("the credential variables survive the child env while the host's own secrets do not", { skip: process.platform === "win32" }, async () => {
  clearArgv();
  storeCredentials([OCTOCAT]);
  const parent = workspace();
  const previous = process.env.OMP_WEB_PASSWORD;
  process.env.OMP_WEB_PASSWORD = "web-secret";
  try {
    await clone(parent, { id: "clone-prefix" });
  } finally {
    if (previous === undefined) delete process.env.OMP_WEB_PASSWORD;
    else process.env.OMP_WEB_PASSWORD = previous;
  }

  const env = recordedEnv();
  assert.equal(env.GIT_CONFIG_COUNT, "1", "an OMP_WEB_ name would be deleted before git saw it");
  assert.equal(env.OMP_WEB_PASSWORD, undefined);
});

// --- ssh --------------------------------------------------------------------

const SSH_CREDENTIAL = {
  name: "octocat ssh",
  host: "github.com",
  account: "octocat",
  type: "ssh",
  privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
};
const knownHostsFile = () => join(process.env.PI_CODING_AGENT_DIR, "known_hosts");

/** The `-i` target of the GIT_SSH_COMMAND the fake git recorded. */
function stagedIdentity() {
  if (!existsSync(sshCommandPath)) return null;
  const command = readFileSync(sshCommandPath, "utf8").trim();
  return { command, keyPath: /-i "([^"]+)"/.exec(command)?.[1] ?? "" };
}

/** No leftover throwaway key directories, from this run or any previous one. */
function leftoverKeyDirs() {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(SSH_KEY_DIR_PREFIX));
}

test("an ssh:// remote gets GIT_SSH_COMMAND with a key that existed only for the clone", { skip: process.platform === "win32" }, async () => {
  clearArgv();
  storeCredentials([SSH_CREDENTIAL]);
  const before = leftoverKeyDirs();
  const parent = workspace();

  const result = await clone(parent, { id: "clone-ssh", url: SSH_REPO_URL });

  assert.equal(result.status, 200);
  assert.equal(result.frames.at(-1).type, "done");
  const env = recordedEnv();
  assert.deepEqual(Object.keys(env).filter((name) => name.startsWith("GIT_CONFIG")), [], "an http header means nothing to ssh");
  assert.deepEqual(leftoverKeyDirs(), before, "the throwaway key directory must not outlive the clone");

  const staged = stagedIdentity();
  assert.ok(staged, "git was run without a GIT_SSH_COMMAND");
  assert.match(staged.command, /-o IdentitiesOnly=yes/);
  assert.match(staged.command, /-o PasswordAuthentication=no/);
  assert.match(staged.command, /-o BatchMode=yes/, "a passphrase prompt must fail, never wait");
  assert.match(staged.command, /-o StrictHostKeyChecking=accept-new/);
  assert.ok(staged.command.includes(`-o UserKnownHostsFile="${knownHostsFile()}"`), staged.command);
  assert.equal(env.GIT_SSH_COMMAND, staged.command, "what the test reads back is what the child saw");

  // The shim captured the identity file while git was running, because that
  // state cannot be recovered once the clone is over.
  const identity = readFileSync(identityPath, "utf8");
  assert.match(identity, /^-rw-------/, `expected a 0o600 identity file, got:\n${identity}`);
  assert.ok(identity.includes("-----BEGIN OPENSSH PRIVATE KEY-----"));
  assert.equal(existsSync(staged.keyPath), false, "and it must be gone the moment the clone ends");
  assert.equal(existsSync(knownHostsFile()), true, "host keys accumulate in a file that persists, or accept-new is TOFU every time");
  assert.equal(statSync(knownHostsFile()).mode & 0o777, 0o600);
});

test("cancelling an ssh clone removes the key even though the child was killed by group signal", { skip: process.platform === "win32" }, async () => {
  clearArgv();
  storeCredentials([SSH_CREDENTIAL]);
  const before = leftoverKeyDirs();
  const parent = workspace();

  // FAKE_GIT_SLEEP is not OMP_WEB_-prefixed (that prefix is stripped from every
  // child env), and it is the only way to hold the clone open long enough to
  // cancel it.
  process.env.FAKE_GIT_SLEEP = "10";
  try {
    const response = await POST(new Request("http://localhost/api/projects/clone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "clone-ssh-cancel", parent, url: SSH_REPO_URL }),
    }));
    const reader = response.body.getReader();
    // Wait until the shim has actually run, so the cancel lands mid-clone.
    for (let waited = 0; waited < 100 && !existsSync(sshCommandPath); waited++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(existsSync(sshCommandPath), "the fake git never ran");

    const staged = stagedIdentity();
    assert.equal(existsSync(staged.keyPath), true, "the key is present while the clone is running");

    const cancelled = await DELETE(new Request("http://localhost/api/projects/clone", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "clone-ssh-cancel" }),
    }));
    assert.equal(cancelled.status, 200);

    const frames = [];
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      for (const line of new TextDecoder().decode(chunk.value).split("\n")) {
        if (!line) continue;
        const frame = JSON.parse(line);
        if (frame.type) frames.push(frame);
      }
    }

    assert.equal(frames.at(-1).type, "cancelled");
    assert.equal(existsSync(join(parent, "repo")), false, "the partial clone is removed");
    assert.deepEqual(leftoverKeyDirs(), before, "an aborted clone must not leave a private key in the tmpdir");
  } finally {
    delete process.env.FAKE_GIT_SLEEP;
  }
});

test("with no stored ssh key the clone carries no GIT_SSH_COMMAND at all", { skip: process.platform === "win32" }, async () => {
  clearArgv();
  storeCredentials([{ ...OCTOCAT }]);
  const parent = workspace();

  const result = await clone(parent, { id: "clone-ssh-anonymous", url: SSH_REPO_URL });

  assert.equal(result.status, 200);
  assert.equal(result.frames.at(-1).type, "done");
  const env = recordedEnv();
  assert.equal(env.GIT_SSH_COMMAND, undefined, "a PAT cannot authenticate an ssh remote, so nothing is applied");
  assert.equal(existsSync(sshCommandPath), false);
});

test("a target that already exists is refused without leaving the staged key behind", { skip: process.platform === "win32" }, async () => {
  clearArgv();
  storeCredentials([SSH_CREDENTIAL]);
  const before = leftoverKeyDirs();
  const parent = workspace();

  // The first clone creates the target; the second one collides on mkdir. The
  // credential is staged before that check, so the 409 path is where a key
  // would be dropped — there is no stream to run the finally that removes it.
  const first = await clone(parent, { id: "clone-ssh-409-first", url: SSH_REPO_URL });
  assert.equal(first.frames.at(-1).type, "done");

  const second = await clone(parent, { id: "clone-ssh-409-second", url: SSH_REPO_URL });
  assert.equal(second.status, 409);
  assert.equal(second.rejection.code, "clone_target_exists");
  assert.deepEqual(leftoverKeyDirs(), before, "the refused clone staged a key and never removed it");
});

test("the key and its command never reach argv or the output frames", { skip: process.platform === "win32" }, async () => {
  clearArgv();
  storeCredentials([SSH_CREDENTIAL]);
  const parent = workspace();

  const result = await clone(parent, { id: "clone-ssh-leak", url: SSH_REPO_URL });

  assert.equal(result.status, 200);
  const haystack = JSON.stringify([...result.frames, recordedArgv() ?? []]);
  assert.equal(haystack.includes("BEGIN OPENSSH"), false, "key material in the stream would be readable by anyone watching the clone");
  assert.equal(haystack.includes("b3BlbnNzaC1rZXktdjEAAAAA"), false);
  // The frames are the only thing the browser sees; the command lives in the env.
  assert.equal(JSON.stringify(result.frames).includes("GIT_SSH_COMMAND"), false);
});

test("an inherited GIT_SSH_COMMAND cannot add StrictHostKeyChecking=no to a clone we authenticate", { skip: process.platform === "win32" }, async () => {
  clearArgv();
  storeCredentials([SSH_CREDENTIAL]);
  const parent = workspace();
  // The image this runs in ships exactly such a variable. hostChildEnv keeps it,
  // and that is correct — it is the operator's own configuration, and a clone
  // with no credential has nothing better to say. What must not happen is an
  // inherited `no` surviving INTO a clone we authenticate, because then the
  // known_hosts this task pins would be decorative.
  process.env.GIT_SSH_COMMAND = "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null";
  try {
    const result = await clone(parent, { id: "clone-ssh-inherited", url: SSH_REPO_URL });
    assert.equal(result.status, 200);
  } finally {
    delete process.env.GIT_SSH_COMMAND;
  }

  const command = recordedEnv().GIT_SSH_COMMAND;
  assert.equal(/StrictHostKeyChecking=no/.test(command), false, command);
  assert.equal(command.includes("/dev/null"), false, command);
  assert.match(command, /-o StrictHostKeyChecking=accept-new/);
  assert.match(command, /-o BatchMode=yes/);
});
