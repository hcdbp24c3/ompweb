import { execFile, spawn } from "child_process";
import path from "path";
import { promisify } from "util";
import { isWithinPath } from "./git-changes";
import {
  prepareGitCredential,
  resolveCredential,
} from "./git-credential-resolve";
import { loadGitCredentials } from "./git-credentials";
import { gitIdentityEnvForSpawn } from "./git-identity";
import { hostChildEnv } from "./project-command-env";

const execFileAsync = promisify(execFile);

// ============================================================================
// Writing to a repository from a browser request.
//
// Four operations — stage, commit, push, pull — and the one aborted child they
// share. Three rules are load-bearing rather than stylistic:
//
// 1. THE SESSION'S SUBTREE IS THE AUTHORITY. `getGitStatus` filters the status
//    list to `isWithinPath(cwd, filePath)`, so a session rooted in a
//    subdirectory never sees a sibling's files. A commit that honoured only
//    "inside the repository" would let that same session commit them, so a path
//    here must clear BOTH the repository root and the session's own cwd. That is
//    why `isWithinPath` is imported rather than reimplemented: the two filters
//    have to be the same filter, and a copy is free to drift.
//
// 2. NOTHING IS GUESSED. `git push` with no arguments pushes the current branch
//    to whatever git considers its upstream; when there is none, git picks a
//    remote by name and the user gets a push they did not ask for. So the
//    upstream's remote is read from git (`symbolic-ref` plus `branch.<b>.remote`)
//    and an unset one is a coded error. The same reading decides WHICH remote's
//    credential is delivered, which is what keeps an ssh key from being handed to
//    a different host than the one it was resolved for.
//
// 3. ONE CHILD, ONE CREDENTIAL, ONE DISPOSAL. Every child gets the pinned
//    message locale, git's own non-interactive settings, the identity env and —
//    for the two operations that contact a remote — that remote's credential.
//    The credential arrives through `prepareGitCredential`, which stages an ssh
//    key on disk, so its `dispose()` runs in a `finally` around the whole
//    operation: the load-bearing part is the ABORT path, where the child is
//    killed with a signal to its process group and its `close` can arrive much
//    later or never. `prepareGitCredential` takes the same signal, so the key is
//    gone even if this process dies mid-operation.
//
// Cancelling kills the process group, not git. A push runs ssh and credential
// helpers as children of git, and they inherit its stdout/stderr: killing git
// alone leaves those pipes open and `close` never fires, so the request would
// hang until they timed out on their own.
//
// No GIT_ALLOW_PROTOCOL here, unlike the clone route. That one exists because
// the URL is user-supplied and must not be able to name a transport the
// credential plumbing would then send a token over. A write layer's remote is
// already in the repository's config, and the constraint would refuse the most
// ordinary remote of all — a local path or a file:// one — which is exactly what
// the verification path uses.
// ============================================================================

export type GitWriteAction = "stage" | "commit" | "push" | "pull";

/** A failure a client can localize: `formatApiError` looks up `errors.<code>`. */
export class GitWriteError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GitWriteError";
    this.code = code;
  }
}

export interface GitWriteOptions {
  /** Aborting kills the child and everything it spawned, and reports the
   *  operation as cancelled rather than as a failure. */
  signal?: AbortSignal;
  /** Called with git's output as it arrives. */
  onOutput?: (chunk: string) => void;
}

export interface GitWriteResult {
  action: GitWriteAction;
  output: string;
  cancelled: boolean;
}

const GIT_TIMEOUT_MS = 10_000;
const GIT_OUTPUT_MAX_CHARS = 800;

/** git's own ident failures. LC_ALL is pinned below, so these are stable; the
 *  set covers the two wordings git uses depending on whether it had a GECOS
 *  fallback to complain about. */
const IDENTITY_FAILURE = /empty ident|auto-detect email address|Please tell me who you are|no name was given/i;

/** `--ff-only`'s refusal. Matched on the stream rather than by asking git twice,
 *  for the same reason as the identity failure: one child, one answer. */
const NOT_FAST_FORWARD = /not possible to fast-forward|can'?t be fast-forward|non-fast-forward/i;

