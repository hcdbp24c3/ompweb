// `/api/git/action` is the only door to the write layer, so this file pins what
// the door does rather than what git does (lib/git-write.test.mjs owns that):
// the same cwd authorization /api/git/status applies, an unknown action never
// reaches a child, the two long operations stream NDJSON and the two short ones
// answer JSON, a cancellation kills the child through the stream that asked for
// it, and every code this API can answer with is one `formatApiError` can
// localize — asserted structurally, over every snake_case literal in both files,
// because a code with no dictionary entry renders the raw key to the user.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@/": repoRoot } });
const { DELETE, POST } = await jiti.import("../app/api/git/action/route.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");

const POSIX = { skip: process.platform === "win32" ? "POSIX shell shim" : false };
const LOCALES = ["en", "ja", "zh-CN"];

const IDENT = {
  GIT_AUTHOR_NAME: "Test User",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test User",
  GIT_COMMITTER_EMAIL: "test@example.com",
};
const AMBIENT = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_SSH_COMMAND",
  "FAKE_GIT_HANG",
];

let root;
let restored = new Map();
let originalTmpDir;
let originalAgentDir;

before(() => {
  root = mkdtempSync(join(tmpdir(), "omp-web-git-action-"));
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
  rmSync(root, { recursive: true, force: true });
});

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

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, ...IDENT } });
}

/** A real repository with a real bare remote, an allowlisted root (the same
 *  boundary every cwd-accepting route applies) and a recording `git` earlier on
 *  PATH that hangs `push` while a background child holds its output pipes. */
function makeRepo(t, { origin } = {}) {
  const base = mkdtempSync(join(root, "case-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const bare = join(base, "remote.git");
  const work = join(base, "work");
  git(base, ["init", "--bare", "-b", "main", bare]);
  git(base, ["init", "-b", "main", work]);
  writeFileSync(join(work, "a.txt"), "a\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-m", "init"]);
  if (origin) {
    git(work, ["remote", "add", "origin", origin]);
    git(work, ["config", "branch.main.remote", "origin"]);
    git(work, ["config", "branch.main.merge", "refs/heads/main"]);
    git(work, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  } else {
    git(work, ["remote", "add", "origin", bare]);
    git(work, ["push", "-u", "origin", "main"]);
  }
  allowFileRoot(base);
  return { base, work, bare, spy: installFakeGit(t) };
}

/** Records argv and environment, passes everything except `push` to the real
 *  binary, and — under FAKE_GIT_HANG — makes `push` leave a child behind that
 *  holds the output pipes open, which is what an ssh helper does to a real push. */
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
    'if [ -n "$FAKE_GIT_HANG" ] && [ "$3" = "push" ]; then',
    '  printf "push: %s\\n" "$*"',
    '  sh -c "sleep 30" &',
    `  printf '%s\\n' "$!" > "${grandchildPath}"`,
    "  sleep 30",
    "  exit 0",
    "fi",
    `exec "${realGit}" "$@"`,
    "",
  ].join("\n"), "utf8");
  chmodSync(shim, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  /** Every invocation, in order — the fixture's own `git init` included,
   *  because the shim also serves it. */
  const calls = () => {
    if (!existsSync(argvPath)) return [];
    return readFileSync(argvPath, "utf8")
      .split("\n---\n")
      .map((block) => block.split("\n").filter(Boolean))
      .filter((block) => block.length > 0);
  };
  return {
    calls,
    lastCall: () => calls().at(-1) ?? null,
    // -C <cwd> comes first, so the subcommand is the third argument.
    subcommands: () => calls().map((call) => call[2]),
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

function actionRequest(cwd, payload) {
  return POST(new Request("http://localhost/api/git/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, ...payload }),
  }));
}

/** One POST, read whole. A JSON answer is parsed as JSON; an NDJSON stream is
 *  read into `frames`. `rejection` holds the error body of a 4xx. */
async function act(cwd, payload) {
  const response = await actionRequest(cwd, payload);
  const text = await response.text();
  const frames = [];
  let body = null;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const parsed = JSON.parse(line);
    if (parsed.type) frames.push(parsed);
    else body = parsed;
  }
  return { status: response.status, headers: response.headers, body, frames };
}

function cancelRequest(id) {
  return DELETE(new Request("http://localhost/api/git/action", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  }));
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

/** A response that is still streaming, so it can be cancelled mid-flight. */
async function openStream(cwd, payload) {
  const response = await actionRequest(cwd, payload);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/x-ndjson/);
  return response.body.getReader();
}

async function readFrames(reader) {
  const frames = [];
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    for (const line of new TextDecoder().decode(chunk.value).split("\n")) {
      if (!line) continue;
      frames.push(JSON.parse(line));
    }
  }
  return frames;
}

// ---------------------------------------------------------------------------
// cwd authorization — the same four checks /api/git/status applies
// ---------------------------------------------------------------------------

