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
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { after, before } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@/": new URL("../", import.meta.url).pathname } });
const { POST } = await jiti.import("../app/api/projects/clone/route.ts");

const REPO_URL = "https://github.com/octocat/repo.git";
let root;
let argvPath;
let originalPath;
let workspaceCount = 0;

before(() => {
  root = mkdtempSync(join(tmpdir(), "omp-web-clone-route-"));
  argvPath = join(root, "git-argv.txt");
  // One argument per line, so an argv holding `--` or an empty string still
  // reads back unambiguously.
  const shim = join(root, "git");
  writeFileSync(shim, `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg"; done > "${argvPath}"\nexit 0\n`, "utf8");
  chmodSync(shim, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${root}${delimiter}${originalPath}`;
});

after(() => {
  process.env.PATH = originalPath;
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