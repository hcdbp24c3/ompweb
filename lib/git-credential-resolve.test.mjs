// Which stored credential a remote fetch gets, and how it reaches git.
//
// The whole point of the feature is that `github.com/user1/repo1` uses token1
// and `github.com/user2/repo2` uses token2 — so these tests drive selection
// from real remote URLs, not from a pre-chosen credential, and they check the
// three outcomes the design allows (owner match, host default, explicit
// ambiguity) plus the properties that make the mechanism safe: the token is in
// the child environment only, exactly once, and never under a name that
// hostChildEnv() would delete.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@/": repoRoot } });
const {
  AmbiguousGitCredentialError,
  parseRemote,
  pickRemoteUrl,
  prepareGitCredential,
  resolveCredential,
} = await jiti.import("./git-credential-resolve.ts");
const { hostChildEnv } = await jiti.import("./project-command-env.ts");
const { knownHostsPath } = await jiti.import("./ssh-known-hosts.ts");

// Test files run in parallel processes and several of them stage ssh keys in
// tmpdir(); the leak assertions further down scan it, so this file gets its own.
let scratchRoot;
let originalTmpDir;
before(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), "omp-web-resolve-test-"));
  originalTmpDir = process.env.TMPDIR;
  process.env.TMPDIR = join(scratchRoot, "tmp");
  mkdirSync(process.env.TMPDIR, { recursive: true });
});
after(() => {
  if (originalTmpDir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpDir;
  rmSync(scratchRoot, { recursive: true, force: true });
});

/** A decrypted PAT record — the shape `loadGitCredentials()` returns server-side. */
function pat(overrides = {}) {
  return {
    id: "cred-user1",
    name: "user1 personal",
    host: "github.com",
    account: "user1",
    type: "pat",
    isDefaultForHost: false,
    hasToken: true,
    hasPrivateKey: false,
    hasPassphrase: false,
    token: "ghp_token_one",
    ...overrides,
  };
}

function ssh(overrides = {}) {
  return {
    id: "cred-ssh",
    name: "user1 ssh",
    host: "github.com",
    account: "user1",
    type: "ssh",
    isDefaultForHost: false,
    hasToken: false,
    hasPrivateKey: true,
    hasPassphrase: false,
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
    ...overrides,
  };
}

const USER1 = pat();
const USER2 = pat({ id: "cred-user2", name: "user2 org", account: "user2", token: "ghp_token_two" });
const SSH1 = ssh();

// ---------------------------------------------------------------------------
// parseRemote
// ---------------------------------------------------------------------------

test("parses an https, ssh:// and scp-like remote into host, owner and repo", () => {
  assert.deepEqual(parseRemote("https://github.com/user1/repo1.git"), {
    host: "github.com",
    owner: "user1",
    repo: "repo1",
    transport: "https",
  });
  assert.deepEqual(parseRemote("  https://github.com/user1/repo1/  "), {
    host: "github.com",
    owner: "user1",
    repo: "repo1",
    transport: "https",
  });
  assert.deepEqual(parseRemote("ssh://git@github.com/user2/repo2.git"), {
    host: "github.com",
    owner: "user2",
    repo: "repo2",
    transport: "ssh",
  });
  assert.deepEqual(parseRemote("git@github.com:user3/repo3.git"), {
    host: "github.com",
    owner: "user3",
    repo: "repo3",
    transport: "ssh",
  });
  assert.deepEqual(parseRemote("https://user:token@gitlab.example.com/group/sub/repo.git"), {
    host: "gitlab.example.com",
    owner: "group",
    repo: "sub",
    transport: "https",
  });
});

test("the host keeps its port, lowercased, and never the userinfo", () => {
  assert.equal(parseRemote("ssh://git@GitHub.com:2222/srv/git/repo.git").host, "github.com:2222");
  assert.equal(parseRemote("git@host.example.com:srv/repo.git").host, "host.example.com");
  assert.equal(parseRemote("https://user:pw@github.com/user1/repo1.git").host, "github.com");
});

test("a nested group path contributes its first segment as the owner", () => {
  assert.deepEqual(parseRemote("https://github.com/org/team/repo"), {
    host: "github.com",
    owner: "org",
    repo: "team",
    transport: "https",
  });
});

test("refuses any transport the clone route would refuse", () => {
  for (const url of [
    "",
    "file:///tmp/repo",
    "ext::sh -c 'touch /tmp/pwned'",
    "--upload-pack=touch /tmp/pwned",
    "/tmp/repo",
    "C:\\repos\\repo",
    "http://github.com/user1/repo1.git",
    "https://github.com/",
  ]) {
    assert.equal(parseRemote(url), null, url);
  }
});

test("a URL with no path is refused, so every remote that resolves has an owner", () => {
  // https://github.com and ssh://git@host:2222/ are both refused here, exactly
  // as they are by the clone route. An owner-less remote therefore cannot reach
  // the host default by accident.
  assert.equal(parseRemote("https://github.com"), null);
  assert.equal(parseRemote("ssh://git@host.example.com:2222/"), null);
  assert.equal(parseRemote("git@host.example.com:"), null);
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

test("github.com/user1/repo1 uses the user1 credential and user2/repo2 uses user2's", async () => {
  const credentials = [USER1, pat({ ...USER2, isDefaultForHost: false })];

  const first = await resolveCredential({ url: "https://github.com/user1/repo1.git", credentials });
  const second = await resolveCredential({ url: "https://github.com/user2/repo2.git", credentials });

  assert.equal(first.credential.token, "ghp_token_one");
  assert.equal(first.via, "owner");
  assert.equal(second.credential.token, "ghp_token_two");
  assert.equal(second.via, "owner");
  // An owner match wins even when the other credential is the host default.
  assert.deepEqual(await resolveCredential({ url: "https://github.com/user1/repo1.git", credentials: [USER1, { ...USER2, isDefaultForHost: true }] }), first);
});

test("a nested group path matches on its first owner segment", async () => {
  const resolved = await resolveCredential({
    url: "https://github.com/org/team/repo",
    credentials: [USER1, pat({ ...USER2, account: "org", id: "cred-org", token: "ghp_token_org" })],
  });

  assert.equal(resolved.credential.token, "ghp_token_org");
  assert.equal(resolved.via, "owner");
});

test("the account comparison ignores case, because the host does too", async () => {
  // A second credential that IS the host default, so falling through to the
  // default rule would answer with the wrong token rather than the same one.
  const resolved = await resolveCredential({
    url: "https://github.com/User1/repo1",
    credentials: [USER1, { ...USER2, isDefaultForHost: true }],
  });

  assert.equal(resolved.credential.token, "ghp_token_one");
  assert.equal(resolved.via, "owner");
});

test("an owner that matches nothing falls back to the host default", async () => {
  const resolved = await resolveCredential({
    url: "https://github.com/someone-else/repo",
    credentials: [USER1, { ...USER2, isDefaultForHost: true }],
  });

  assert.equal(resolved.credential.token, "ghp_token_two");
  assert.equal(resolved.via, "host-default");
});

test("a lone credential for the host is used even without a default flag", async () => {
  const resolved = await resolveCredential({ url: "https://github.com/someone-else/repo", credentials: [USER1] });

  assert.equal(resolved.credential.token, "ghp_token_one");
  assert.equal(resolved.via, "host-only");
});

test("several credentials for one host with no default is an explicit error, never array order", async () => {
  const credentials = [USER1, USER2];
  const reversed = [USER2, USER1];

  for (const list of [credentials, reversed]) {
    await assert.rejects(
      () => resolveCredential({ url: "https://github.com/someone-else/repo", credentials: list }),
      (error) => {
        assert.ok(error instanceof AmbiguousGitCredentialError);
        assert.equal(error.code, "credential_ambiguous");
        assert.equal(error.host, "github.com");
        // Names, so the user can act; never a token.
        assert.deepEqual([...error.candidates].sort(), ["user1 personal", "user2 org"]);
        assert.equal(error.message.includes("ghp_"), false);
        return true;
      },
      JSON.stringify(list.map((item) => item.name)),
    );
  }
});

test("a credential on another host is never a candidate", async () => {
  const resolved = await resolveCredential({
    url: "https://github.com/user1/repo1.git",
    credentials: [USER1, pat({ ...USER2, host: "gitlab.example.com" })],
  });

  assert.equal(resolved.credential.token, "ghp_token_one");
});

test("no credential for the host resolves to nothing rather than to a guess", async () => {
  assert.equal(await resolveCredential({ url: "https://gitlab.example.com/user1/repo1.git", credentials: [USER1] }), null);
  assert.equal(await resolveCredential({ url: "https://github.com/user1/repo1.git", credentials: [] }), null);
  // An unsupported transport is not answered with a token.
  assert.equal(await resolveCredential({ url: "file:///tmp/repo", credentials: [USER1] }), null);
});

test("an ssh credential is not a candidate for an http header, even as the host default", async () => {
  const withSshDefault = await resolveCredential({
    url: "https://github.com/user1/repo1.git",
    credentials: [USER1, { ...ssh(), isDefaultForHost: true }],
  });
  assert.equal(withSshDefault.credential.token, "ghp_token_one");

  assert.equal(await resolveCredential({ url: "https://github.com/user1/repo1.git", credentials: [ssh()] }), null);
});

test("a PAT whose token cannot be read is not a candidate either", async () => {
  // A missing key file leaves the record visible with hasToken true and no token.
  const unreadable = { ...USER1, token: undefined };
  assert.equal(await resolveCredential({ url: "https://github.com/user1/repo1.git", credentials: [unreadable] }), null);
  // …and it must not make the *other* credential ambiguous.
  const resolved = await resolveCredential({ url: "https://github.com/user2/repo2.git", credentials: [unreadable, USER2] });
  assert.equal(resolved.credential.token, "ghp_token_two");
});

// ---------------------------------------------------------------------------
// SSH selection — a PAT can never authenticate an ssh:// remote and an ssh key
// can never become an http header, so candidacy is transport-aware.
// ---------------------------------------------------------------------------

test("an ssh:// remote is served by the ssh credential, by owner and then by host", async () => {
  const first = await resolveCredential({ url: "git@github.com:user1/repo1.git", credentials: [USER1, SSH1] });
  assert.equal(first.credential.id, "cred-ssh");
  assert.equal(first.via, "owner");
  assert.equal(first.transport, "ssh");

  const second = await resolveCredential({
    url: "ssh://git@github.com/user2/repo2.git",
    credentials: [USER1, SSH1, ssh({ id: "cred-ssh2", name: "user2 ssh", account: "user2" })],
  });
  assert.equal(second.via, "owner");
  assert.equal(second.credential.account, "user2");

  // No owner match: the host default, then the host's only ssh record.
  const byDefault = await resolveCredential({
    url: "git@github.com:someone-else/repo.git",
    credentials: [SSH1, ssh({ id: "cred-ssh2", name: "org ssh", account: "org", isDefaultForHost: true })],
  });
  assert.equal(byDefault.via, "host-default");
  assert.equal(byDefault.credential.name, "org ssh");

  const lone = await resolveCredential({ url: "git@github.com:someone-else/repo.git", credentials: [SSH1] });
  assert.equal(lone.via, "host-only");
});

test("a PAT is not a candidate for an ssh:// remote, even as the host default", async () => {
  const asDefault = await resolveCredential({
    url: "git@github.com:user1/repo1.git",
    credentials: [{ ...USER1, isDefaultForHost: true }, SSH1],
  });
  assert.equal(asDefault.credential.id, "cred-ssh");

  // With nothing that can authenticate, the answer is nothing — never the PAT,
  // which would be handed to git in a form it cannot use.
  assert.equal(await resolveCredential({ url: "git@github.com:user1/repo1.git", credentials: [USER1] }), null);
});

test("an ssh credential whose key cannot be read is not a candidate either", async () => {
  const unreadable = { ...SSH1, privateKey: undefined };
  assert.equal(await resolveCredential({ url: "git@github.com:user1/repo1.git", credentials: [unreadable] }), null);

  const other = ssh({ id: "cred-ssh2", name: "user2 ssh", account: "user2" });
  const resolved = await resolveCredential({ url: "git@github.com:user2/repo2.git", credentials: [unreadable, other] });
  assert.equal(resolved.credential.id, "cred-ssh2");
  assert.equal(resolved.via, "owner");
});

test("two ssh credentials for a host with no default is the same explicit ambiguity", async () => {
  await assert.rejects(
    () => resolveCredential({
      url: "git@github.com:someone-else/repo.git",
      credentials: [SSH1, ssh({ id: "cred-ssh2", name: "user2 ssh", account: "user2" })],
    }),
    (error) => {
      assert.ok(error instanceof AmbiguousGitCredentialError);
      assert.deepEqual([...error.candidates].sort(), ["user1 ssh", "user2 ssh"]);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

test("the token reaches git as exactly one extraheader pair in the child environment", async () => {
  const resolved = await resolveCredential({ url: "https://github.com/user1/repo1.git", credentials: [USER1] });
  const { env, dispose } = prepareGitCredential(resolved);
  try {
    assert.deepEqual(Object.keys(env).sort(), ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]);
    assert.equal(env.GIT_CONFIG_COUNT, "1");
    assert.equal(env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
    assert.match(env.GIT_CONFIG_VALUE_0, /^AUTHORIZATION: basic /);
    const secret = Buffer.from("x-access-token:ghp_token_one", "utf8").toString("base64");
    assert.equal(env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${secret}`);

    // One credential per host, or git picks arbitrarily — so the count is asserted
    // rather than assumed.
    const carrying = Object.entries(env).filter(([, value]) => value.includes(secret));
    assert.deepEqual(carrying.map(([name]) => name), ["GIT_CONFIG_VALUE_0"]);
  } finally {
    dispose();
  }
});

test("a non-GitHub host authenticates as oauth2, and a port is part of the config key", async () => {
  // The port is part of the host it matches against, exactly as git's own URL
  // matching is port-sensitive — so the record has to name it too.
  const gitlab = pat({ host: "gitlab.example.com:8443", account: "org", token: "glpat_secret" });
  const resolved = await resolveCredential({ url: "https://gitlab.example.com:8443/org/repo.git", credentials: [gitlab] });
  const { env } = prepareGitCredential(resolved);

  assert.equal(env.GIT_CONFIG_KEY_0, "http.https://gitlab.example.com:8443/.extraheader");
  assert.equal(
    Buffer.from(env.GIT_CONFIG_VALUE_0.replace("AUTHORIZATION: basic ", ""), "base64").toString("utf8"),
    "oauth2:glpat_secret",
  );
  // …and a record without the port does not match a remote that has one.
  assert.equal(
    await resolveCredential({ url: "https://gitlab.example.com:8443/org/repo.git", credentials: [pat({ host: "gitlab.example.com", account: "org" })] }),
    null,
  );
});

test("nothing resolved means no environment at all", async () => {
  assert.deepEqual(prepareGitCredential(await resolveCredential({ url: "https://gitlab.example.com/o/r", credentials: [USER1] })).env, {});
  assert.deepEqual(prepareGitCredential(null).env, {});
  // A credential with nothing to deliver stages nothing, and disposing it must
  // still be safe: callers dispose unconditionally.
  assert.doesNotThrow(() => prepareGitCredential(null).dispose());
});

test("hostChildEnv keeps the credential variables and drops the OMP_WEB_ prefix", async () => {
  const resolved = await resolveCredential({ url: "https://github.com/user1/repo1.git", credentials: [USER1] });
  const { env } = prepareGitCredential(resolved);
  // The name must never be OMP_WEB_*: hostChildEnv() deletes that whole prefix,
  // so the token would be deleted before git ever saw it.
  assert.equal(Object.keys(env).some((name) => name.startsWith("OMP_WEB_")), false);

  const merged = hostChildEnv(
    { ...env, OMP_WEB_PASSWORD: "web-secret" },
    { OMP_WEB_PASSWORD: "web-secret", PATH: "/usr/bin" },
  );
  assert.equal(merged.GIT_CONFIG_VALUE_0, env.GIT_CONFIG_VALUE_0);
  assert.equal(merged.GIT_CONFIG_COUNT, "1");
  assert.equal(merged.OMP_WEB_PASSWORD, undefined);
});

// ---------------------------------------------------------------------------
// SSH delivery
// ---------------------------------------------------------------------------

/** The identity path the built command points `-i` at.
 *
 *  Git runs GIT_SSH_COMMAND through a shell, so buildGitSshCommand() has to
 *  shell-quote both paths and the command text carries them escaped — every
 *  backslash doubled. Reading that text as if it held a bare path is right on
 *  POSIX, where a tmpdir has no backslashes at all, and wrong on Windows, where
 *  every separator IS one: the extracted string then differs from the real path
 *  by a backslash per separator, and `startsWith` / `existsSync` compare
 *  something that was never a path. So one round of un-quoting is undone here —
 *  exactly the four characters quote() escapes, which is exactly what the shell
 *  collapses. Checked against a real `git ls-remote` with a stand-in ssh: the
 *  child receives `\\` as `\`. */
/** Extract a quoted `<name> "<path>"` from GIT_SSH_COMMAND, undoing one round of
 *  shell quoting. git runs the command through a shell, so quote() escapes
 *  backslashes and a Windows path arrives here with every separator doubled.
 *  Comparing that quoted text against a raw path only matches on POSIX, where
 *  there are no backslashes at all. */
function quotedOptionOf(command, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quoted = new RegExp(`${escaped}\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(command)?.[1];
  return quoted === undefined ? "" : quoted.replace(/\\(.)/g, "$1");
}

function identityPathOf(command) {
  return quotedOptionOf(command, "-i");
}

test("an ssh credential reaches git as GIT_SSH_COMMAND and nothing else", async () => {
  const resolved = await resolveCredential({ url: "git@github.com:user1/repo1.git", credentials: [SSH1] });
  const { env, dispose } = prepareGitCredential(resolved);
  try {
    // Exactly one variable: an extraheader means nothing to ssh, and a second
    // identity is worse than one.
    assert.deepEqual(Object.keys(env), ["GIT_SSH_COMMAND"]);

    const command = env.GIT_SSH_COMMAND;
    assert.match(command, /-o IdentitiesOnly=yes/);
    assert.match(command, /-o PasswordAuthentication=no/);
    assert.match(command, /-o BatchMode=yes/);
    assert.match(command, /-o StrictHostKeyChecking=accept-new/);
    // The path must be the one lib/ssh-known-hosts.ts owns: two files that each
    // decide where known_hosts lives is how a clone ends up trusting nothing.
    assert.equal(
      quotedOptionOf(command, "-o UserKnownHostsFile="),
      knownHostsPath(),
      "the path must be the one lib/ssh-known-hosts.ts owns: two files that each decide where known_hosts lives is how a clone ends up trusting nothing",
    );

    const keyPath = identityPathOf(command);
    assert.ok(keyPath.startsWith(join(tmpdir(), "omp-web-ssh-key-")), `expected a throwaway key, got ${keyPath}`);
    assert.ok(existsSync(keyPath), "the key must exist while git runs");
    assert.equal(readFileSync(keyPath, "utf8").includes("-----BEGIN OPENSSH PRIVATE KEY-----"), true);
  } finally {
    dispose();
  }
});

test("the key itself never appears in the environment — only its path does", async () => {
  const resolved = await resolveCredential({ url: "git@github.com:user1/repo1.git", credentials: [SSH1] });
  const { env, dispose } = prepareGitCredential(resolved);
  try {
    const serialized = JSON.stringify(env);
    assert.equal(serialized.includes("b3BlbnNzaC1rZXktdjEAAAAA"), false, "key material must be in no argv, env, or URL");
    assert.equal(serialized.includes("BEGIN OPENSSH"), false);
    assert.equal(Object.keys(env).some((name) => name.startsWith("OMP_WEB_")), false);
  } finally {
    dispose();
  }
});

test("disposing an ssh credential removes the key, and an abort does the same without it", async () => {
  const resolved = await resolveCredential({ url: "git@github.com:user1/repo1.git", credentials: [SSH1] });

  const staged = prepareGitCredential(resolved);
  const stagedPath = identityPathOf(staged.env.GIT_SSH_COMMAND);
  staged.dispose();
  assert.equal(existsSync(stagedPath), false, "the key must not outlive the operation that needed it");
  assert.doesNotThrow(() => staged.dispose());

  const controller = new AbortController();
  const aborted = prepareGitCredential(resolved, { signal: controller.signal });
  const abortedPath = identityPathOf(aborted.env.GIT_SSH_COMMAND);
  controller.abort();
  assert.equal(existsSync(abortedPath), false, "the route kills by process group, so close can arrive too late to be the cleanup");
});

test("a PAT is prepared without touching the filesystem at all", async () => {
  const resolved = await resolveCredential({ url: "https://github.com/user1/repo1.git", credentials: [USER1] });
  const keyDirs = () => readdirSync(tmpdir()).filter((name) => name.startsWith("omp-web-ssh-key-"));
  const before = keyDirs();
  const { env, dispose } = prepareGitCredential(resolved, { signal: new AbortController().signal });
  try {
    assert.equal(env.GIT_SSH_COMMAND, undefined);
    assert.deepEqual(keyDirs(), before);
  } finally {
    dispose();
  }
});

test("an unusable known_hosts path fails loudly and leaves no key behind", async () => {
  const resolved = await resolveCredential({ url: "git@github.com:user1/repo1.git", credentials: [SSH1] });
  const keyDirs = () => readdirSync(tmpdir()).filter((name) => name.startsWith("omp-web-ssh-key-"));
  const before = keyDirs();
  // A regular file where the agent directory should be: known_hosts cannot be
  // created. The key is staged first, so the failure has to take it with it —
  // otherwise an unwritable volume leaves a private key in the tmpdir every
  // time somebody tries to clone.
  const scratch = mkdtempSync(join(tmpdir(), "omp-web-known-hosts-blocked-"));
  const blocked = join(scratch, "agent");
  writeFileSync(blocked, "not a directory", "utf8");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = blocked;
  try {
    assert.throws(() => prepareGitCredential(resolved), (error) => {
      assert.ok(error.code !== "ssh_key_invalid", "the key is fine; the environment is not");
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(scratch, { recursive: true, force: true });
  }
  assert.deepEqual(keyDirs(), before, "a failed preparation must not leave a staged key");
});

// ---------------------------------------------------------------------------
// cwd → repo
// ---------------------------------------------------------------------------

const POSIX_GIT = { skip: process.platform === "win32" ? "POSIX git worktrees" : false };

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
}

/** A real repository with one commit and an `origin` remote. */
function makeRepo(t, remote) {
  const base = mkdtempSync(join(tmpdir(), "omp-web-credential-cwd-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, "repo");
  git(base, ["init", "-b", "main", dir]);
  git(dir, ["commit", "--allow-empty", "-m", "init"]);
  git(dir, ["remote", "add", "origin", remote]);
  return { base, dir };
}

test("a cwd resolves through its own remote, and an explicit url wins without touching the filesystem", POSIX_GIT, async (t) => {
  const { dir } = makeRepo(t, "https://github.com/user2/repo2.git");

  const fromCwd = await resolveCredential({ cwd: dir, credentials: [USER1, USER2] });
  assert.equal(fromCwd.credential.token, "ghp_token_two");
  assert.equal(fromCwd.via, "owner");

  // The url is authoritative, so a url-only caller never pays for a git spawn
  // and never depends on a directory that may not exist.
  const withUrl = await resolveCredential({ url: "https://github.com/user1/repo1.git", cwd: "/definitely/not/a/directory", credentials: [USER1, USER2] });
  assert.equal(withUrl.credential.token, "ghp_token_one");
});

test("a linked worktree resolves to its parent repository's credential", POSIX_GIT, async (t) => {
  const { base, dir } = makeRepo(t, "https://github.com/user1/repo1.git");
  const worktree = join(base, "feature-worktree");
  git(dir, ["worktree", "add", "-b", "feature", worktree]);

  // The worktree lives in a *sibling* directory, so keying on the worktree path
  // would never match the repository entry. Note that git shares
  // `remote.origin.url` between a worktree and its main checkout (checked:
  // `extensions.worktreeConfig` does not make remote urls per-worktree), so this
  // pins the required outcome rather than proving the resolveProject() call —
  // the comment in remoteForCwd is what explains why that call is there.
  const resolved = await resolveCredential({ cwd: worktree, credentials: [USER1, USER2] });

  assert.equal(resolved.credential.token, "ghp_token_one");
  assert.equal(resolved.via, "owner");
});

test("a subdirectory of a checkout resolves to the same credential as its root", POSIX_GIT, async (t) => {
  const { dir } = makeRepo(t, "https://github.com/user1/repo1.git");
  // Remotes are repo-wide config, so a session cwd below the root must resolve
  // the same way the root does.
  const nested = join(dir, "src", "deep");
  mkdirSync(nested, { recursive: true });

  const resolved = await resolveCredential({ cwd: nested, credentials: [USER1, USER2] });

  assert.equal(resolved.credential.token, "ghp_token_one");
});

test("a repository whose host has no credential resolves to nothing", POSIX_GIT, async (t) => {
  const { dir } = makeRepo(t, "https://gitlab.example.com/user1/repo1.git");
  assert.equal(await resolveCredential({ cwd: dir, credentials: [USER1] }), null);
});

test("no url and no cwd is not an error", async () => {
  assert.equal(await resolveCredential({ credentials: [USER1] }), null);
});

// ---------------------------------------------------------------------------
// Which remote wins when a checkout has several
// ---------------------------------------------------------------------------

test("pickRemoteUrl follows gh's remote priority", () => {
  const config = [
    "remote.origin.url https://github.com/origin/repo.git",
    "remote.zeta.url https://github.com/zeta/repo.git",
    "remote.upstream.url https://github.com/upstream/repo.git",
  ].join("\n");

  assert.equal(pickRemoteUrl(config), "https://github.com/upstream/repo.git");
  assert.equal(pickRemoteUrl("remote.zeta.url https://github.com/zeta/repo.git\nremote.origin.url https://github.com/origin/repo.git"), "https://github.com/origin/repo.git");
  assert.equal(pickRemoteUrl("remote.zeta.url https://github.com/zeta/repo.git\nremote.alpha.url https://github.com/alpha/repo.git"), "https://github.com/zeta/repo.git");
  assert.equal(pickRemoteUrl(""), null);
  assert.equal(pickRemoteUrl("remote.origin.url \n"), null);
});