test("the cwd gate is the status route's gate", async (t) => {
  const { base, work } = makeRepo(t);
  const outside = mkdtempSync(join(root, "elsewhere-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  // Inside the allowlisted root, so the gate reaches its directory check.
  const aFile = join(base, "note.txt");
  writeFileSync(aFile, "hi\n");

  const relative = await act("not/absolute", { action: "stage", paths: ["a.txt"] });
  assert.equal(relative.status, 400);
  assert.equal(relative.body.code, "cwd_must_be_absolute");

  const denied = await act(outside, { action: "stage", paths: [] });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "access_denied");

  const missing = await act(join(base, "gone"), { action: "stage", paths: [] });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "directory_not_found");

  const notADirectory = await act(aFile, { action: "stage", paths: [] });
  assert.equal(notADirectory.status, 400);
  assert.equal(notADirectory.body.code, "not_a_directory");

  // The allowlisted one still works, so the gate above is not simply refusing all.
  const allowed = await act(work, { action: "stage", paths: [join(work, "a.txt")] });
  assert.equal(allowed.status, 200);
});

test("an unknown or absent action never reaches a child", async (t) => {
  const { work, spy } = makeRepo(t);

  for (const action of [undefined, "", "push --force", "MERGE", 42, null]) {
    const result = await act(work, { action });
    assert.equal(result.status, 400, JSON.stringify(action));
    assert.equal(result.body.code, "git_action_required", JSON.stringify(action));
  }
  assert.deepEqual(spy.subcommands(), [], "no git may run for an action we do not implement");
});

test("commit without a message is refused before git runs", async (t) => {
  const { work, spy } = makeRepo(t);

  const blank = await act(work, { action: "commit" });
  assert.equal(blank.status, 400);
  assert.equal(blank.body.code, "commit_message_required");
  const empty = await act(work, { action: "commit", message: "   " });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.code, "commit_message_required");
  assert.equal(spy.subcommands().includes("commit"), false);
});

test("stage and commit answer JSON, with every path after a -- separator", async (t) => {
  setEnv(t, IDENT);
  const { work, spy } = makeRepo(t);
  writeFileSync(join(work, "a.txt"), "changed\n");

  const staged = await act(work, { action: "stage", paths: [join(work, "a.txt")] });
  assert.equal(staged.status, 200);
  assert.equal(staged.body.ok, true);
  assert.match(staged.headers.get("content-type") ?? "", /application\/json/);

  const committed = await act(work, { action: "commit", message: "via the route", paths: [join(work, "a.txt")] });
  assert.equal(committed.status, 200);
  assert.equal(committed.body.ok, true);
  assert.match(committed.body.output, /via the route/);
  assert.deepEqual(execFileSync("git", ["-C", work, "log", "--format=%s", "-1"], { encoding: "utf8" }).trim(), "via the route");

  // The read-only rev-parse calls the layer makes on the way — and this test's
  // own `git log` — are not the point. The two mutations are, and each of them
  // ends option parsing with `--` before the path it was given.
  const mutations = spy.calls().filter((call) => call[2] === "add" || call[2] === "commit");
  assert.deepEqual(mutations, [
    ["-C", work, "add", "-A", "--", join(work, "a.txt")],
    ["-C", work, "commit", "-m", "via the route", "--", join(work, "a.txt")],
  ]);
});

test("a path the session may not touch is a 400, and no child runs", async (t) => {
  setEnv(t, IDENT);
  const { base, work, spy } = makeRepo(t);
  const outside = join(base, "outside.txt");
  writeFileSync(outside, "not ours\n");

  const result = await act(work, { action: "stage", paths: [outside] });

  assert.equal(result.status, 400);
  assert.equal(result.body.code, "path_outside_repository");
  assert.equal(spy.subcommands().includes("add"), false, "and no child may run");
  assert.equal(execFileSync("git", ["-C", work, "diff", "--cached", "--name-only"], { encoding: "utf8" }).trim(), "");
});

test("push streams NDJSON output frames and then one done", async (t) => {
  setEnv(t, IDENT);
  const { work } = makeRepo(t);
  writeFileSync(join(work, "a.txt"), "pushed\n");
  await act(work, { action: "stage", paths: [join(work, "a.txt")] });
  await act(work, { action: "commit", message: "pushed", paths: [join(work, "a.txt")] });

  const result = await act(work, { action: "push", id: "route-push" });

  assert.equal(result.status, 200);
  assert.match(result.headers.get("content-type") ?? "", /application\/x-ndjson/);
  assert.ok(result.frames.some((frame) => frame.type === "output" && /main -> main/.test(frame.text)), JSON.stringify(result.frames));
  assert.deepEqual(result.frames.at(-1), { type: "done" });
});

test("pull asks git for --ff-only and passes the remote after --", async (t) => {
  setEnv(t, IDENT);
  const { work, spy } = makeRepo(t);

  const result = await act(work, { action: "pull", id: "route-pull" });

  assert.equal(result.status, 200);
  assert.deepEqual(result.frames.at(-1), { type: "done" });
  assert.deepEqual(spy.calls().at(-1), ["-C", work, "pull", "--ff-only", "--", "origin"]);
});

