// `gh`, installed in the image, must run as the account the repository belongs
// to — so these tests drive resolution from real remote URLs and real checkouts,
// never from a pre-chosen credential. The three outcomes the design allows are
// pinned (owner match, host default, explicit ambiguity) plus the properties that
// make the mechanism safe: a token reaches exactly the child that asked for it,
// an ssh key is never handed to gh as a token, and a cwd with no credential gets
// an empty environment rather than somebody else's.
//
// The image half of the task (Dockerfile) is asserted here too: `gh` is only
// useful if it is actually in the runtime image, and the apt lists must not
// survive the layer that installed it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@/": repoRoot } });
const { ghEnvForCredential, ghEnvForSpawn, invalidateGhEnvCache, resolveGhEnvForCwd } = await jiti.import("./gh-env.ts");
const { AmbiguousGitCredentialError } = await jiti.import("./git-credential-resolve.ts");
const { hostChildEnv } = await jiti.import("./project-command-env.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");
const { saveGitCredential, listGitCredentials } = await jiti.import("./git-credentials.ts");
const { GET: ghEnvGet } = await jiti.import("../app/api/git-credentials/gh-env/route.ts");

const POSIX_GIT = { skip: process.platform === "win32" ? "POSIX git" : false };

/** Delete this host's own GH_TOKEN / GITHUB_TOKEN for the duration of `t`.
 *
 *  The dev container exports a real pair, and a child inherits the host
 *  environment — deliberately, because those are credentials the user set for
 *  their own work (lib/terminal/pty-registry.test.mjs pins that precedence).
 *  So an assertion of the form "this shell has no token" is only meaningful
 *  once the inherited value is out of the way. */
function withNoAmbientGhToken(t) {
  const names = ["GH_TOKEN", "GITHUB_TOKEN"];
  const previous = names.map((name) => [name, process.env[name]]);
  for (const name of names) delete process.env[name];
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
}

/** A real repository with one commit and an `origin` remote, plus an allowlisted
 *  root so the route under test passes the same boundary every other cwd-accepting
 *  route uses. */
function makeRepo(t, remote) {
  const base = mkdtempSync(join(tmpdir(), "omp-web-gh-env-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, "repo");
  git(base, ["init", "-b", "main", dir]);
  git(dir, ["commit", "--allow-empty", "-m", "init"]);
  if (remote) git(dir, ["remote", "add", "origin", remote]);
  allowFileRoot(base);
  invalidateGhEnvCache();
  return { base, dir };
}

/** Point the omp agent dir at a throwaway location for the duration of `t`, so the
 *  credential store is this test's own and the resolution cache cannot see the
 *  developer's real store. */
async function withAgentDir(t) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-gh-env-store-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
    invalidateGhEnvCache();
  });
  return agentDir;
}

const USER1 = { name: "user1 personal", host: "github.com", account: "user1", type: "pat", token: "ghp_token_one" };
const USER2 = { name: "user2 org", host: "github.com", account: "user2", type: "pat", token: "ghp_token_two" };
const SSH1 = {
  name: "user1 ssh",
  host: "github.com",
  account: "user1",
  type: "ssh",
  privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
};

// ---------------------------------------------------------------------------
// ghEnvForCredential — the pure half: one resolved credential in, one env out.
// ---------------------------------------------------------------------------

test("a PAT reaches gh under both names gh reads, carrying the same token", () => {
  const env = ghEnvForCredential({
    credential: { ...USER1, id: "c1", isDefaultForHost: false, hasToken: true, hasPrivateKey: false, hasPassphrase: false },
    host: "github.com",
    owner: "user1",
    transport: "https",
    via: "owner",
  });
  // gh reads GH_TOKEN first and GITHUB_TOKEN second; setting both means a shell
  // that has one of them cleared still authenticates.
  assert.deepEqual(env, { GH_TOKEN: "ghp_token_one", GITHUB_TOKEN: "ghp_token_one" });
});

test("an ssh credential becomes no gh environment at all", () => {
  const env = ghEnvForCredential({
    credential: { ...SSH1, id: "c1", isDefaultForHost: false, hasToken: false, hasPrivateKey: true, hasPassphrase: false },
    host: "github.com",
    owner: "user1",
    transport: "ssh",
    via: "owner",
  });
  // gh speaks the HTTPS API. A private key in GH_TOKEN would be sent to
  // api.github.com as if it were a token — the key would be disclosed to the
  // host, and gh would still not authenticate.
  assert.deepEqual(env, {}, "no key, and no empty-string placeholder either");
});