// ---------------------------------------------------------------------------
// The child
// ---------------------------------------------------------------------------

interface GitChildResult {
  /** null when git could not be started at all. */
  exitCode: number | null;
  output: string;
  aborted: boolean;
}

interface GitChild {
  cwd: string;
  args: string[];
  /** Overrides for hostChildEnv(), never the whole environment. */
  env: Record<string, string>;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
}

/**
 * One git child, merged output, killable as a group.
 *
 * Already aborted means no child at all: the caller cleans up around us.
 */
function runGit(child: GitChild): Promise<GitChildResult> {
  const aborted = (): boolean => child.signal?.aborted === true;
  if (aborted()) return Promise.resolve({ exitCode: null, output: "", aborted: true });

  const { promise, resolve } = Promise.withResolvers<GitChildResult>();
  const spawned = spawn("git", ["-C", child.cwd, ...child.args], {
    // stdin closed: git must never wait for input nobody is there to type. This
    // is what makes an unanswerable prompt (a credential, an ident) fail instead
    // of hanging the request.
    stdio: ["ignore", "pipe", "pipe"],
    env: hostChildEnv(child.env),
    // A new session, so the group signal below reaches the helpers git spawned.
    detached: process.platform !== "win32",
    windowsHide: true,
  });

  let output = "";
  const collect = (chunk: string) => {
    output += chunk;
    child.onOutput?.(chunk);
  };
  spawned.stdout.setEncoding("utf8").on("data", collect);
  spawned.stderr.setEncoding("utf8").on("data", collect);

  const kill = () => {
    if (!spawned.pid) return;
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(spawned.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      return;
    }
    try {
      process.kill(-spawned.pid, "SIGTERM");
    } catch {
      // The group is already gone.
    }
  };
  child.signal?.addEventListener("abort", kill, { once: true });

  const finish = (exitCode: number | null) => {
    child.signal?.removeEventListener("abort", kill);
    resolve({ exitCode, output, aborted: aborted() });
  };
  spawned.on("error", () => finish(null));
  spawned.on("close", (code) => finish(code));
  return promise;
}

/**
 * The environment every git child gets.
 *
 * LC_ALL pins git's message locale so the failure matchers above cannot be
 * defeated by the server's language — the same reason lib/worktree.ts pins it
 * for its dirty-worktree check.
 *
 * The identity env comes from the store rather than a gitconfig write, so it is
 * merged AFTER the fixed values: it must beat an inherited GIT_AUTHOR_* pair.
 * The empty askpass and GIT_TERMINAL_PROMPT=0 are the clone route's, kept as
 * they are — a credential replaces the prompt rather than re-opening one.
 */
async function childEnv(cwd: string, extra: Record<string, string> = {}): Promise<Record<string, string>> {
  return {
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    ...(await gitIdentityEnvForSpawn(cwd)),
    ...extra,
  };
}

/** git's own message, trimmed to the lines a user can act on. Falls back to
 *  everything when git said nothing in the `fatal:`/`error:` shape. */
function gitFailureText(output: string): string {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  const reported = lines.filter((line) => /^(fatal|error):/i.test(line));
  const chosen = reported.length > 0 ? reported : lines;
  return chosen.join("\n").slice(0, GIT_OUTPUT_MAX_CHARS) || "git failed";
}

function assertSucceeded(action: GitWriteAction, result: GitChildResult): void {
  if (result.exitCode === 0) return;
  if (result.exitCode === null) {
    throw new GitWriteError("git_not_found", "Could not run git — is it installed?");
  }
  if (action === "commit" && IDENTITY_FAILURE.test(result.output)) {
    throw new GitWriteError(
      "git_no_identity",
      "Git has no name and email to record this commit with. Set a git identity in Settings first.",
    );
  }
  if (action === "pull" && NOT_FAST_FORWARD.test(result.output)) {
    throw new GitWriteError(
      "git_not_fast_forward",
      "The remote has commits this branch does not, and a pull here never merges. Fetch them first.",
    );
  }
  throw new GitWriteError("git_write_failed", gitFailureText(result.output));
}

/** Runs one operation and turns its outcome into a result or a coded error. A
 *  killed child is a cancellation, not a failure: the user asked for it. */
