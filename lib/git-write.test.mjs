// The write layer runs against real repositories, because every property worth
// pinning here is a property of git rather than of our argv: that a commit takes
// only the paths it was given, that a push with no upstream fails instead of
// inventing one, that `--ff-only` refuses to merge, that git refuses to commit
// without an identity, and — the one that cannot be asserted by reading code —
// that killing the child kills the helpers holding its output pipes.
//
// The fake `git` on PATH appears only where a real remote would need the network
// or would finish too fast to cancel: the credential environment and the abort.
// Everything else is the real binary.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@/": repoRoot } });
const { commit, pull, push, stage } = await jiti.import("./git-write.ts");
const { clearDefaultGitIdentity, invalidateGitIdentityCache, saveDefaultGitIdentity } = await jiti.import("./git-identity.ts");
const { GIT_CREDENTIAL_FILE, saveGitCredential } = await jiti.import("./git-credentials.ts");
const { SSH_KEY_DIR_PREFIX } = await jiti.import("./ssh-key-material.ts");
const { invalidateSessionListCache } = await jiti.import("./session-reader.ts");

const POSIX = { skip: process.platform === "win32" ? "POSIX shell shim" : false };

/** An identity that exists, and one that git will refuse. Both are expressed
 *  through the environment because that is the only channel the child has: git
 *  reads GIT_AUTHOR_* as config, so an empty value overrides any user.name in a
 *  ~/.gitconfig and lands on the "empty ident" failure on every machine. */
const IDENT = {
  GIT_AUTHOR_NAME: "Test User",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test User",
  GIT_COMMITTER_EMAIL: "test@example.com",
};
const NO_IDENT = {
  GIT_AUTHOR_NAME: "",
  GIT_AUTHOR_EMAIL: "",
  GIT_COMMITTER_NAME: "",
  GIT_COMMITTER_EMAIL: "",
};

/** Ambient git variables this container exports for its own reasons (a real
 *  GIT_CONFIG_COUNT/KEY_0/VALUE_0 pair and a GIT_SSH_COMMAND), plus the identity
 *  pair. hostChildEnv keeps all of them, so any assertion about what the child
 *  received is only meaningful once they are out of the way. */
const AMBIENT = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_SSH_COMMAND",
  "FAKE_GIT_PUSH",
];

let root;
let restored = new Map();
let originalTmpDir;
let originalAgentDir;

before(() => {
  root = mkdtempSync(join(tmpdir(), "omp-web-git-write-"));
  // A private tmpdir so "no private key was left behind" can scan it; a private
  // agent dir so the credential and identity stores are this run's own.
  originalTmpDir = process.env.TMPDIR;
  process.env.TMPDIR = join(root, "tmp");
  mkdirSync(process.env.TMPDIR, { recursive: true });
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  for (const name of AMBIENT) {
    if (!(name in process.env)) continue;
    restored.set(name, process.env[name]);
    delete process.env[name];
  }
});

after(() => {
  for (const [name, value] of restored) process.env[name] = value;
  if (originalTmpDir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpDir;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  invalidateSessionListCache();
  rmSync(root, { recursive: true, force: true });
});

/** Sets variables for one test and puts the previous values back afterwards. */
function setEnv(t, values) {
  const names = Object.keys(values);
  const previous = names.map((name) => [name, process.env[name]]);
  for (const name of names) {
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

/** Real git, for setting a repository up. Never for the behaviour under test. */
function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...IDENT },
  });
}

function gitLines(cwd, args) {
  return git(cwd, args).split("\n").filter(Boolean);
}

/** base / work / bare, with one commit on main. `remote` is how the bare remote
 *  is attached: "pushed" (default) tracks it, "unpushed" configures origin but
 *  leaves the branch without an upstream, "none" has no remote at all. */