test("a record whose type does not match the secret it carries is refused, not trusted", () => {
  // The store never writes a token onto an ssh record (lib/git-credentials.ts
  // keeps `secretFieldsFor` per type), so this shape cannot come from the
  // settings panel — but the store is a file on disk. The type check is what
  // makes "an ssh credential's material never becomes a bearer token" a property
  // of this function rather than of the writer's discipline; without it the
  // token check below would let anything with a `token` field through.
  assert.deepEqual(
    ghEnvForCredential({
      credential: { ...SSH1, token: "ghp_a_private_key_record_should_never_carry_this" },
      host: "github.com",
      owner: "user1",
      transport: "ssh",
      via: "owner",
    }),
    {},
  );
});

test("nothing resolved, or a secret that cannot be read, is an empty environment", () => {
  assert.deepEqual(ghEnvForCredential(null), {});
  assert.deepEqual(ghEnvForCredential(undefined), {});
  assert.deepEqual(ghEnvForCredential({ credential: { ...USER1, token: undefined }, host: "github.com", owner: "user1", transport: "https", via: "owner" }), {});
  assert.deepEqual(ghEnvForCredential({ credential: { ...USER1, token: "" }, host: "github.com", owner: "user1", transport: "https", via: "owner" }), {});
});

// ---------------------------------------------------------------------------
// resolveGhEnvForCwd — the store plus a real checkout.
// ---------------------------------------------------------------------------

test("each checkout gets the token of the account its remote owner names", POSIX_GIT, async (t) => {
  await withAgentDir(t);
  saveGitCredential(USER1);
  saveGitCredential(USER2);
  const one = makeRepo(t, "https://github.com/user1/repo1.git");
  const two = makeRepo(t, "https://github.com/user2/repo2.git");

  assert.deepEqual(await resolveGhEnvForCwd(one.dir), { GH_TOKEN: "ghp_token_one", GITHUB_TOKEN: "ghp_token_one" });
  assert.deepEqual(await resolveGhEnvForCwd(two.dir), { GH_TOKEN: "ghp_token_two", GITHUB_TOKEN: "ghp_token_two" });
});

test("a remote whose owner names no account falls back to the host default", POSIX_GIT, async (t) => {
  await withAgentDir(t);
  saveGitCredential(USER1);
  saveGitCredential({ ...USER2, isDefaultForHost: true });
  const { dir } = makeRepo(t, "https://github.com/some-org/repo.git");

  assert.equal((await resolveGhEnvForCwd(dir)).GH_TOKEN, "ghp_token_two");
});

test("a checkout with no credential at all gets an empty environment, never a default", POSIX_GIT, async (t) => {
  await withAgentDir(t);
  saveGitCredential(USER1);
  const other = makeRepo(t, "https://gitlab.example.com/user1/repo1.git");
  const bare = makeRepo(t, null);
  const missing = makeRepo(t, null);
  rmSync(join(missing.dir, ".git"), { recursive: true, force: true });

  for (const { dir } of [other, bare, missing]) {
    assert.deepEqual(await resolveGhEnvForCwd(dir), {}, `no credential may be invented for ${dir}`);
  }
});

test("an undecidable store is an explicit error on the query path", POSIX_GIT, async (t) => {
  await withAgentDir(t);
  // Neither is the host default, so nothing decides between them.
  saveGitCredential(USER1);
  saveGitCredential(USER2);
  const { dir } = makeRepo(t, "https://github.com/some-org/repo.git");

  await assert.rejects(
    () => resolveGhEnvForCwd(dir),
    (error) => {
      assert.ok(error instanceof AmbiguousGitCredentialError);
      assert.deepEqual([...error.candidates].sort(), ["user1 personal", "user2 org"]);
      return true;
    },
  );
});