async function run(
  action: GitWriteAction,
  cwd: string,
  args: string[],
  options: GitWriteOptions,
  extraEnv: Record<string, string> = {},
): Promise<GitWriteResult> {
  const result = await runGit({ cwd, args, env: await childEnv(cwd, extraEnv), ...options });
  if (result.aborted) return { action, output: result.output, cancelled: true };
  assertSucceeded(action, result);
  return { action, output: result.output, cancelled: false };
}

// ---------------------------------------------------------------------------
// What may be written
// ---------------------------------------------------------------------------

/** The repository's own top level, or a refusal — never a silent "not a repo"
 *  that a later command would answer differently. */
async function resolveRepositoryRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      timeout: GIT_TIMEOUT_MS,
      env: hostChildEnv({ LC_ALL: "C" }),
    });
    const root = stdout.trim();
    if (root) return root;
  } catch {
    // Fall through to the refusal below.
  }
  throw new GitWriteError("not_a_git_repository", `${cwd} is not inside a git repository.`);
}

/**
 * A request path, resolved and checked against both boundaries.
 *
 * The result is absolute, which is what git wants for a pathspec and what makes
 * the check possible at all: a relative path is resolved against the session's
 * cwd first, so nothing can escape by way of `..`.
 */
function resolveWritablePath(input: { cwd: string; repositoryRoot: string; filePath: unknown }): string {
  if (typeof input.filePath !== "string" || !input.filePath.trim()) {
    throw new GitWriteError("path_required", "A file path is required.");
  }
  const resolved = path.resolve(input.cwd, input.filePath);
  if (!isWithinPath(input.repositoryRoot, resolved) || !isWithinPath(input.cwd, resolved)) {
    throw new GitWriteError(
      "path_outside_repository",
      `${resolved} is outside this session's working directory.`,
    );
  }
  return resolved;
}

/**
 * The paths for one mutating operation.
 *
 * There is no "everything" form on purpose. `git add -A` with no pathspec stages
 * the whole working tree (since git 2.0), and `git commit` with no pathspec
 * commits the entire index — and an index can hold a file this session was never
 * allowed to see. A caller that wants one file says which file.
 */
function resolveWritablePaths(input: { cwd: string; repositoryRoot: string; paths: unknown }): string[] {
  if (!Array.isArray(input.paths) || input.paths.length === 0) {
    throw new GitWriteError("path_required", "Choose at least one file.");
  }
  return input.paths.map((filePath) => resolveWritablePath({ cwd: input.cwd, repositoryRoot: input.repositoryRoot, filePath }));
}

// ---------------------------------------------------------------------------
// The remote
// ---------------------------------------------------------------------------

/**
 * A refspec, checked. It is a value, not an option: the argv terminates option
 * parsing with `--` before it, so the only thing left to refuse is a value git
 * would reject confusingly — or one carrying a newline into a log line.
 *
 * A refspec is NOT `validateGitRef`'s business: `src:dst` and a leading `+` are
 * how a refspec says "force" and "rename", and that validator rejects both.
 */
function validateRefspec(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("-")) return null;
  if (/[\s\x00-\x1f\x7f]/.test(trimmed)) return null;
  return trimmed;
}

interface RemoteTarget {
  /** The remote's name in this repository, which is what the argv carries. */
  remote: string;
  /** Its URL, which is what the credential store is asked about. */
  url: string;
}

/**
 * The remote this branch's upstream lives on, read from git rather than
 * assumed.
 *
 * Two reads, because one porcelain call cannot express it: `%(upstream:remotename)`
 * is per-ref and `git for-each-ref` takes ref *patterns*, not "the current
 * branch", so asking it for `HEAD` matches nothing and answers nothing at all —
 * which looks exactly like a branch that has never been pushed. The branch name
 * comes from `symbolic-ref`, whose own failure (a detached HEAD) is the same
 * case: there is no upstream to push to.
 *
 * A branch tracking a *local* branch has a remote named `.`, and it is refused
 * below with no URL: inventing one would be the guess this module exists to
 * avoid, and a push that silently went somewhere else is worse than a refusal.
 */
