import { execFile } from "child_process";
import { promisify } from "util";
import type { GitCredential } from "./git-credentials";
import { parseGithubRemoteUrl } from "./github-repo";
import { isSupportedGitUrl } from "./git-clone";
import { hostChildEnv } from "./project-command-env";
import { resolveProject } from "./worktree";

const execFileAsync = promisify(execFile);

// ============================================================================
// Choosing a stored credential for a remote, and handing it to git.
//
// `github.com/user1/repo1` uses user1's token and `github.com/user2/repo2`
// uses user2's. This module owns both halves of that: which record wins, and
// how the secret reaches the child process. It is deliberately the only place
// either happens — no other module builds a git env with a token in it.
//
// Resolution order, for a remote on `host` with owner `owner`:
//
//   1. host + owner — the remote's owner equals the credential's `account`.
//   2. the host default — `isDefaultForHost`, which lib/git-credentials.ts
//      already keeps exclusive per host.
//   3. the only credential for that host, when there is exactly one.
//   4. an explicit ambiguity error naming the candidates.
//
// Array order is never consulted and no usage counter is kept: rewriting a
// stored credential would otherwise change which identity a clone runs as.
//
// DELIVERY — env, never argv, never the URL.
//
// `http.<url>.extraheader` is a config setting, and git reads config from
// GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n. Passing the header
// that way keeps the token out of every other channel: not in argv (which `ps`
// and every error message carry), not in the remote URL (which lands in
// .git/config and in each clone's progress output), and not in any log line.
// It is also why exactly ONE credential is emitted per child: git applies
// extraheader unconditionally, so two of them for one host means git sends two
// Authorization headers and the server picks.
//
// The empty GIT_ASKPASS / SSH_ASKPASS / GIT_TERMINAL_PROMPT=0 the clone route
// sets are left exactly as they are. Those empties are what make a clone fail
// fast instead of blocking on a prompt nobody can answer; this mechanism means
// git never has to ask, so relaxing them would only add a way to hang.
//
// NO ASKPASS HELPER IS INVOLVED, so there is no helper script to ship and
// nothing to copy into the image (see the Dockerfile). The delivery path above
// needs no executable and no extra file. If a helper is ever added — for SSH
// keys, say — it must be named through `OMP_GIT_ASKPASS*` and never
// `OMP_WEB_*`: hostChildEnv() deletes that whole prefix before the child sees
// it, so a credential carried in an OMP_WEB_ variable would be removed on the
// way to git. GIT_CONFIG_* survives it, which the tests pin.
//
// WHAT IS DELIVERED: one HTTP `Authorization: basic <user:token>` header per
// child, built from a PAT. An `ssh` record has no token, and this feature
// deliberately does not teach git to use a private key, so ssh records are not
// candidates at all — an ssh record marked default must not shadow a PAT that
// could actually authenticate an https remote. Cloning over ssh:// therefore
// behaves exactly as it did before: no credential from this store is applied.
//
// `cwd` is optional and means "the repository this operation belongs to". The
// remote comes from `url` when there is one, so a caller that has a URL never
// spawns git and never depends on a directory. `resolveProject()` maps a
// linked worktree back to its main repository root before the remote is read
// (a worktree lives in a *sibling* directory, so matching on the worktree path
// itself would never find the repository), and repo-wide config means a
// subdirectory of a checkout resolves like its root.
//
// No caller passes `cwd` yet — both remote fetches in the app carry a URL — but
// a fetch inside a checkout must not silently authenticate as whatever the host
// default happens to be, so the option is part of the contract rather than an
// afterthought.
//
// There is no repo → credential binding table to look up, so nothing here
// matches a repository by path prefix at all: the repository contributes its
// remote, and the remote contributes host and owner.
//
// lib/skill-updates.ts is url-only. It fetches
// `https://github.com/<owner>/<repo>.git` from skill metadata and has no cwd
// at all, so it must pass a url; it must never invent a directory to satisfy
// this signature.
//
// Server-side only: it takes DECRYPTED credentials (`loadGitCredentials()`), so
// nothing resolved here may ever be returned to the browser.
// ============================================================================

