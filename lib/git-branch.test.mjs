// `git clone --branch <ref>` takes a branch, a tag or a commit SHA, so the
// validator here is deliberately narrower than addWorktree's branch-name rules
// and wider than a "looks like a branch" regex. This file pins both halves:
//
//   - what every ref must satisfy (no option-looking value, no whitespace, no
//     control character, no `..`, none of git's illegal ref characters), which
//     is the half that keeps the value from being read as a flag or from
//     smuggling a second argv entry, and
//   - what it must NOT reject, because the extra rules in worktree.ts exist for
//     branch names omp-web *creates* and would wrongly refuse tags and SHAs.
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { validateGitRef } = await jiti.import("./git-branch.ts");

test("accepts branch names, tags and commit SHAs, and trims the input", () => {
  assert.equal(validateGitRef("main"), "main");
  assert.equal(validateGitRef("release/2.0"), "release/2.0");
  assert.equal(validateGitRef("v1.2.3"), "v1.2.3");
  assert.equal(validateGitRef("a1b2c3d"), "a1b2c3d");
  assert.equal(validateGitRef("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"), "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
  assert.equal(validateGitRef("  feature/login-flow \t"), "feature/login-flow");
});

test("keeps the leading-dot and .lock refs addWorktree rejects — a tag or SHA has no such rule", () => {
  assert.equal(validateGitRef(".hidden"), ".hidden");
  assert.equal(validateGitRef("release.lock"), "release.lock");
  assert.equal(validateGitRef(".."), null, "`..` is still refused as a ref range, not as a dot rule");
});

test("rejects an option-looking ref, so it can never be read as a git flag", () => {
  for (const ref of ["-x", "--", "--upload-pack=touch /tmp/pwned", "--branch=main", "-"]) {
    assert.equal(validateGitRef(ref), null, JSON.stringify(ref));
  }
});

test("rejects whitespace, control characters and `..`", () => {
  for (const ref of ["a b", "a\tb", "a\nb", "a\rb", "a\vb", "a\x00b", "a\x1bb", "a\x7fb", "a..b", "..a", "a.."]) {
    assert.equal(validateGitRef(ref), null, JSON.stringify(ref));
  }
});

test("rejects git's illegal ref characters", () => {
  for (const ref of ["a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "a]b"]) {
    assert.equal(validateGitRef(ref), null, JSON.stringify(ref));
  }
});

test("an absent, blank or non-string ref means 'no ref', not an error", () => {
  for (const value of ["", "   ", "\t\n", undefined, null, 42, {}, ["main"]]) {
    assert.equal(validateGitRef(value), null, JSON.stringify(value));
  }
});