async function upstreamRemote(cwd: string): Promise<RemoteTarget> {
  const gitRead = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      timeout: GIT_TIMEOUT_MS,
      env: hostChildEnv({ LC_ALL: "C" }),
    });
    return stdout.trim();
  };

  let remote = "";
  try {
    const branch = await gitRead(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (branch) remote = await gitRead(["config", "--get", `branch.${branch}.remote`]);
  } catch {
    // An unborn branch, a detached HEAD, or a branch nobody pushed: all of them
    // mean the same thing here, and `git push` would answer this one by guessing
    // a remote name.
  }
  if (!remote) {
    throw new GitWriteError("git_no_upstream", "This branch has no upstream branch to push to.");
  }

  let url = "";
  try {
    url = await gitRead(["remote", "get-url", "--", remote]);
  } catch {
    // A remote name with no URL cannot be contacted or authenticated.
  }
  if (!url) {
    throw new GitWriteError("git_no_remote", `The remote ${remote} has no URL.`);
  }
  return { remote, url };
}

/**
 * The credential environment for one remote, valid for the whole operation and
 * removed afterwards.
 *
 * The `finally` is the whole point. An ssh credential is a private key written
 * to a temporary directory, and cancellation kills the child by signal, so the
 * operation can end without the child's `close` ever arriving — the key must not
 * depend on that event. Passing the signal to `prepareGitCredential` covers the
 * case where this process dies first; this covers every path that reaches it.
 */
async function withCredentialEnv<T>(
  url: string,
  signal: AbortSignal | undefined,
  run: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const resolved = await resolveCredential({ url, credentials: loadGitCredentials() });
  const prepared = prepareGitCredential(resolved, { signal });
  try {
    return await run(prepared.env);
  } finally {
    prepared.dispose();
  }
}

// ---------------------------------------------------------------------------
// The four operations
// ---------------------------------------------------------------------------

/** Stage exactly the given paths, as modifications, additions and removals. */
export async function stage(
  cwd: string,
  paths: readonly string[],
  options: GitWriteOptions = {},
): Promise<GitWriteResult> {
  const repositoryRoot = await resolveRepositoryRoot(cwd);
  const targets = resolveWritablePaths({ cwd, repositoryRoot, paths });
  return run("stage", cwd, ["add", "-A", "--", ...targets], options);
}

/**
 * Commit exactly the given paths, whether or not they were staged by `stage`.
 *
 * `git commit -- <paths>` records the worktree's version of those paths, so a
 * ticked file is committed whether it was staged or not, and an unstaged file
 * outside the list cannot come along.
 */
export async function commit(
  cwd: string,
  input: { message: unknown; paths?: readonly string[] },
  options: GitWriteOptions = {},
): Promise<GitWriteResult> {
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!message) {
    throw new GitWriteError("commit_message_required", "A commit message is required.");
  }
  const repositoryRoot = await resolveRepositoryRoot(cwd);
  const targets = resolveWritablePaths({ cwd, repositoryRoot, paths: input.paths });
  return run("commit", cwd, ["commit", "-m", message, "--", ...targets], options);
}

/** Push the current branch to the remote its upstream names. */
export async function push(
  cwd: string,
  input: { refspec?: unknown } = {},
  options: GitWriteOptions = {},
): Promise<GitWriteResult> {
  const requestedRefspec = typeof input.refspec === "string" ? input.refspec.trim() : "";
  const refspec = validateRefspec(requestedRefspec);
  if (requestedRefspec && !refspec) {
    throw new GitWriteError("invalid_git_ref", "Enter a valid refspec.");
  }
  const target = await upstreamRemote(cwd);
  return withCredentialEnv(target.url, options.signal, (credentialEnv) =>
    run("push", cwd, ["push", "--", target.remote, ...(refspec ? [refspec] : [])], options, credentialEnv),
  );
}

/** Bring the current branch up to date with its upstream, never merging. */
export async function pull(cwd: string, options: GitWriteOptions = {}): Promise<GitWriteResult> {
  const target = await upstreamRemote(cwd);
  return withCredentialEnv(target.url, options.signal, (credentialEnv) =>
    run("pull", cwd, ["pull", "--ff-only", "--", target.remote], options, credentialEnv),
  );
}