export interface ParsedRemote {
  /** `host` or `host:port`, lowercased — never a scheme, userinfo or path. */
  host: string;
  /** First path segment: the owner git hosts expose (`user1` in `user1/repo1`). */
  owner: string | null;
  /** Second path segment, `.git` stripped. Carried for diagnostics; selection
   *  never reads it. */
  repo: string | null;
}

/** Why this credential won, so a caller can explain the choice. */
export type CredentialMatch = "owner" | "host-default" | "host-only";

export interface ResolvedGitCredential {
  credential: GitCredential;
  /** The remote's host, as it appears in the git config key. */
  host: string;
  owner: string | null;
  via: CredentialMatch;
}

export class AmbiguousGitCredentialError extends Error {
  readonly code = "credential_ambiguous";
  constructor(readonly host: string, readonly candidates: string[]) {
    super(
      `${candidates.length} credentials match ${host} and none of them is marked the default for it (${candidates.join(", ")}). Mark one as the default for ${host}, or keep a single credential per host.`,
    );
    this.name = "AmbiguousGitCredentialError";
  }
}

/** scp-like authority: an optional `user@` and a bare host, no scheme, no
 *  port (ssh:// is how a port is spelled in a URL; in `host:2222:path` the
 *  leading `2222:` is part of the path, exactly as git reads it). */
const SCP_AUTHORITY = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+)$/;

/** host[:port] of a URL-form remote, lowercased. */
function urlHost(url: URL): string | null {
  return url.hostname ? url.host.toLowerCase() : null;
}

export function parseRemote(url: string): ParsedRemote | null {
  const trimmed = url.trim();
  // Same gate as the clone route: a token is never sent to a transport that
  // omp-web would not itself fetch from.
  if (!isSupportedGitUrl(trimmed)) return null;

  let host: string | null;
  let path: string;
  if (trimmed.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    host = urlHost(parsed);
    path = parsed.pathname;
  } else {
    const separator = trimmed.indexOf(":");
    const authority = SCP_AUTHORITY.exec(trimmed.slice(0, separator));
    host = authority ? authority[1].toLowerCase() : null;
    path = trimmed.slice(separator + 1);
  }
  if (!host) return null;

  // parseGithubRemoteUrl is the authority on what a GitHub remote looks like,
  // including its rejections. The split below is for the rest: the store is not
  // GitHub-only, and GitLab nests groups one path segment deeper, which the
  // owner/repo pair alone cannot express.
  if (host === "github.com" || host.startsWith("github.com:")) {
    const slug = parseGithubRemoteUrl(trimmed);
    if (slug) {
      const [owner, repo] = slug.split("/");
      return { host, owner, repo };
    }
  }

  const segments = path.replace(/[?#].*$/, "").split("/").filter(Boolean);
  const last = segments.length - 1;
  // `.git` can be the only segment (`https://host/.git`), which leaves nothing:
  // an owner-less remote must read as null, not as an empty account name.
  const cleaned = segments.map((segment, index) => (index === last ? segment.replace(/\.git$/i, "") : segment)).filter(Boolean);
  return { host, owner: cleaned[0] ?? null, repo: cleaned[1] ?? null };
}

/** gh's default-remote priority, so the remote picked here is the one a `gh`
 *  command would have used: upstream > github > origin > the rest in the order
 *  git printed them. */
const REMOTE_PRIORITY = ["upstream", "github", "origin"];

/** The URL git would fetch from for a checkout, from
 *  `git config --get-regexp ^remote\..*\.url$` output. */
export function pickRemoteUrl(gitConfig: string): string | null {
  const urls = new Map<string, string>();
  for (const line of gitConfig.split("\n")) {
    const match = /^remote\.(.+)\.url (.+)$/.exec(line.trim());
    if (match && !urls.has(match[1])) urls.set(match[1], match[2].trim());
  }
  const rank = (name: string) => {
    const index = REMOTE_PRIORITY.indexOf(name);
    return index === -1 ? REMOTE_PRIORITY.length : index;
  };
  for (const name of [...urls.keys()].sort((a, b) => rank(a) - rank(b))) {
    const url = urls.get(name);
    if (url) return url;
  }
  return null;
}

/** The remote of the repository containing `cwd`. A linked worktree resolves to
 *  its main checkout first, so a session running in a worktree asks for the
 *  credential of the repository it belongs to.
 *
 *  git shares `remote.*.url` between a worktree and its main checkout — checked
 *  empirically, and `extensions.worktreeConfig` does not change that — so reading
 *  the config at `cwd` alone would give the same answer today. The explicit
 *  mapping is kept because it makes the outcome a property of this code rather
 *  than of how git happens to scope config, and because it is the directory a
 *  future repository lookup would have to match against. */
export async function remoteForCwd(cwd: string): Promise<ParsedRemote | null> {
  const { projectRoot } = await resolveProject(cwd);
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", projectRoot, "config", "--get-regexp", "^remote\\..*\\.url$"],
      { timeout: 5_000, env: hostChildEnv({ LC_ALL: "C" }) },
    );
    const url = pickRemoteUrl(stdout);
    return url ? parseRemote(url) : null;
  } catch {
    // Not a repository, or no remote: nothing to authenticate against.
    return null;
  }
}