test("a subdirectory of a checkout resolves like its root", POSIX_GIT, async (t) => {
  await withAgentDir(t);
  saveGitCredential(USER1);
  saveGitCredential(USER2);
  const { dir } = makeRepo(t, "https://github.com/user2/repo2.git");
  const nested = join(dir, "src", "deep");
  mkdirSync(nested, { recursive: true });

  assert.equal((await resolveGhEnvForCwd(nested)).GH_TOKEN, "ghp_token_two");
});

// ---------------------------------------------------------------------------
// ghEnvForSpawn — the child-spawn half, which must never throw.
// ---------------------------------------------------------------------------

test("a spawn gets an empty environment when the store cannot decide, not a failure", POSIX_GIT, async (t) => {
  await withAgentDir(t);
  saveGitCredential(USER1);
  saveGitCredential(USER2);
  const { dir } = makeRepo(t, "https://github.com/some-org/repo.git");

  // A shell that cannot be opened because two credentials tie is a far worse
  // outcome than a shell whose `gh` runs unauthenticated — gh then fails with its
  // own "not logged in" message, which names the real problem.
  assert.deepEqual(await ghEnvForSpawn(dir), {});
});

test("a spawn survives a credential store it cannot read", POSIX_GIT, async (t) => {
  const agentDir = await withAgentDir(t);
  const { dir } = makeRepo(t, "https://github.com/user1/repo1.git");
  writeFileSync(join(agentDir, "git-credentials.json"), "{ not json", "utf8");
  invalidateGhEnvCache();

  assert.deepEqual(await ghEnvForSpawn(dir), {});
});

test("a spawn still gets its token when the store is readable", POSIX_GIT, async (t) => {
  await withAgentDir(t);
  saveGitCredential(USER1);
  saveGitCredential(USER2);
  const one = makeRepo(t, "https://github.com/user1/repo1.git");

  assert.equal((await ghEnvForSpawn(one.dir)).GH_TOKEN, "ghp_token_one");
});

// ---------------------------------------------------------------------------
// The cache — the input route attaches on every keystroke, so resolution must not
// spawn git per keystroke, and a re-saved credential must still take effect.
// ---------------------------------------------------------------------------

test("resolution is cached per cwd and re-read after invalidation", POSIX_GIT, async (t) => {
  await withAgentDir(t);
  saveGitCredential(USER1);
  saveGitCredential(USER2);
  const { dir } = makeRepo(t, "https://github.com/user2/repo2.git");

  assert.equal((await ghEnvForSpawn(dir)).GH_TOKEN, "ghp_token_two");

  // Rotate the same record, so the store still holds exactly one user2
  // credential — a second one with the same account would make the resolution
  // ambiguous, which is a different test. The cache is keyed on cwd alone, so
  // only an explicit invalidation can make the next spawn see the new token.
  const rotatedId = listGitCredentials().credentials.find((credential) => credential.account === "user2").id;
  saveGitCredential({ ...USER2, id: rotatedId, token: "ghp_token_two_rotated" });
  invalidateGhEnvCache();
  assert.equal((await ghEnvForSpawn(dir)).GH_TOKEN, "ghp_token_two_rotated");
});

test("the cache is keyed on cwd, so one repository's answer never answers for another", POSIX_GIT, async (t) => {
  await withAgentDir(t);
  saveGitCredential(USER1);
  saveGitCredential(USER2);
  const one = makeRepo(t, "https://github.com/user1/repo1.git");
  const two = makeRepo(t, "https://github.com/user2/repo2.git");

  await ghEnvForSpawn(one.dir);
  await ghEnvForSpawn(two.dir);
  await ghEnvForSpawn(one.dir);

  assert.equal((await ghEnvForSpawn(one.dir)).GH_TOKEN, "ghp_token_one");
  assert.equal((await ghEnvForSpawn(two.dir)).GH_TOKEN, "ghp_token_two");
});

// ---------------------------------------------------------------------------
// The environment the child actually receives.
// ---------------------------------------------------------------------------

test("hostChildEnv keeps the gh variables — they must not use the OMP_WEB_ prefix", () => {
  const merged = hostChildEnv({ GH_TOKEN: "t", GITHUB_TOKEN: "t", OMP_WEB_PASSWORD: "secret" }, { OMP_WEB_PASSWORD: "secret" });
  assert.equal(merged.GH_TOKEN, "t");
  assert.equal(merged.GITHUB_TOKEN, "t");
  assert.equal(merged.OMP_WEB_PASSWORD, undefined, "sanitize still runs after the merge");
});