function makeRepo(t, { remote = "pushed", bare = true } = {}) {
  const base = mkdtempSync(join(root, "case-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const remotePath = join(base, "remote.git");
  const work = join(base, "work");
  if (bare) git(base, ["init", "--bare", "-b", "main", remotePath]);
  git(base, ["init", "-b", "main", work]);
  writeFileSync(join(work, "a.txt"), "a\n");
  writeFileSync(join(work, "b.txt"), "b\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-m", "init"]);
  if (remote === "pushed") {
    git(work, ["remote", "add", "origin", remotePath]);
    git(work, ["push", "-u", "origin", "main"]);
  } else if (remote === "unpushed") {
    git(work, ["remote", "add", "origin", remotePath]);
  }
  return { base, work, bare: remotePath };
}

/** Points the branch at an `origin` it cannot actually reach, without pushing:
 *  the tracking ref and the two config keys are all `%(upstream:remotename)`
 *  and `remote get-url` read. */
function trackFakeOrigin(cwd, url) {
  git(cwd, ["remote", "add", "origin", url]);
  git(cwd, ["config", "branch.main.remote", "origin"]);
  git(cwd, ["config", "branch.main.merge", "refs/heads/main"]);
  git(cwd, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
}

function rejectsWithCode(promise, code) {
  return promise.then(
    () => assert.fail(`expected ${code}, the call resolved`),
    (error) => {
      assert.equal(error.code, code, `expected ${code}, got ${error.code ?? error.message}: ${error.message}`);
      return error;
    },
  );
}

/** A `git` earlier on PATH that records its argv and environment, passes every
 *  other subcommand to the real binary, and hangs `push` while holding its
 *  output pipes open with a background child — the shape of a real push, where
 *  an ssh helper outlives git unless the whole process group is signalled. */
function installFakeGit(t) {
  const dir = mkdtempSync(join(root, "shim-"));
  const argvPath = join(dir, "argv");
  const envPath = join(dir, "env");
  const grandchildPath = join(dir, "grandchild");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const shim = join(dir, "git");
  writeFileSync(shim, [
    "#!/bin/sh",
    `for arg in "$@"; do printf '%s\\n' "$arg" >> "${argvPath}"; done`,
    `printf -- '---\\n' >> "${argvPath}"`,
    `env > "${envPath}"`,
    // -C <cwd> comes first, so the subcommand is the third argument.
    'if [ -n "$FAKE_GIT_PUSH" ] && [ "$3" = "push" ]; then',
    '  if [ "$FAKE_GIT_PUSH" = "hang" ]; then',
    '    sh -c "sleep 30" &',
    `    printf '%s\\n' "$!" > "${grandchildPath}"`,
    "    sleep 30",
    "    exit 0",
    "  fi",
    '  if [ "$FAKE_GIT_PUSH" = "fail" ]; then',
    "    printf 'fatal: could not read from remote repository\\n' >&2",
    "    exit 128",
    "  fi",
    '  printf \'push: %s\\n\' "$*"',
    "  exit 0",
    "fi",
    `exec "${realGit}" "$@"`,
    "",
  ].join("\n"), "utf8");
  chmodSync(shim, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  return {
    dir,
    /** Every invocation, in order — the setup ones included, because a shim
     *  earlier on PATH also serves the fixture's own `git init`. */
    calls() {
      if (!existsSync(argvPath)) return [];
      return readFileSync(argvPath, "utf8")
        .split("\n---\n")
        .map((block) => block.split("\n").filter(Boolean))
        .filter((block) => block.length > 0);
    },
    /** The operation's own invocation: the last one, which is always ours. */
    lastCall() {
      const calls = this.calls();
      return calls.at(-1) ?? null;
    },
    subcommands() {
      // -C <cwd> comes first, so the subcommand is the third argument.
      return this.calls().map((call) => call[2]);
    },
    env() {
      if (!existsSync(envPath)) return null;
      const environment = {};
      for (const line of readFileSync(envPath, "utf8").split("\n")) {
        const separator = line.indexOf("=");
        if (separator > 0) environment[line.slice(0, separator)] = line.slice(separator + 1);
      }
      return environment;
    },
    grandchildPid() {
      return existsSync(grandchildPath) ? Number(readFileSync(grandchildPath, "utf8").trim()) : null;
    },
  };
}

async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** No throwaway ssh key directory from this run or any earlier one. */
function leftoverKeyDirs() {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(SSH_KEY_DIR_PREFIX));
}

const OCTOCAT = { name: "octocat", host: "github.com", account: "octocat", type: "pat", token: "ghp_write_token" };
const SSH_CREDENTIAL = {
  name: "octocat ssh",
  host: "github.com",
  account: "octocat",
  type: "ssh",
  privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
};

/** Replaces both stores with exactly these records. */
function storeCredentials(records) {
  rmSync(join(process.env.PI_CODING_AGENT_DIR, GIT_CREDENTIAL_FILE), { force: true });
  for (const record of records) saveGitCredential(record);
}

// ---------------------------------------------------------------------------
// stage + commit
// ---------------------------------------------------------------------------

test("a commit takes only the ticked files, and an unticked file stays staged but uncommitted", async (t) => {
  setEnv(t, IDENT);
  const { work } = makeRepo(t);
  writeFileSync(join(work, "a.txt"), "a2\n");
  writeFileSync(join(work, "b.txt"), "b2\n");
  writeFileSync(join(work, "c.txt"), "c\n");

  await stage(work, [join(work, "a.txt"), join(work, "b.txt")]);
  assert.deepEqual(gitLines(work, ["diff", "--cached", "--name-only"]), ["a.txt", "b.txt"]);

  await commit(work, { message: "only a", paths: [join(work, "a.txt")] });

  assert.deepEqual(gitLines(work, ["show", "--name-only", "--format=", "HEAD"]), ["a.txt"]);
  assert.deepEqual(
    gitLines(work, ["diff", "--cached", "--name-only"]),
    ["b.txt"],
    "b was staged but not ticked, so it must stay staged and uncommitted",
  );
  assert.deepEqual(gitLines(work, ["ls-files", "--others", "--exclude-standard"]), ["c.txt"], "an untouched file is not staged either");
});

test("neither operation has an everything form, because both would escape the session", async (t) => {
  setEnv(t, IDENT);
  const { work } = makeRepo(t);
  writeFileSync(join(work, "a.txt"), "a2\n");

  // `git add -A` with no pathspec stages the whole tree (git ≥ 2.0), and a bare
  // `git commit` takes the whole index — which can hold a file this session was
  // never shown. Both must be asked for by name instead.
  // `paths: []` is what the route sends for a request that named none, so it is
  // the shape a caller can actually produce.
  await rejectsWithCode(stage(work, []), "path_required");
  await rejectsWithCode(commit(work, { message: "everything", paths: [] }), "path_required");
  await rejectsWithCode(stage(work, [join(work, "a.txt"), "   "]), "path_required");
  assert.deepEqual(gitLines(work, ["diff", "--cached", "--name-only"]), [], "nothing may be staged");
  assert.deepEqual(gitLines(work, ["log", "--format=%s"]), ["init"], "and nothing may be committed");
});

test("a file outside the session's own directory is refused, even inside the repository", async (t) => {
  setEnv(t, IDENT);
  const { work } = makeRepo(t);
  const session = join(work, "pkg");
  mkdirSync(session);
  writeFileSync(join(work, "a.txt"), "changed\n");
  writeFileSync(join(session, "s.txt"), "s\n");

  // getGitStatus filters the status list to the session's subtree, so a session
  // rooted in a subdirectory only ever sees (and may only ever commit) its own.
  const error = await rejectsWithCode(stage(session, [join(work, "a.txt")]), "path_outside_repository");
  await rejectsWithCode(commit(session, { message: "sneaky", paths: [join(work, "a.txt")] }), "path_outside_repository");
  assert.match(error.message, /outside/i);

  assert.deepEqual(gitLines(work, ["diff", "--cached", "--name-only"]), [], "nothing may be staged");
  assert.deepEqual(gitLines(work, ["log", "--format=%s", "-1"]), ["init"], "and nothing may be committed");
});

test("a file outside the repository is refused", async (t) => {
  setEnv(t, IDENT);
  const { base, work } = makeRepo(t);
  const outside = join(base, "outside.txt");
  writeFileSync(outside, "not ours\n");

  await rejectsWithCode(stage(work, [outside]), "path_outside_repository");
  await rejectsWithCode(commit(work, { message: "sneaky", paths: [outside] }), "path_outside_repository");
  assert.deepEqual(gitLines(work, ["diff", "--cached", "--name-only"]), []);
});

test("a commit needs a message", async (t) => {
  setEnv(t, IDENT);
  const { work } = makeRepo(t);
  await rejectsWithCode(commit(work, { message: "   " }), "commit_message_required");
  assert.deepEqual(gitLines(work, ["log", "--format=%s"]), ["init"]);
});

test("a commit with no identity available is a coded error, not git's own wording", async (t) => {
  setEnv(t, NO_IDENT);
  const { work } = makeRepo(t);
  writeFileSync(join(work, "a.txt"), "x\n");
  await stage(work, [join(work, "a.txt")]);

  const error = await rejectsWithCode(commit(work, { message: "no ident", paths: [join(work, "a.txt")] }), "git_no_identity");
  assert.equal(
    /empty ident|auto-detect|Please tell me who you are/i.test(error.message),
    false,
    `the answer must be our own message, not git's stderr: ${error.message}`,
  );
  assert.deepEqual(gitLines(work, ["log", "--format=%s"]), ["init"], "and nothing may be committed");
});

test("a directory that is not a repository is refused before any path is judged", async (t) => {
  setEnv(t, IDENT);
  const base = mkdtempSync(join(root, "plain-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const file = join(base, "note.txt");
  writeFileSync(file, "hi\n");
  await rejectsWithCode(stage(base, [file]), "not_a_git_repository");
});

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

test("push sends the branch to the remote git already knows about", async (t) => {
  setEnv(t, IDENT);
  const { work, bare } = makeRepo(t);
  writeFileSync(join(work, "a.txt"), "pushed\n");
  await stage(work, [join(work, "a.txt")]);
  await commit(work, { message: "pushed", paths: [join(work, "a.txt")] });

  const result = await push(work);

  assert.equal(result.cancelled, false);
  assert.match(result.output, /main -> main/);
  assert.equal(git(bare, ["rev-parse", "main"]).trim(), git(work, ["rev-parse", "HEAD"]).trim());
});

test("push takes an explicit refspec", async (t) => {
  setEnv(t, IDENT);
  const { work, bare } = makeRepo(t);
  writeFileSync(join(work, "a.txt"), "side\n");
  await stage(work, [join(work, "a.txt")]);
  await commit(work, { message: "side", paths: [join(work, "a.txt")] });

  await push(work, { refspec: "HEAD:refs/heads/side" });

  assert.equal(git(bare, ["rev-parse", "side"]).trim(), git(work, ["rev-parse", "HEAD"]).trim());
});

test("a branch with an origin but no upstream is a coded error, and git is not run", async (t) => {
  setEnv(t, IDENT);
  const { work, bare } = makeRepo(t, { remote: "unpushed" });
  writeFileSync(join(work, "a.txt"), "local\n");
  await stage(work, [join(work, "a.txt")]);
  await commit(work, { message: "local", paths: [join(work, "a.txt")] });

  const error = await rejectsWithCode(push(work), "git_no_upstream");

  assert.equal(error.message.includes("fatal:"), false, `git never ran, so its wording cannot be the answer: ${error.message}`);
  // The remote exists and the branch is the right one, so anything that guessed
  // would have succeeded — this is what distinguishes "refused" from "inferred".
  assert.throws(() => git(bare, ["rev-parse", "--verify", "refs/heads/main"]));
});

test("a repository with no remote at all is the same coded error", async (t) => {
  setEnv(t, IDENT);
  const { work } = makeRepo(t, { remote: "none", bare: false });
  await rejectsWithCode(push(work), "git_no_upstream");
});

test("a branch tracking a remote whose URL is gone is reported, not guessed around", async (t) => {
  setEnv(t, IDENT);
  const { work } = makeRepo(t, { remote: "none", bare: false });
  git(work, ["config", "branch.main.remote", "origin"]);
  git(work, ["config", "branch.main.merge", "refs/heads/main"]);
  await rejectsWithCode(push(work), "git_no_remote");
});

test("a refspec that would be read as a git option is refused", async (t) => {
  setEnv(t, IDENT);
  const { work } = makeRepo(t);
  await rejectsWithCode(push(work, { refspec: "--force" }), "invalid_git_ref");
  await rejectsWithCode(push(work, { refspec: "main\nrefs/heads/other" }), "invalid_git_ref");
});

test("a push git refuses is a coded error that keeps git's own output", async (t) => {
  setEnv(t, IDENT);
  const { work, bare } = makeRepo(t);
  git(work, ["remote", "set-url", "origin", join(bare, "does-not-exist.git")]);

  const error = await rejectsWithCode(push(work), "git_write_failed");

  assert.match(error.message, /does-not-exist/, `git's own words are the only useful part here: ${error.message}`);
});

test("aborting a push kills the whole process group and leaves no child behind", POSIX, async (t) => {
  setEnv(t, IDENT);
  const fake = installFakeGit(t);
  const { work } = makeRepo(t);
  setEnv(t, { FAKE_GIT_PUSH: "hang" });

  const controller = new AbortController();
  const pending = push(work, {}, { signal: controller.signal });
  await waitFor(() => fake.grandchildPid() !== null, "the fake git never ran");
  const grandchild = fake.grandchildPid();
  assert.equal(isAlive(grandchild), true, "the helper holding the pipes should be running");

  controller.abort();
  const settled = await Promise.race([
    pending.then((result) => ({ result }), (error) => ({ error })),
    delay(10_000).then(() => ({ timeout: true })),
  ]);

  assert.equal(settled.timeout, undefined, "the push never finished: something was still holding the output pipes");
  assert.equal(settled.error, undefined, settled.error && String(settled.error));
  assert.equal(settled.result.cancelled, true, "a killed push is a cancellation, not a failure");
  await waitFor(() => !isAlive(grandchild), "the helper survived: git was killed alone instead of its process group");
});

// ---------------------------------------------------------------------------
// pull
// ---------------------------------------------------------------------------

test("pull fast-forwards the branch from the remote it tracks", async (t) => {
  setEnv(t, IDENT);
  const { base, work, bare } = makeRepo(t);
  const other = join(base, "other");
  git(base, ["clone", "--branch", "main", bare, other]);
  writeFileSync(join(other, "d.txt"), "d\n");
  git(other, ["add", "-A"]);
  git(other, ["commit", "-m", "upstream"]);
  git(other, ["push", "origin", "main"]);
  const before = git(work, ["rev-parse", "HEAD"]).trim();

  const result = await pull(work);

  assert.equal(result.cancelled, false);
  assert.notEqual(git(work, ["rev-parse", "HEAD"]).trim(), before, "the branch moved");
  assert.equal(existsSync(join(work, "d.txt")), true, "and it moved onto the remote's tip");
  assert.deepEqual(gitLines(work, ["log", "--format=%s"]), ["upstream", "init"]);
});

test("a pull that would need a merge is reported as its own code and merges nothing", async (t) => {
  setEnv(t, IDENT);
  const { base, work, bare } = makeRepo(t);
  const other = join(base, "other");
  git(base, ["clone", "--branch", "main", bare, other]);
  writeFileSync(join(other, "d.txt"), "d\n");
  git(other, ["add", "-A"]);
  git(other, ["commit", "-m", "upstream"]);
  git(other, ["push", "origin", "main"]);
  writeFileSync(join(work, "local.txt"), "local\n");
  await stage(work, [join(work, "local.txt")]);
  await commit(work, { message: "local", paths: [join(work, "local.txt")] });

  const error = await rejectsWithCode(pull(work), "git_not_fast_forward");

  assert.equal(/fast-forward/i.test(error.message), false, error.message);
  assert.deepEqual(gitLines(work, ["log", "--format=%s"]), ["local", "init"], "no merge commit was created");
  assert.equal(existsSync(join(work, "d.txt")), false, "and the remote's commit is not in the tree");
});

// ---------------------------------------------------------------------------
// What the child actually receives
// ---------------------------------------------------------------------------

test("a push reaches the network carrying the identity and exactly one credential, and neither in argv", POSIX, async (t) => {
  setEnv(t, IDENT);
  const fake = installFakeGit(t);
  storeCredentials([
    { name: "some other account", host: "github.com", account: "other", type: "pat", token: "ghp_other_token" },
    OCTOCAT,
  ]);
  saveDefaultGitIdentity({ name: "Store Identity", email: "store@example.com" });
  invalidateGitIdentityCache();
  t.after(() => {
    rmSync(join(process.env.PI_CODING_AGENT_DIR, GIT_CREDENTIAL_FILE), { force: true });
    clearDefaultGitIdentity();
    invalidateGitIdentityCache();
  });
  const { work } = makeRepo(t, { remote: "none", bare: false });
  setEnv(t, { FAKE_GIT_PUSH: "stub" });
  // An https remote the store can answer for, tracked without a real push.
  trackFakeOrigin(work, "https://github.com/octocat/repo.git");

  const result = await push(work);

  assert.equal(result.cancelled, false);
  const environment = fake.env();
  assert.equal(environment.LC_ALL, "C", "git's message locale is pinned so error matching is stable");
  assert.equal(environment.GIT_AUTHOR_NAME, "Store Identity", "the stored identity beats an inherited one");
  assert.equal(environment.GIT_AUTHOR_EMAIL, "store@example.com");
  assert.equal(environment.GIT_COMMITTER_NAME, "Store Identity");
  assert.equal(environment.GIT_COMMITTER_EMAIL, "store@example.com");

  const encoded = Buffer.from("x-access-token:ghp_write_token", "utf8").toString("base64");
  assert.equal(environment.GIT_CONFIG_COUNT, "1");
  assert.equal(environment.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
  assert.equal(environment.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${encoded}`);
  const carrying = Object.entries(environment).filter(([, value]) => value.includes(encoded) || value.includes("ghp_write_token"));
  assert.deepEqual(carrying.map(([name]) => name), ["GIT_CONFIG_VALUE_0"], "exactly one credential per child");

  const argv = fake.lastCall();
  assert.equal(argv.includes("ghp_write_token"), false, `the token must never be in argv: ${argv.join(" ")}`);
  assert.ok(argv.includes("--"), `option parsing must be terminated: ${argv.join(" ")}`);
  assert.ok(argv.lastIndexOf("--") < argv.indexOf("origin"), "the remote is a positional, after --");

  // The credential replaces git's prompt; it must not re-open one.
  assert.equal(environment.GIT_TERMINAL_PROMPT, "0");
  assert.equal(environment.GIT_ASKPASS, "");
});

test("with no stored credential a push adds nothing that could authenticate it", POSIX, async (t) => {
  setEnv(t, IDENT);
  const fake = installFakeGit(t);
  storeCredentials([]);
  t.after(() => rmSync(join(process.env.PI_CODING_AGENT_DIR, GIT_CREDENTIAL_FILE), { force: true }));
  const { work } = makeRepo(t, { remote: "none", bare: false });
  setEnv(t, { FAKE_GIT_PUSH: "stub" });
  trackFakeOrigin(work, "https://github.com/octocat/repo.git");

  await push(work);

  const environment = fake.env();
  assert.deepEqual(Object.keys(environment).filter((name) => name.startsWith("GIT_CONFIG")), []);
  assert.equal(environment.GIT_SSH_COMMAND, undefined);
});

test("stage and commit never carry a credential, because they contact nothing", POSIX, async (t) => {
  setEnv(t, IDENT);
  const fake = installFakeGit(t);
  storeCredentials([OCTOCAT]);
  t.after(() => rmSync(join(process.env.PI_CODING_AGENT_DIR, GIT_CREDENTIAL_FILE), { force: true }));
  const { work } = makeRepo(t, { remote: "none", bare: false });
  setEnv(t, { FAKE_GIT_PUSH: "stub" });
  trackFakeOrigin(work, "https://github.com/octocat/repo.git");
  writeFileSync(join(work, "a.txt"), "changed\n");
  // The default identity is the only one in the store, so "the identity is always
  // delivered" is asserted against it rather than against the ambient pair.

  await stage(work, [join(work, "a.txt")]);
  await commit(work, { message: "no network", paths: [join(work, "a.txt")] });

  const environment = fake.env();
  assert.deepEqual(Object.keys(environment).filter((name) => name.startsWith("GIT_CONFIG")), []);
  assert.equal(environment.GIT_AUTHOR_NAME, "Test User", "but the identity is always there");
});

test("an aborted push removes a staged ssh key even though git was killed by group signal", POSIX, async (t) => {
  setEnv(t, IDENT);
  const fake = installFakeGit(t);
  storeCredentials([SSH_CREDENTIAL]);
  const before = leftoverKeyDirs();
  t.after(() => rmSync(join(process.env.PI_CODING_AGENT_DIR, GIT_CREDENTIAL_FILE), { force: true }));
  const { work } = makeRepo(t, { remote: "none", bare: false });
  setEnv(t, { FAKE_GIT_PUSH: "hang" });
  trackFakeOrigin(work, "git@github.com:octocat/repo.git");

  const controller = new AbortController();
  const pending = push(work, {}, { signal: controller.signal });
  await waitFor(() => fake.env()?.GIT_SSH_COMMAND !== undefined, "the push never carried a key");
  controller.abort();
  const settled = await Promise.race([
    pending.then((result) => ({ result }), (error) => ({ error })),
    delay(10_000).then(() => ({ timeout: true })),
  ]);

  assert.equal(settled.timeout, undefined);
  assert.equal(settled.error, undefined, settled.error && String(settled.error));
  assert.deepEqual(leftoverKeyDirs(), before, "an aborted push must not leave a private key in the tmpdir");
});

test("a failed push removes a staged ssh key, which nothing else would", POSIX, async (t) => {
  setEnv(t, IDENT);
  const fake = installFakeGit(t);
  storeCredentials([SSH_CREDENTIAL]);
  const before = leftoverKeyDirs();
  t.after(() => rmSync(join(process.env.PI_CODING_AGENT_DIR, GIT_CREDENTIAL_FILE), { force: true }));
  const { work } = makeRepo(t, { remote: "none", bare: false });
  setEnv(t, { FAKE_GIT_PUSH: "fail" });
  trackFakeOrigin(work, "git@github.com:octocat/repo.git");

  const error = await rejectsWithCode(push(work), "git_write_failed");

  assert.match(error.message, /could not read from remote repository/);
  assert.match(fake.env().GIT_SSH_COMMAND, /BatchMode=yes/, "a key really was staged for this push");
  // Nothing aborted here, so the abort listener prepareGitCredential installs
  // never fires: this operation's own disposal is the only thing that removes it.
  assert.deepEqual(leftoverKeyDirs(), before, "the key must not outlive the operation that staged it");
});

test("an ambiguous credential store is refused before git runs", POSIX, async (t) => {
  setEnv(t, IDENT);
  const fake = installFakeGit(t);
  storeCredentials([
    { name: "one", host: "github.com", account: "one", type: "pat", token: "ghp_one" },
    { name: "two", host: "github.com", account: "two", type: "pat", token: "ghp_two" },
  ]);
  t.after(() => rmSync(join(process.env.PI_CODING_AGENT_DIR, GIT_CREDENTIAL_FILE), { force: true }));
  const { work } = makeRepo(t, { remote: "none", bare: false });
  setEnv(t, { FAKE_GIT_PUSH: "stub" });
  trackFakeOrigin(work, "https://github.com/octocat/repo.git");

  const error = await rejectsWithCode(push(work), "credential_ambiguous");

  assert.match(error.message, /one/, "the error names the candidates so the user can choose");
  assert.equal(error.message.includes("ghp_"), false, "never a token, not even in the rejection");
  assert.equal(fake.subcommands().includes("push"), false, "no push may start");
});