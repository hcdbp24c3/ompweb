import { loadGitCredentials } from "./git-credentials";
import { resolveCredential, type ResolvedGitCredential } from "./git-credential-resolve";

// ============================================================================
// `gh` needs a token, and the token is the one the repository already resolves.
//
// The image installs `gh` so that commands an agent runs can talk to private
// repositories. Nothing in omp-web ever shells out to `gh`: lib/github-repo.ts
// emulates gh's remote-priority logic in pure Node on purpose, and every git
// operation still goes through git itself. `gh` exists here purely as a
// program the agent may choose to run.
//
// THAT IS WHY THE ENVIRONMENT IS PER-CWD AND NOT GLOBAL. The credential a
// repository authenticates with is decided per remote
// (lib/git-credential-resolve.ts): `github.com/user1/repo1` is user1's token
// and `github.com/user2/repo2` is user2's. Handing every child one ambient
// GH_TOKEN would put user1's account into user2's agent — the whole point of
// per-repo resolution, discarded at the last step. So each child is resolved
// from the cwd it was started in, and a cwd that resolves nothing gets an EMPTY
// environment: no token, and no fallback to some other account's.
//
// AN SSH CREDENTIAL DELIVERS NOTHING HERE. gh talks to the HTTPS API, so a
// private key is not a token in any sense: putting one in GH_TOKEN would send
// the key to api.github.com as a bearer credential and still fail to
// authenticate. An ssh remote therefore gets no gh environment, exactly as it
// gets no `http.<host>.extraheader`.
//
// THE TWO ENTRY POINTS DIFFER IN WHAT THEY DO WITH AN AMBIGUOUS STORE, because
// their callers differ:
//
//   - `resolveGhEnvForCwd` throws AmbiguousGitCredentialError. Its caller asked a
//     direct question ("what would this cwd get?") and "I cannot tell you" is a
//     real answer it deserves.
//   - `ghEnvForSpawn` never throws and answers `{}`. A shell that refuses to
//     open because two credentials tie is a far worse failure than a shell
//     whose `gh` runs unauthenticated — that produces gh's own "not logged in"
//     message, which names the actual problem. This is the same shape as
//     prepareGitCredential(): a broken store must not break the operation that
//     merely wanted to use one.
//
// NEITHER NAME MAY USE THE `OMP_WEB_` PREFIX. hostChildEnv() deletes that whole
// prefix, so a credential carried in an OMP_WEB_ variable would be removed on
// the way to the child. GH_TOKEN / GITHUB_TOKEN are gh's own documented names,
// which is also why both are set: gh reads GH_TOKEN first and GITHUB_TOKEN
// second, and a user's shell that has one of them cleared still authenticates.
//
// Server-side only: it decrypts the store (`loadGitCredentials()`), so nothing
// resolved here may be logged or otherwise left where a child can read it back.
// ============================================================================

/** A child's gh environment.
 *
 *  Plain string map because that is what every consumer merges it into — a pty
 *  spawn env, an RpcProcessOptions.env — and a narrower object type with two
 *  optional keys is not assignable to `Record<string, string>` without an index
 *  signature, which would then have to allow `undefined` and defeat the point.
 *  Only two keys are ever written, both of them gh's own documented names.
 *
 *  Empty means "no token", never "empty token": an empty-string GH_TOKEN is not
 *  the same as an absent one to a program that checks whether the variable is
 *  set. */
export type GhEnv = Record<string, string>;

const NO_GH_ENV: GhEnv = {};

/** The gh environment for one already-resolved credential. Pure, so the
 *  selection rules are testable without a checkout or a store.
 *
 *  A record whose token could not be decrypted (task 08's degraded read:
 *  `hasToken: true`, `token: undefined`) yields nothing — the same rule task 09
 *  applies, since a credential that cannot be read cannot authenticate. */
export function ghEnvForCredential(resolved: ResolvedGitCredential | null | undefined): GhEnv {
  const credential = resolved?.credential;
  if (!credential || credential.type !== "pat") return NO_GH_ENV;
  const token = credential.token;
  if (typeof token !== "string" || !token) return NO_GH_ENV;
  return { GH_TOKEN: token, GITHUB_TOKEN: token };
}

// ---------------------------------------------------------------------------
// Resolution + the per-cwd cache.
//
// The cache exists for a concrete caller: /api/terminal/input attaches on every
// keystroke, and each attach needs an environment. Without it, typing in a
// terminal would spawn `git config` once per keystroke. It is short-lived (the
// same 5s window lib/file-access.ts keeps its allowlist for, and for the same
// reason — a bounded staleness against a re-read of local state) and the
// credential route drops it outright on every write, so a token edited in
// Settings takes effect at once rather than after the window.
// ---------------------------------------------------------------------------

declare global {
  var __ompWebGhEnvCache: Map<string, { env: GhEnv; expiresAt: number }> | undefined;
}

/** Matches lib/file-access.ts's ALLOWED_ROOTS_TTL_MS. */
const GH_ENV_CACHE_TTL_MS = 5_000;

/** Bound on distinct cwds held. A session list cannot grow without bound, and
 *  neither can the cwds a child has been started in, but the cache is a cache
 *  and must not become the thing that grows. */
const GH_ENV_CACHE_MAX_ENTRIES = 64;

function cache(): Map<string, { env: GhEnv; expiresAt: number }> {
  if (!globalThis.__ompWebGhEnvCache) globalThis.__ompWebGhEnvCache = new Map();
  return globalThis.__ompWebGhEnvCache;
}

/** Forget every cached answer. Called after a credential is written or deleted,
 *  so a rotated token reaches the next child immediately. */
export function invalidateGhEnvCache(): void {
  globalThis.__ompWebGhEnvCache?.clear();
}

/**
 * The gh environment for `cwd`, or an explicit error.
 *
 * Throws AmbiguousGitCredentialError rather than choosing between two accounts
 * for one repository — a caller asking the question can be told the store needs
 * a default marked, and no child is ever started on a guess.
 */
export async function resolveGhEnvForCwd(cwd: string): Promise<GhEnv> {
  const entries = cache();
  const cached = entries.get(cwd);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.env;

  const env = ghEnvForCredential(await resolveCredential({ cwd, credentials: loadGitCredentials() }));
  if (entries.size >= GH_ENV_CACHE_MAX_ENTRIES && !entries.has(cwd)) {
    // Map iteration order is insertion order, so the first key is the oldest.
    entries.delete(entries.keys().next().value as string);
  }
  entries.set(cwd, { env, expiresAt: now + GH_ENV_CACHE_TTL_MS });
  return env;
}

/**
 * The gh environment for a child about to be started in `cwd`. Never throws.
 *
 * A cwd that is not a repository, has no remote, matches no credential, or sits
 * on an undecidable store all get `{}` — see the header for why the last one
 * degrades instead of failing the spawn.
 */
export async function ghEnvForSpawn(cwd: string): Promise<GhEnv> {
  try {
    return await resolveGhEnvForCwd(cwd);
  } catch {
    return NO_GH_ENV;
  }
}