// ---------------------------------------------------------------------------
// GET /api/git-credentials/gh-env?cwd=…
// ---------------------------------------------------------------------------

const ghEnvRequest = (params) => new Request(`http://localhost/api/git-credentials/gh-env?${new URLSearchParams(params)}`);

test("gh-env answers per cwd and never with a default", POSIX_GIT, async (t) => {
  await withAgentDir(t);
  saveGitCredential(USER1);
  saveGitCredential(USER2);
  const one = makeRepo(t, "https://github.com/user1/repo1.git");
  const two = makeRepo(t, "https://github.com/user2/repo2.git");
  const none = makeRepo(t, "https://gitlab.example.com/user1/repo1.git");

  const read = async (dir) => (await ghEnvGet(ghEnvRequest({ cwd: dir }))).json();

  assert.deepEqual(await read(one.dir), { GH_TOKEN: "ghp_token_one", GITHUB_TOKEN: "ghp_token_one" });
  assert.deepEqual(await read(two.dir), { GH_TOKEN: "ghp_token_two", GITHUB_TOKEN: "ghp_token_two" });
  assert.deepEqual(await read(none.dir), {}, "an unmatchable cwd is an empty object, not a default token");
});

test("gh-env refuses a cwd that is absent, relative, or outside the allowed roots", POSIX_GIT, async (t) => {
  await withAgentDir(t);
  const { base, dir } = makeRepo(t, "https://github.com/user1/repo1.git");
  const outside = mkdtempSync(join(tmpdir(), "omp-web-gh-env-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));

  const status = async (params) => (await ghEnvGet(ghEnvRequest(params))).status;
  assert.equal(await status({}), 400, "no cwd at all");
  assert.equal(await status({ cwd: "   " }), 400);
  assert.equal(await status({ cwd: "relative/path" }), 400, "a relative cwd would resolve against the server's own directory");
  assert.equal(await status({ cwd: join(outside, "repo") }), 403, "outside every allowed root");
  assert.equal(await status({ cwd: dir }), 200, "and the allowlisted one is served");
  assert.ok(base);
});

test("gh-env reports an undecidable store as a conflict rather than picking one", POSIX_GIT, async (t) => {
  await withAgentDir(t);
  saveGitCredential(USER1);
  saveGitCredential(USER2);
  const { dir } = makeRepo(t, "https://github.com/some-org/repo.git");

  const response = await ghEnvGet(ghEnvRequest({ cwd: dir }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "credential_ambiguous");
});

test("gh-env answers 404 for a directory that no longer exists", POSIX_GIT, async (t) => {
  await withAgentDir(t);
  const { dir } = makeRepo(t, "https://github.com/user1/repo1.git");
  rmSync(dir, { recursive: true, force: true });

  assert.equal((await ghEnvGet(ghEnvRequest({ cwd: dir }))).status, 404);
});

test("gh-env answers 400 when the cwd is a file", POSIX_GIT, async (t) => {
  await withAgentDir(t);
  const { dir } = makeRepo(t, "https://github.com/user1/repo1.git");
  // Inside the repository, so it passes the allowlist — the directory check is
  // the only thing standing between "not a repository" and "not a directory".
  const file = join(dir, "README.md");
  writeFileSync(file, "x", "utf8");

  const response = await ghEnvGet(ghEnvRequest({ cwd: file }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "not_a_directory");
});

// ---------------------------------------------------------------------------
// The image. `gh` is useless outside the runtime layer, and an apt list that
// survives it is dead weight in every later layer.
// ---------------------------------------------------------------------------

/** The Dockerfile split into stages, so "only the runtime stage" is assertable. */
function dockerfileStages() {
  const source = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
  const stages = [];
  for (const match of source.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)\s*$/gim)) {
    stages.push({ name: match[1], start: match.index });
  }
  for (let index = 0; index < stages.length; index += 1) {
    stages[index].body = source.slice(stages[index].start, stages[index + 1]?.start ?? source.length);
  }
  return stages;
}

test("gh is installed in the runtime stage only", () => {
  const stages = dockerfileStages();
  const builder = stages.find((stage) => stage.name === "builder");
  const runtime = stages.find((stage) => stage.name === "runtime");
  assert.ok(builder && runtime, "both stages are still declared");

  // The builder stage compiles and is discarded; anything installed there is
  // simply absent from the shipped image.
  assert.equal(/\binstall\b[^\n]*\bgh\b/.test(builder.body), false, "the builder stage must not install gh");
  assert.match(runtime.body, /apt-get install[^\n]*\bgh\b/, "the runtime stage installs gh");
});

test("gh comes from the signed GitHub CLI apt repository, and the lists are purged in the same layer", () => {
  const runtime = dockerfileStages().find((stage) => stage.name === "runtime");
  // An unsigned or keyring-less apt source is how a supply chain gets into an
  // image that also holds credential material, so the signed-by wiring is part
  // of the guarantee rather than decoration.
  assert.match(runtime.body, /cli\.github\.com\/packages\/githubcli-archive-keyring\.gpg/);
  assert.match(runtime.body, /signed-by=\S*githubcli-archive-keyring\.gpg/);

  // One RUN: apt lists created and removed in the same layer never reach the
  // image at all, and the purge has to follow the install that created them.
  const layers = runtime.body.split(/\n\s*\n/).filter((block) => block.includes("apt-get"));
  assert.equal(layers.length, 1, "gh is added by the same RUN as the other apt work");
  const layer = layers[0];
  assert.match(layer, /rm -rf \/var\/lib\/apt\/lists\/\*/);
  assert.ok(
    layer.indexOf("rm -rf /var/lib/apt/lists/*") > layer.indexOf("apt-get install"),
    "the purge must come after the install",
  );
});
// ---------------------------------------------------------------------------
// The two delivery surfaces, end to end.
//
// Both are the same shape — resolve for the cwd, hand the answer to the spawn —
// so what is worth pinning is that the answer is the one for THIS cwd and that
// the other account's token is nowhere in the child.
// ---------------------------------------------------------------------------

const { createPtyRegistry } = await jiti.import("./terminal/pty-registry.ts");
const { RpcProcess } = await jiti.import("./omp/rpc-process.ts");

/** A spawner that records what each shell was started with. */
function recordingSpawner() {
  const spawned = [];
  return {
    spawned,
    spawn: (opts) => {
      spawned.push(opts);
      return { write() {}, resize() {}, kill() {}, onData() {}, onExit() {} };
    },
  };
}

test("two terminal shells each get their own repository's token, and never the other's", POSIX_GIT, async (t) => {
  withNoAmbientGhToken(t);
  await withAgentDir(t);
  saveGitCredential(USER1);
  saveGitCredential(USER2);
  const one = makeRepo(t, "https://github.com/user1/repo1.git");
  const two = makeRepo(t, "https://github.com/user2/repo2.git");
  const none = makeRepo(t, "https://gitlab.example.com/user1/repo1.git");

  const { spawned, spawn } = recordingSpawner();
  const registry = createPtyRegistry(spawn, { maxTerminals: 8 });
  for (const { dir } of [one, two, none]) {
    registry.attach(dir, 80, 24, { env: await ghEnvForSpawn(dir) });
  }

  const [first, second, third] = spawned;
  assert.equal(first.env.GH_TOKEN, "ghp_token_one");
  assert.equal(second.env.GH_TOKEN, "ghp_token_two");
  assert.equal(third.env.GH_TOKEN, undefined, "a host with no credential gets no token at all");
  // The failure this whole design exists to prevent: user1's account inside
  // user2's repository.
  for (const [index, opts] of spawned.entries()) {
    const foreign = index === 0 ? "ghp_token_two" : "ghp_token_one";
    assert.equal(JSON.stringify(opts.env).includes(foreign), false, `shell ${index} carries the other account's token`);
  }
});

test("an omp child spawned for a checkout carries that checkout's token", POSIX_GIT, async (t) => {
  withNoAmbientGhToken(t);
  await withAgentDir(t);
  saveGitCredential(USER1);
  saveGitCredential(USER2);
  const one = makeRepo(t, "https://github.com/user1/repo1.git");
  const two = makeRepo(t, "https://github.com/user2/repo2.git");

  // The real RpcProcess, with only the binary and spawn faked — so the merge into
  // the child environment is the production one.
  const { spawnCalls, spawn } = makeChild();
  for (const { dir } of [one, two]) {
    const proc = new RpcProcess({
      cwd: dir,
      env: await ghEnvForSpawn(dir),
      dependencies: { resolveOmpBin: () => "fake-omp", spawn },
    });
    await proc.dispose(0);
  }

  assert.equal(spawnCalls[0][2].env.GH_TOKEN, "ghp_token_one");
  assert.equal(spawnCalls[1][2].env.GH_TOKEN, "ghp_token_two");
  assert.equal(spawnCalls[0][2].env.GITHUB_TOKEN, "ghp_token_one");
});

/** A fake `omp` child: enough of the NDJSON transport to be spawned and disposed. */
function makeChild() {
  const spawnCalls = [];
  return {
    spawnCalls,
    spawn(file, args, options) {
      spawnCalls.push([file, args, options]);
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        pid: 9999,
        kill() { queueMicrotask(() => child.emit("exit", 0, null)); return true; },
      });
      // Nothing reads the fake child's stdin, so it has to be put in flowing mode
      // for the EOF that dispose() waits on to ever arrive.
      child.stdin.resume();
      // The real child exits on stdin EOF, which is what dispose() relies on to
      // resolve; without this the dispose below would wait forever.
      child.stdin.on("end", () => queueMicrotask(() => child.emit("exit", 0, null)));
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({ type: "ready" })}\n`));
      return child;
    },
  };
}

test("every omp session spawn resolves the token, and the utility process is not one of them", async () => {
  const rpcManager = readFileSync(join(repoRoot, "lib/rpc-manager.ts"), "utf8");
  const spawns = [...rpcManager.matchAll(/new RpcProcess\(\{/g)].length;
  const withEnv = [...rpcManager.matchAll(/new RpcProcess\(\{[\s\S]{0,800}?ghEnvForSpawn\(/g)].length;

  // startRpcSession AND restart() spawn a session child. There is no unit test
  // for lib/rpc-manager.ts in this repo (booting omp needs the real binary), so
  // this is the only thing standing between a future edit and a session whose
  // `gh` silently runs unauthenticated. It counts sites rather than matching
  // text, so adding a third spawn site without a token fails here too.
  assert.equal(spawns, 2, "lib/rpc-manager.ts has two session spawn sites");
  assert.equal(withEnv, spawns, "every one of them resolves the gh environment for its cwd");

  // The --no-session utility process (provider lists, model config) is not a
  // repository's agent and runs with cwd=homedir; giving it a credential would
  // be handing a token to a process that has no reason to hold one.
  const utility = readFileSync(join(repoRoot, "lib/omp/rpc-utility.ts"), "utf8");
  assert.equal(/ghEnvForSpawn/.test(utility), false, "the utility process is deliberately excluded");
});

test("editing the store through the settings API reaches the next child immediately", POSIX_GIT, async (t) => {
  await withAgentDir(t);
  saveGitCredential(USER1);
  const { dir } = makeRepo(t, "https://github.com/user1/repo1.git");
  assert.equal((await ghEnvForSpawn(dir)).GH_TOKEN, "ghp_token_one", "the answer is cached now");

  const { PUT, DELETE } = await jiti.import("../app/api/git-credentials/route.ts");
  const call = (method, body) =>
    method === "PUT" ? PUT(jsonRequest("PUT", body)) : DELETE(jsonRequest("DELETE", body));

  // Rotating through the route the settings panel actually uses must drop the
  // cache. lib/git-credentials.ts cannot do it itself — gh-env imports it, so the
  // reverse import would be a cycle — which leaves this call as the only thing
  // between a rotated token and a 5s window in which children keep the old one.
  const id = listGitCredentials().credentials[0].id;
  assert.equal((await call("PUT", { ...USER1, id, token: "ghp_token_one_rotated" })).status, 200);
  assert.equal((await ghEnvForSpawn(dir)).GH_TOKEN, "ghp_token_one_rotated");

  // …and so must deleting it: the shell must not keep authenticating with a
  // credential the user just removed.
  assert.equal((await call("DELETE", { id })).status, 200);
  assert.deepEqual(await ghEnvForSpawn(dir), {});
});

function jsonRequest(method, body) {
  return new Request("http://localhost/api/git-credentials", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
