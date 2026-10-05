/**
 * The rule for a user-supplied git ref (a branch, a tag or a commit SHA) that
 * is about to reach a command line as an argument.
 *
 * The security half is the same as `addWorktree`'s: a value starting with `-`
 * would be read as a git flag, and whitespace, control characters, `..` and
 * git's illegal ref characters have no place in a ref. It lives in its own
 * module because both sides need it — the browser checks it while the user
 * types, and the route must re-check it because a client check is a
 * convenience, never the guard — and neither may spawn git to ask.
 *
 * Deliberately NOT enforced: `addWorktree`'s leading/trailing-`.` and `.lock`
 * rejections. Those guard branch *names omp-web creates*, where `git worktree
 * add -b` has to accept what we made up. `git clone --branch` also takes tags
 * and commit SHAs, which follow none of those rules, so copying that validator
 * here would refuse a plain SHA. An unusable ref is git's to report: it can
 * only ever select what lands inside the clone directory.
 */

/** Whitespace and control characters, plus git's illegal ref characters. */
const ILLEGAL_REF_CHARS = /[\s\x00-\x1f\x7f~^:?*[\]\\]/;

/**
 * Returns the trimmed ref when git can be handed it as an argument, else null.
 *
 * Null means "no ref to pass", which covers an absent, blank or non-string
 * value as well as an illegal one — the caller decides whether a ref was
 * requested at all, because a route has to answer 400 for that and a clone form
 * has to stay quiet.
 */
export function validateGitRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("-")) return null;
  if (ILLEGAL_REF_CHARS.test(trimmed) || trimmed.includes("..")) return null;
  return trimmed;
}