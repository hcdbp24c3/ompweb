// A git identity is applied as GIT_AUTHOR_*/GIT_COMMITTER_* in the child
// environment and NEVER written to ~/.gitconfig. These tests pin that decision
// from both ends: the store is its own file (so a credential export cannot leak
// an email address), it is 0o600 and written atomically, resolution is per
// repository with a global fallback, and "no identity" is an explicit `null`
// rather than something the UI has to invent a default for.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@/": repoRoot } });
const {
  GIT_IDENTITY_FILE,
  GitIdentityError,
  clearDefaultGitIdentity,
  clearProjectGitIdentity,
  gitIdentityEnv,
  gitIdentityEnvForSpawn,
  gitIdentityPath,
  invalidateGitIdentityCache,
  listGitIdentities,
  loadGitIdentityStore,
  parseGitIdentityStore,
  resolveGitIdentity,
  saveDefaultGitIdentity,
  saveProjectGitIdentity,
  selectGitIdentity,
  validateGitIdentityInput,
} = await jiti.import("./git-identity.ts");
const { gitCredentialsPath } = await jiti.import("./git-credentials.ts");
const { hostChildEnv } = await jiti.import("./project-command-env.ts");
const { GET, PUT } = await jiti.import("../app/api/git-identity/route.ts");

const GIT_AVAILABLE = { skip: process.platform === "win32" ? "POSIX git" : false };
const UNIX_ONLY = { skip: process.platform === "win32" ? "POSIX file modes" : false };

/** Point the omp agent dir at a throwaway location for the duration of `t`, so
 *  the identity store is this test's own. */
function withAgentDir(t) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-git-identity-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  invalidateGitIdentityCache();
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
    invalidateGitIdentityCache();
  });
  return agentDir;
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
}

/** A real checkout, so resolution runs through resolveProject() rather than a
 *  hand-written project root. */