/** A record this feature can actually deliver: a PAT whose token decrypted. A
 *  record whose key file is missing keeps `hasToken: true` and no token, and
 *  must not be selected — nor make another record ambiguous. */
function isDeliverable(credential: GitCredential): boolean {
  return credential.type === "pat" && typeof credential.token === "string" && credential.token.length > 0;
}

/** The resolution order, as a pure function of a remote and the store. Throws
 *  AmbiguousGitCredentialError rather than guessing. */
function selectCredentialForRemote(input: { remote: ParsedRemote; credentials: GitCredential[] }): ResolvedGitCredential | null {
  const { remote, credentials } = input;
  const owner = remote.owner?.toLowerCase() ?? null;
  const forHost = credentials.filter((credential) => credential.host.toLowerCase() === remote.host && isDeliverable(credential));
  if (forHost.length === 0) return null;

  const chosen = (credential: GitCredential, via: CredentialMatch): ResolvedGitCredential => ({ credential, host: remote.host, owner: remote.owner, via });
  const byOwner = owner ? forHost.filter((credential) => credential.account.toLowerCase() === owner) : [];
  // An owner that matches more than one record is not a decision, so it falls
  // through to the rules below rather than picking one of them.
  if (byOwner.length === 1) return chosen(byOwner[0], "owner");

  const defaults = forHost.filter((credential) => credential.isDefaultForHost);
  if (defaults.length === 1) return chosen(defaults[0], "host-default");
  // A single credential for the host cannot be ambiguous, default flag or not.
  if (forHost.length === 1) return chosen(forHost[0], "host-only");

  throw new AmbiguousGitCredentialError(remote.host, forHost.map((credential) => credential.name));
}

/** The credential for a remote, or null when none applies. `url` wins over
 *  `cwd`; neither is an error. Throws AmbiguousGitCredentialError rather than
 *  guessing when a host has several candidates and none is the default. */
export async function resolveCredential(input: { url?: string; cwd?: string; credentials: GitCredential[] }): Promise<ResolvedGitCredential | null> {
  const remote = input.url ? parseRemote(input.url) : input.cwd ? await remoteForCwd(input.cwd) : null;
  if (!remote) return null;
  return selectCredentialForRemote({ remote, credentials: input.credentials });
}

/** GitHub accepts any username with the token as the password; `oauth2` is
 *  git's own convention elsewhere and is what a PAT-only host expects. */
function gitAuthUsername(host: string): string {
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  return hostname === "github.com" ? "x-access-token" : "oauth2";
}

/** The environment for one git child: exactly one `http.<url>.extraheader`
 *  entry, or nothing at all. Merge it into hostChildEnv() overrides — never
 *  into argv, and never into the URL. */
export function gitCredentialEnv(resolved: ResolvedGitCredential | null | undefined): Record<string, string> {
  const token = resolved?.credential.token;
  if (!resolved || !token) return {};
  const basic = Buffer.from(`${gitAuthUsername(resolved.host)}:${token}`, "utf8").toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.https://${resolved.host}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}