test("an explicit refspec reaches git after the -- separator", async (t) => {
  setEnv(t, IDENT);
  const { work, spy } = makeRepo(t);

  const result = await act(work, { action: "push", refspec: "HEAD:refs/heads/side", id: "route-refspec" });

  assert.equal(result.frames.at(-1).type, "done");
  assert.deepEqual(spy.calls().at(-1), ["-C", work, "push", "--", "origin", "HEAD:refs/heads/side"]);
});

test("a streamed action reports its own refusals in the stream, not as a status code", async (t) => {
  setEnv(t, IDENT);
  const { work, spy } = makeRepo(t);

  const badRefspec = await act(work, { action: "push", refspec: "--force", id: "route-bad-refspec" });
  assert.equal(badRefspec.status, 200);
  assert.deepEqual(badRefspec.frames.at(-1).code, "invalid_git_ref");

  // No upstream: the remote exists and is right, so a layer that inferred one
  // would have pushed. Refusing is the observable difference.
  git(work, ["config", "--unset", "branch.main.remote"]);
  const noUpstream = await act(work, { action: "push", id: "route-no-upstream" });
  assert.equal(noUpstream.status, 200);
  assert.deepEqual(noUpstream.frames.at(-1).code, "git_no_upstream");
  assert.equal(spy.subcommands().includes("push"), false);
});

test("a failure inside the stream is a coded frame, not a thrown response", async (t) => {
  setEnv(t, IDENT);
  const { work } = makeRepo(t, { origin: "https://github.com/octocat/absent.git" });

  const result = await act(work, { action: "push", id: "route-failure" });

  assert.equal(result.status, 200, "the operation started, so it is reported in the stream");
  const last = result.frames.at(-1);
  assert.equal(last.type, "error");
  assert.equal(last.code, "git_write_failed");
});

// ---------------------------------------------------------------------------
// cancellation
// ---------------------------------------------------------------------------

test("DELETE cancels an in-flight push and the stream ends as cancelled", POSIX, async (t) => {
  setEnv(t, IDENT);
  const { work, spy } = makeRepo(t);
  setEnv(t, { FAKE_GIT_HANG: "1" });

  const reader = await openStream(work, { action: "push", id: "route-cancel" });
  await waitFor(() => spy.grandchildPid() !== null, "the push never started");
  const grandchild = spy.grandchildPid();

  const cancelled = await cancelRequest("route-cancel");
  assert.equal(cancelled.status, 200);

  const frames = await readFrames(reader);
  assert.deepEqual(frames.at(-1), { type: "cancelled" });
  await waitFor(() => !isAlive(grandchild), "the helper survived the cancellation");
});

test("a client that walks away from the stream cancels the child too", POSIX, async (t) => {
  setEnv(t, IDENT);
  const { work, spy } = makeRepo(t);
  setEnv(t, { FAKE_GIT_HANG: "1" });

  const reader = await openStream(work, { action: "push", id: "route-disconnect" });
  await waitFor(() => spy.grandchildPid() !== null, "the push never started");
  const grandchild = spy.grandchildPid();

  await reader.cancel();

  await waitFor(() => !isAlive(grandchild), "a disconnect left the push running");
});

test("cancelling an id nobody is running is a 404, and a duplicate id is a 400", POSIX, async (t) => {
  setEnv(t, IDENT);
  const { work, spy } = makeRepo(t);
  setEnv(t, { FAKE_GIT_HANG: "1" });

  const unknown = await cancelRequest("never-started");
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).code, "git_action_not_running");

  const reader = await openStream(work, { action: "push", id: "route-duplicate" });
  await waitFor(() => spy.grandchildPid() !== null, "the push never started");
  const duplicate = await act(work, { action: "push", id: "route-duplicate" });
  assert.equal(duplicate.status, 400);
  assert.equal(duplicate.body.code, "git_action_in_progress");

  await cancelRequest("route-duplicate");
  await readFrames(reader);
});

// ---------------------------------------------------------------------------
// every code is localizable
// ---------------------------------------------------------------------------

test("every code this API can answer with resolves in every locale", async () => {
  const dictionaries = Object.fromEntries(
    LOCALES.map((locale) => [locale, JSON.parse(readFileSync(join(repoRoot, "lib/i18n/locales", `${locale}.json`), "utf8"))]),
  );
  // Every snake_case literal in either file is a code, and every code must have a
  // dictionary entry: formatApiError() looks up `errors.<code>` and renders the
  // key itself when it is missing, which is how a localized UI ends up showing
  // "errors.git_no_upstream" to the user.
  const sources = [
    join(repoRoot, "lib/git-write.ts"),
    join(repoRoot, "app/api/git/action/route.ts"),
  ];
  const codes = new Set();
  for (const source of sources) {
    // `from "child_process"` is a snake_case literal that is not a code.
    const text = readFileSync(source, "utf8").replace(/from\s+"[^"]*"/g, "");
    for (const [, literal] of text.matchAll(/"([a-z][a-z0-9]*_[a-z0-9_]*)"/g)) codes.add(literal);
  }
  assert.ok(codes.size >= 10, `expected the API's codes to be found in source, found ${codes.size}`);
  const problems = [];
  for (const code of codes) {
    for (const locale of LOCALES) {
      if (!(`errors.${code}` in dictionaries[locale])) problems.push(`${locale} has no errors.${code}`);
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});