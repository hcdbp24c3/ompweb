// The Git tab's ticked set. It is a pure module on purpose: the panel is a
// 490-line component whose interesting states (a stale tick, a cwd switch) are
// all about *which paths are in the set*, and testing them through jsdom would
// let a behaviour change hide behind a re-render.
//
// Two properties are load-bearing and neither is visible in the markup:
//   - the set holds the ABSOLUTE `filePath` values `getGitStatus` reports,
//     because that is what `git commit -- <paths>` needs and what the route
//     re-authorizes against the session's subtree;
//   - pruning happens against the refreshed status, so a file that is no longer
//     modified cannot be committed by a tick the user forgot about.
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { pruneTickedPaths, toggleTickedPath } = await jiti.import("./git-file-selection.ts");

const A = "/repo/a.ts";
const B = "/repo/lib/b.ts";
const C = "/repo/c.md";

const listed = (...paths) => paths.map((filePath) => ({ filePath }));

test("ticking a file adds it and ticking it again removes it", () => {
  const once = toggleTickedPath(new Set(), A);
  assert.deepEqual([...once], [A]);
  const twice = toggleTickedPath(once, A);
  assert.deepEqual([...twice], []);
});

test("ticking one file leaves every other tick alone", () => {
  // The plan forbids making the file list a checkbox that toggles everything
  // implicitly, so one tick must be exactly one tick.
  const ticked = toggleTickedPath(toggleTickedPath(new Set(), A), B);
  assert.deepEqual([...ticked], [A, B]);
  const withoutB = toggleTickedPath(ticked, B);
  assert.deepEqual([...withoutB], [A]);
});

test("ticking does not mutate the set it was handed", () => {
  // The panel holds this in state and derives from it; an in-place mutation
  // would leave React's snapshot comparison convinced nothing changed.
  const original = new Set([A]);
  const next = toggleTickedPath(original, B);
  assert.deepEqual([...original], [A]);
  assert.deepEqual([...next], [A, B]);
});

test("pruning drops exactly the paths the refreshed status no longer lists", () => {
  const ticked = new Set([A, B, C]);
  const pruned = pruneTickedPaths(ticked, listed(B, C));
  assert.deepEqual([...pruned], [B, C]);
});

test("pruning a fully-present selection keeps every path", () => {
  const ticked = new Set([C, A]);
  assert.deepEqual([...pruneTickedPaths(ticked, listed(A, B, C))], [C, A]);
});

test("pruning against a clean working tree clears the selection", () => {
  // `isGitRepository` true with zero files is the "everything got committed or
  // reverted" refresh; nothing may stay ticked into it.
  assert.deepEqual([...pruneTickedPaths(new Set([A, B]), [])], []);
});

test("pruning preserves the order the paths were ticked in", () => {
  // The reported list is what a commit request carries, so it must be stable
  // rather than following whichever refresh landed last.
  const pruned = pruneTickedPaths(new Set([C, A, B]), listed(B, C, A));
  assert.deepEqual([...pruned], [C, A, B]);
});

test("pruning never invents a path the user did not tick", () => {
  const pruned = pruneTickedPaths(new Set([A]), listed(A, B, C));
  assert.deepEqual([...pruned], [A]);
});

test("pruning does not mutate the set it was handed", () => {
  const ticked = new Set([A, B]);
  pruneTickedPaths(ticked, listed(A));
  assert.deepEqual([...ticked], [A, B]);
});