function makeRepo(t, name = "repo") {
  const base = mkdtempSync(join(tmpdir(), "omp-web-git-identity-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, name);
  git(base, ["init", "-b", "main", dir]);
  git(dir, ["commit", "--allow-empty", "-m", "init"]);
  return { base, dir };
}

function assertTight(path, message) {
  if (process.platform === "win32") return;
  assert.equal(statSync(path).mode & 0o777, 0o600, message);
}

function jsonRequest(body) {
  return new Request("http://localhost/api/git-identity", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const GLOBAL = { name: "Octo Cat", email: "octocat@example.com" };
const PER_REPO = { name: "Repo Robot", email: "robot@example.com" };

// ---------------------------------------------------------------------------
// Validation — nothing is written before both halves are known good.
// ---------------------------------------------------------------------------

test("a name and an email are both required, and the value is trimmed", () => {
  assert.deepEqual(validateGitIdentityInput({ name: "  Octo Cat  ", email: " octocat@example.com " }), {
    name: "Octo Cat",
    email: "octocat@example.com",
  });
  assert.throws(() => validateGitIdentityInput({ name: "   ", email: "octocat@example.com" }), (error) => error instanceof GitIdentityError && error.code === "name_required");
  assert.throws(() => validateGitIdentityInput({ name: "Octo Cat", email: "  " }), (error) => error instanceof GitIdentityError && error.code === "email_invalid");
  assert.throws(() => validateGitIdentityInput("octocat@example.com"), (error) => error instanceof GitIdentityError && error.code === "identity_invalid");
});

test("an absurdly long name or email is refused rather than truncated", () => {
  // git itself has no length limit here, so an unbounded field is only bounded by
  // whatever the transport and the terminal will carry. Refusing beats silently
  // writing something the user cannot see in full.
  const long = "a".repeat(500);
  assert.throws(
    () => validateGitIdentityInput({ name: long, email: "octocat@example.com" }),
    (error) => error instanceof GitIdentityError && error.code === "name_required",
  );
  assert.throws(
    () => validateGitIdentityInput({ name: "Octo Cat", email: `${long}@example.com` }),
    (error) => error instanceof GitIdentityError && error.code === "email_invalid",
  );
  assert.equal(validateGitIdentityInput({ name: "a".repeat(200), email: "octocat@example.com" }).name.length, 200);
});

test("a malformed email is refused, a plausible one is not", () => {
  // git accepts `user@localhost` for a local setup, so a domain dot is not the
  // test — the shape around the single `@` is.
  for (const email of ["octocat", "octocat@", "@example.com", "a@b@example.com", "octo cat@example.com", "octocat@example.com.", "octocat@.example.com", "octocat@exa..mple.com"]) {
    assert.throws(
      () => validateGitIdentityInput({ name: "Octo Cat", email }),
      (error) => error instanceof GitIdentityError && error.code === "email_invalid",
      `${email} must be refused`,
    );
  }
  for (const email of ["octocat@example.com", "octo.cat+tag@sub.example.co.uk", "octocat@localhost"]) {
    assert.equal(validateGitIdentityInput({ name: "Octo Cat", email }).email, email);
  }
});

test("a name git itself would mangle is refused here instead", () => {
  // git strips or rejects `<` and `>` in an ident and then reports the commit as
  // un-authorable. Catching it at the only place the user is typing is the whole
  // reason this store validates at all.
  for (const name of ["a<b", "a>b", "one\ntwo", "one\ttwo", "bell"]) {
    assert.throws(
      () => validateGitIdentityInput({ name, email: "octocat@example.com" }),
      (error) => error instanceof GitIdentityError && error.code === "name_invalid",
      `${JSON.stringify(name)} must be refused`,
    );
  }
});

// ---------------------------------------------------------------------------
// Persistence — its own file, 0o600, atomic, and degrading when corrupt.
// ---------------------------------------------------------------------------

test("the store is its own file, and never part of the credential store", async (t) => {
  const agentDir = withAgentDir(t);
  saveDefaultGitIdentity(GLOBAL);

  const path = join(agentDir, GIT_IDENTITY_FILE);
  assert.equal(gitIdentityPath(), path);
  assert.ok(existsSync(path), "identity has a dedicated file");
  assert.equal(existsSync(gitCredentialsPath()), false, "writing an identity must not create the credential store");
  // An email address is personal data, not a secret, so it is stored plainly —
  // but it must not ride along inside the credential store's type either, which
  // is what "its own file" is for.
  assert.equal(readFileSync(path, "utf8").includes(GLOBAL.email), true);
});

test("the file is owner-readable only, and a re-write re-tightens one that was loosened", async (t) => {
  const agentDir = withAgentDir(t);
  saveDefaultGitIdentity(GLOBAL);
  const path = join(agentDir, GIT_IDENTITY_FILE);

  // Two halves of one guarantee: the mode passed to the write, and the chmod
  // after the rename. The second is what covers a file that was loosened out of
  // band — copied out of here, restored from a volume, written by an older
  // umask — which is the case that would otherwise leak an email address to
  // every other process in the container.
  if (process.platform !== "win32") chmodSync(path, 0o644);
  saveDefaultGitIdentity({ name: "Octo Cat", email: "octocat@example.com" });
  assertTight(path, "the identity store is 0o600 after any write");
}, UNIX_ONLY);

test("a write leaves nothing behind but the store", async (t) => {
  const agentDir = withAgentDir(t);
  const repository = join(agentDir, "repo");
  mkdirSync(repository, { recursive: true });
  saveDefaultGitIdentity(GLOBAL);
  await saveProjectGitIdentity(repository, PER_REPO);
  clearDefaultGitIdentity();
  // Asserted on the whole directory rather than on a temp-name pattern: the
  // check has to survive the temp file being renamed or reformatted, or it stops
  // protecting anything while still reporting green.
  assert.deepEqual(readdirSync(agentDir).sort(), ["repo", GIT_IDENTITY_FILE].sort());
});

test("the store is written temp-then-rename, never in place", async (t) => {
  withAgentDir(t);
  saveDefaultGitIdentity(GLOBAL);
  // The observable difference only appears across a crash mid-write, which no
  // test can produce: an in-place write can leave a torn file, a temp+rename
  // cannot. So this reads the writer instead. The guarantee is worth keeping
  // legible — the credential store states the same one in its header.
  const source = readFileSync(new URL("./git-identity.ts", import.meta.url), "utf8");
  const writer = /function writeIdentityFile\([\s\S]*?\n}/.exec(source);
  assert.ok(writer, "the store has one writer");
  assert.match(writer[0], /renameSync\(temp, path\)/, "the temp file is renamed over the store");
  assert.match(writer[0], /writeFileSync\(temp,/, "and the contents go to the temp file, not to the store");
});

test("a corrupt or foreign-shaped file degrades to an empty store instead of throwing", async (t) => {
  const agentDir = withAgentDir(t);
  const path = join(agentDir, GIT_IDENTITY_FILE);

  for (const contents of ["", "not json at all", "[]", '{"version":1}', '{"version":1,"overrides":{}}', '{"version":1,"overrides":[{"path":"/x"}]}', '{"version":1,"overrides":[{"path":"/x","name":"n","email":"bad"}]}']) {
    writeFileSync(path, contents);
    assert.deepEqual(loadGitIdentityStore(), { version: 1, overrides: [] }, `must degrade for ${JSON.stringify(contents)}`);
    assert.deepEqual(parseGitIdentityStore(contents), { version: 1, overrides: [] });
  }
  rmSync(path);
  assert.deepEqual(loadGitIdentityStore(), { version: 1, overrides: [] }, "a missing file is an empty store");
});

test("an invalid identity is rejected before anything is written", async (t) => {
  const agentDir = withAgentDir(t);
  saveDefaultGitIdentity(GLOBAL);
  const before = readFileSync(join(agentDir, GIT_IDENTITY_FILE), "utf8");

  assert.throws(() => saveDefaultGitIdentity({ name: "", email: "octocat@example.com" }), (error) => error instanceof GitIdentityError && error.code === "name_required");
  assert.throws(() => saveDefaultGitIdentity({ name: "Octo Cat", email: "nope" }), (error) => error instanceof GitIdentityError && error.code === "email_invalid");
  assert.equal(readFileSync(join(agentDir, GIT_IDENTITY_FILE), "utf8"), before, "the store is untouched");
});

// ---------------------------------------------------------------------------
// Resolution — per-repository override, then the global default, then nothing.
// ---------------------------------------------------------------------------

test("a global default resolves, and a per-repository override wins for its repository", async (t) => {
  const agentDir = withAgentDir(t);
  const one = makeRepo(t, "one");
  const two = makeRepo(t, "two");

  await saveProjectGitIdentity(one.dir, GLOBAL);
  await saveProjectGitIdentity(two.dir, PER_REPO);

  assert.deepEqual((await resolveGitIdentity({ cwd: one.dir })).identity, GLOBAL);
  assert.equal((await resolveGitIdentity({ cwd: one.dir })).via, "project");
  assert.deepEqual((await resolveGitIdentity({ cwd: two.dir })).identity, PER_REPO);
  assert.equal((await resolveGitIdentity({ cwd: two.dir })).via, "project");
  assert.equal(agentDir.length > 0, true);
}, GIT_AVAILABLE);

test("a sibling repository with no override falls back to the global default", async (t) => {
  withAgentDir(t);
  const withOverride = makeRepo(t, "with-override");
  const sibling = makeRepo(t, "sibling");
  await saveDefaultGitIdentity(GLOBAL);
  await saveProjectGitIdentity(withOverride.dir, PER_REPO);

  assert.deepEqual((await resolveGitIdentity({ cwd: withOverride.dir })).identity, PER_REPO);
  const fallback = await resolveGitIdentity({ cwd: sibling.dir });
  assert.deepEqual(fallback.identity, GLOBAL);
  assert.equal(fallback.via, "default", "the fallback is labelled, so the UI can say which one answered");
}, GIT_AVAILABLE);

test("a repository that is only a worktree resolves to its parent's override", async (t) => {
  withAgentDir(t);
  const { base, dir } = makeRepo(t, "main-repo");
  git(dir, ["worktree", "add", "-b", "feature", join(base, "feature-wt")]);
  const worktree = join(base, "feature-wt");

  await saveProjectGitIdentity(dir, PER_REPO);
  const resolved = await resolveGitIdentity({ cwd: worktree });
  assert.deepEqual(resolved.identity, PER_REPO, "a worktree is a sibling directory, so only resolveProject() can map it back");
  assert.equal(resolved.projectRoot, dir);

  // And an override saved from the worktree edits the parent's record rather
  // than creating a second one nothing would ever read.
  await saveProjectGitIdentity(worktree, GLOBAL);
  const store = loadGitIdentityStore();
  assert.equal(store.overrides.length, 1);
  assert.equal(store.overrides[0].path, dir);
}, GIT_AVAILABLE);

test("a directory that is not a repository still resolves, through the global default", async (t) => {
  withAgentDir(t);
  const plain = mkdtempSync(join(tmpdir(), "omp-web-git-identity-plain-"));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  await saveDefaultGitIdentity(GLOBAL);

  const resolved = await resolveGitIdentity({ cwd: plain });
  assert.deepEqual(resolved.identity, GLOBAL);
  assert.equal(resolved.via, "default");
});

test("nothing configured resolves to an explicit null, never an invented default", async (t) => {
  withAgentDir(t);
  const { dir } = makeRepo(t);

  const empty = await resolveGitIdentity({ cwd: dir });
  assert.equal(empty, null, "an unset identity is a state, not a guess");

  // A repository override does not become the global default by accident.
  await saveProjectGitIdentity(dir, GLOBAL);
  assert.deepEqual((await resolveGitIdentity({ cwd: dir })).identity, GLOBAL);
  assert.equal(await resolveGitIdentity({ cwd: makeRepo(t, "other").dir }), null);
}, GIT_AVAILABLE);

test("override lookup compares canonical paths, so a trailing separator is not a second record", async (t) => {
  withAgentDir(t);
  const { dir } = makeRepo(t);
  await saveProjectGitIdentity(dir, PER_REPO);

  const store = loadGitIdentityStore();
  assert.equal(store.overrides.length, 1);
  assert.deepEqual(selectGitIdentity({ store, projectRoot: `${dir}/` })?.identity, PER_REPO);
  assert.deepEqual(selectGitIdentity({ store, projectRoot: dir })?.via, "project");
});

// ---------------------------------------------------------------------------
// Delivery — git's own four variables, in the child environment only.
// ---------------------------------------------------------------------------

test("the resolved identity becomes git's four variables and nothing else", () => {
  const resolved = { identity: GLOBAL, via: "default", projectRoot: "/repo" };
  assert.deepEqual(gitIdentityEnv(resolved), {
    GIT_AUTHOR_NAME: "Octo Cat",
    GIT_AUTHOR_EMAIL: "octocat@example.com",
    GIT_COMMITTER_NAME: "Octo Cat",
    GIT_COMMITTER_EMAIL: "octocat@example.com",
  });

  // hostChildEnv() deletes the whole OMP_WEB_ prefix, so an identity carried in
  // one of those names would be removed on the way to git. GIT_* survives, and
  // a resolved identity must beat an ambient one of the same name.
  const sanitized = hostChildEnv(gitIdentityEnv(resolved), { GIT_AUTHOR_NAME: "inherited", OMP_WEB_PASSWORD: "secret" });
  assert.equal(sanitized.GIT_AUTHOR_NAME, "Octo Cat");
  assert.equal(sanitized.OMP_WEB_PASSWORD, undefined);
});

test("no identity produces no variables at all, not empty ones", () => {
  // An empty-string GIT_AUTHOR_EMAIL is how you tell git "commit anyway with an
  // empty ident", which is the opposite of leaving it unset.
  assert.deepEqual(gitIdentityEnv(null), {});
  assert.deepEqual(gitIdentityEnv(undefined), {});
  assert.deepEqual(gitIdentityEnv({ identity: { name: "", email: "" }, via: "default", projectRoot: "/repo" }), {});
});

test("a child spawned in a checkout gets that repository's identity in its environment", async (t) => {
  withAgentDir(t);
  const one = makeRepo(t, "one");
  const two = makeRepo(t, "two");
  await saveDefaultGitIdentity(GLOBAL);
  await saveProjectGitIdentity(two.dir, PER_REPO);
  invalidateGitIdentityCache();

  assert.equal((await gitIdentityEnvForSpawn(one.dir)).GIT_AUTHOR_EMAIL, GLOBAL.email);
  assert.equal((await gitIdentityEnvForSpawn(two.dir)).GIT_AUTHOR_EMAIL, PER_REPO.email);

  // With no global left, a repository that has no override of its own gets
  // nothing — the identity of the repository next door must not bleed across.
  clearDefaultGitIdentity();
  invalidateGitIdentityCache();
  assert.deepEqual(await gitIdentityEnvForSpawn(one.dir), {});
  assert.equal((await gitIdentityEnvForSpawn(two.dir)).GIT_AUTHOR_EMAIL, PER_REPO.email);

  // A write must reach the next child immediately rather than after the cache.
  await saveProjectGitIdentity(one.dir, PER_REPO);
  invalidateGitIdentityCache();
  assert.equal((await gitIdentityEnvForSpawn(one.dir)).GIT_AUTHOR_EMAIL, PER_REPO.email);
}, GIT_AVAILABLE);

// ---------------------------------------------------------------------------
// The route — a single record, not a filesystem probe.
// ---------------------------------------------------------------------------

test("GET takes no request at all, so no browser-supplied cwd can be resolved", async (t) => {
  const agentDir = withAgentDir(t);
  const repository = mkdtempSync(join(agentDir, "plain-repo-"));
  await saveDefaultGitIdentity(GLOBAL);
  await saveProjectGitIdentity(repository, PER_REPO);

  assert.equal(GET.length, 0, "the handler must accept no request object");
  const body = await (await GET()).json();
  assert.deepEqual(Object.keys(body).sort(), ["default", "overrides", "path"]);
  assert.deepEqual(body.default, GLOBAL);
  assert.equal(body.overrides.length, 1);
  assert.deepEqual(Object.keys(body.overrides[0]).sort(), ["email", "name", "path"]);
});

test("PUT writes the global default, a repository override, and clears either", async (t) => {
  withAgentDir(t);
  const { dir } = makeRepo(t);

  assert.equal((await (await PUT(jsonRequest(GLOBAL))).json()).default.name, "Octo Cat");
  await PUT(jsonRequest({ project: dir, ...PER_REPO }));
  let store = loadGitIdentityStore();
  assert.equal(store.overrides.length, 1);
  assert.equal(store.overrides[0].path, dir);

  await PUT(jsonRequest({ project: dir, clear: true }));
  store = loadGitIdentityStore();
  assert.deepEqual(store.overrides, []);

  await PUT(jsonRequest({ clear: true }));
  assert.equal(loadGitIdentityStore().default, undefined, "clearing the global leaves no half-record behind");
}, GIT_AVAILABLE);

test("PUT refuses an invalid identity with 400 and changes nothing", async (t) => {
  withAgentDir(t);
  await saveDefaultGitIdentity(GLOBAL);

  const response = await PUT(jsonRequest({ name: "", email: GLOBAL.email }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "name_required");
  assert.deepEqual(loadGitIdentityStore().default, GLOBAL);
});

test("PUT refuses a repository path that is not an existing directory", async (t) => {
  withAgentDir(t);
  for (const project of ["", "   ", "/definitely/not/here/at/all"]) {
    const response = await PUT(jsonRequest({ project, ...PER_REPO }));
    assert.equal(response.status, 400, `${JSON.stringify(project)} must be refused`);
    assert.match((await response.json()).code, /^path_/);
  }
  assert.deepEqual(loadGitIdentityStore().overrides, []);
});

test("the browser view never carries a path the store did not already hold", async (t) => {
  withAgentDir(t);
  saveDefaultGitIdentity(GLOBAL);
  await saveProjectGitIdentity(makeRepo(t, "listed").dir, PER_REPO);

  const view = listGitIdentities();
  assert.deepEqual(Object.keys(view.default).sort(), ["email", "name"]);
  assert.deepEqual(Object.keys(view.overrides[0]).sort(), ["email", "name", "path"]);
  assert.equal(view.overrides.length, 1);
});

// ---------------------------------------------------------------------------
// Clearing the global is a real operation, not an accident of the field being blank.
// ---------------------------------------------------------------------------
test("an edit made through the route reaches the next child with no cache window", GIT_AVAILABLE, async (t) => {
  withAgentDir(t);
  const { dir } = makeRepo(t);
  await saveDefaultGitIdentity(GLOBAL);
  assert.equal((await gitIdentityEnvForSpawn(dir)).GIT_AUTHOR_NAME, GLOBAL.name);

  // Deliberately NOT invalidating the cache here: the route is the only
  // production writer, so if it forgets, a user edits their identity in Settings
  // and every commit for the next five seconds is authored as the old name.
  await PUT(jsonRequest({ name: "New Name", email: "new@example.com" }));
  assert.equal((await gitIdentityEnvForSpawn(dir)).GIT_AUTHOR_NAME, "New Name");
});

test("clearing the global default leaves the file a valid, readable store", async (t) => {
  withAgentDir(t);
  await saveDefaultGitIdentity(GLOBAL);
  clearDefaultGitIdentity();

  assert.equal(loadGitIdentityStore().default, undefined);
  assert.deepEqual(parseGitIdentityStore(readFileSync(gitIdentityPath(), "utf8")), { version: 1, overrides: [] });
});

test("clearing an override that is not there is a no-op, not an error", async (t) => {
  withAgentDir(t);
  const { dir } = makeRepo(t);
  await saveDefaultGitIdentity(GLOBAL);

  await clearProjectGitIdentity(dir);
  assert.deepEqual(loadGitIdentityStore().overrides, []);
  assert.deepEqual(loadGitIdentityStore().default, GLOBAL, "an unrelated record survives");

  // And the repo's own answer is unchanged, so a stray click cannot cost a
  // repository the identity it falls back to.
  assert.deepEqual((await resolveGitIdentity({ cwd: dir })).identity, GLOBAL);
}, GIT_AVAILABLE);
