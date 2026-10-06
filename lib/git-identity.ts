import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { comparableProjectPath } from "./comparable-path";
import { getAgentDir } from "./omp/paths";
import { isRecord } from "./type-guards";
import { resolveProject } from "./worktree";

// ============================================================================
// Who commits. A name and an email, per repository, applied to git as
// GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL / GIT_COMMITTER_NAME / GIT_COMMITTER_EMAIL
// in the child environment.
//
// WHY IT IS NOT `git config --global`.
//
// Writing ~/.gitconfig would make omp-web the owner of the user's git identity
// for every repository on the machine, including the ones this app never opens,
// and it would be a write into a file omp-web does not otherwise own — a
// hand-edited global config, a distro template, or another tool's settings.
// An environment variable set on one child cannot leak into the next one, and
// disappears with the child. So the identity is delivered per spawn, from the
// same four names git already documents, and nothing is written outside the omp
// agent dir.
//
// WHICH CHILD GETS IT.
//
// Only the two places an agent actually runs git: the omp child
// (lib/rpc-manager.ts, both `new RpcProcess` sites) and the in-browser terminal
// (lib/terminal/pty-registry.ts, through the routes that already resolve
// lib/gh-env.ts). Per-cwd, exactly like the credential and gh work in tasks
// 09-11 — two repositories must not share an identity — and a cwd that resolves
// nothing gets an EMPTY environment, never somebody else's identity.
//
// IT IS NOT A SECRET, and the difference is deliberate.
//
// A name and an email are personal data, not credentials: the settings panel
// shows them back so they can be edited, so the store is plain JSON and the
// route returns the values. It is still its OWN file rather than a field on the
// credential store, because that store exists to be exported, redacted and
// encrypted as a unit; an email address riding along inside it would be one
// `listGitCredentials()` away from every other credential surface. It is written
// 0o600 anyway — the same mode lib/git-credentials.ts uses for its own files —
// because an agent dir that is world-readable for one store should not be
// world-readable for another.
//
// RESOLUTION, in one place, with one explicit last answer:
//
//   1. the override for this repository,
//   2. the global default,
//   3. `null` — nothing.
//
// The keys are canonical project roots from resolveProject(), which maps a
// linked worktree back to its main checkout, so a worktree commits as its parent
// and an override saved from either edits the same single record. Comparing them
// through comparableProjectPath() keeps Windows casing and trailing separators
// from creating a second record nothing would ever read.
//
// `null` is a first-class outcome and not a gap to paper over. git's own failure
// for an unconfigured identity is an untranslated raw stderr string, so the
// settings panel states the condition up front ("not set") instead of letting a
// commit fail in a place with no explanation.
//
// KNOWN LIMIT: the write is atomic (temp + rename) but is a read-modify-write
// with no cross-process lock, the same window projects.json has. A lockfile
// before treating that as a bug.
// ============================================================================

export const GIT_IDENTITY_FILE = "git-identity.json";

const STORE_VERSION = 1 as const;
const MAX_NAME = 200;
const MAX_EMAIL = 320;

export interface GitIdentity {
  name: string;
  email: string;
}

/** One record per repository, keyed by the canonical project root. */
export interface GitIdentityOverride extends GitIdentity {
  path: string;
}

export interface GitIdentityStore {
  version: typeof STORE_VERSION;
  default?: GitIdentity;
  overrides: GitIdentityOverride[];
}

/** Where an answer came from, so a caller can explain it rather than guess. */
export type GitIdentityMatch = "project" | "default";

export interface ResolvedGitIdentity {
  identity: GitIdentity;
  via: GitIdentityMatch;
  /** The canonical project root the lookup was made against. */
  projectRoot: string;
}

/** The browser-facing shape. Plain values — identity is not a secret. */
export interface GitIdentityView {
  path: string;
  default: GitIdentity | null;
  overrides: GitIdentityOverride[];
}

/** Error carrying a stable code for client localization. */
export class GitIdentityError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GitIdentityError";
    this.code = code;
  }
}

export function gitIdentityPath(): string {
  return resolve(getAgentDir(), GIT_IDENTITY_FILE);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function requiredString(value: unknown, code: string, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new GitIdentityError(code, `${label} is required`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new GitIdentityError(code, `${label} must be at most ${max} characters`);
  return trimmed;
}

function normalizeName(value: unknown): string {
  const name = requiredString(value, "name_required", "Name", MAX_NAME);
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new GitIdentityError("name_invalid", "Name must not contain control characters");
    }
  }
  // git builds an ident as `<name> <email>` and strips or rejects angle brackets,
  // so an accepted name would commit under something the user did not type. This
  // is the only place the user sees the field, so it is the place to refuse.
  if (name.includes("<") || name.includes(">")) {
    throw new GitIdentityError("name_invalid", "Name must not contain < or >");
  }
  return name;
}

/**
 * Exactly one `@`, a non-empty local part, and a domain that is not empty and
 * carries no leading, trailing or doubled dot. Deliberately NOT "must contain a
 * dot": `user@localhost` is a legitimate git identity on a local setup, and
 * refusing it would push users towards a fake address.
 */
function normalizeEmail(value: unknown): string {
  const email = requiredString(value, "email_invalid", "Email", MAX_EMAIL);
  if (/\s/.test(email)) throw new GitIdentityError("email_invalid", "Email must not contain whitespace");
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) {
    throw new GitIdentityError("email_invalid", "Email must be a local part and a domain joined by one @");
  }
  const domain = email.slice(at + 1);
  if (!domain || domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) {
    throw new GitIdentityError("email_invalid", "Email domain is malformed");
  }
  return email;
}

export function validateGitIdentityInput(input: unknown): GitIdentity {
  if (!isRecord(input)) throw new GitIdentityError("identity_invalid", "Identity must be an object");
  return { name: normalizeName(input.name), email: normalizeEmail(input.email) };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Atomic write, owner-readable only. Same discipline as
 * lib/git-credentials.ts's writeSecretFile(): the mode is passed to the write
 * AND chmod'ed after the rename, so a file that was loosened out of band — a
 * copy, a volume restore, an older umask — is re-tightened.
 */
function writeIdentityFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, contents, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } finally {
    try {
      if (existsSync(temp)) rmSync(temp);
    } catch {
      // ignore cleanup failures
    }
  }
}

/** A stored identity is kept only if it is still a usable one. Validation runs
 *  again on READ, not just on write: the store is a file on disk, and a record
 *  that a hand edit (or a future schema) left invalid must degrade to "not
 *  configured" rather than reach git as an ident it would refuse. */
function readIdentity(value: unknown): GitIdentity | undefined {
  if (!isRecord(value)) return undefined;
  try {
    return validateGitIdentityInput(value);
  } catch {
    return undefined;
  }
}

/** Parse the store; a missing, corrupt, or foreign-shaped file degrades to an
 *  empty store rather than throwing, exactly like parseProjectRegistry and
 *  parseGitCredentialStore. */
export function parseGitIdentityStore(raw: string): GitIdentityStore {
  const empty: GitIdentityStore = { version: STORE_VERSION, overrides: [] };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.overrides)) return empty;
    const overrides: GitIdentityOverride[] = [];
    for (const item of parsed.overrides) {
      if (!isRecord(item)) continue;
      const path = typeof item.path === "string" ? item.path.trim() : "";
      const identity = readIdentity(item);
      if (!path || !identity) continue;
      // Two entries for one comparable path are one record; the last write wins,
      // which is the same answer upsertProject gives.
      const key = comparableProjectPath(path);
      const existing = overrides.findIndex((override) => comparableProjectPath(override.path) === key);
      const record: GitIdentityOverride = { path, ...identity };
      if (existing === -1) overrides.push(record);
      else overrides[existing] = record;
    }
    const fallback = readIdentity(parsed.default);
    return {
      version: STORE_VERSION,
      ...(fallback ? { default: fallback } : {}),
      overrides,
    };
  } catch {
    return empty;
  }
}

export function loadGitIdentityStore(): GitIdentityStore {
  try {
    return parseGitIdentityStore(readFileSync(gitIdentityPath(), "utf8"));
  } catch {
    return { version: STORE_VERSION, overrides: [] };
  }
}

function writeStore(store: GitIdentityStore): GitIdentityStore {
  writeIdentityFile(gitIdentityPath(), `${JSON.stringify(store, null, 2)}\n`);
  return store;
}

/** The browser's view, freshly built from the store. */
export function listGitIdentities(): GitIdentityView {
  const store = loadGitIdentityStore();
  return {
    path: gitIdentityPath(),
    default: store.default ? { name: store.default.name, email: store.default.email } : null,
    overrides: store.overrides.map((override) => ({ path: override.path, name: override.name, email: override.email })),
  };
}

/**
 * The key a repository's override is stored under.
 *
 * resolveProject() rather than a local canonicalization, because it owns the one
 * rule that matters here: a linked worktree is a *sibling* directory, so realpath
 * alone would key the worktree separately from the repository it belongs to and
 * that record would never be read. It also returns the symlink-free,
 * on-disk-cased form, which is what resolveProject() returns on the lookup side.
 *
 * The path must be an existing directory: this route stores a string, it does not
 * read anything, but a key nothing can ever resolve to is junk in a file the user
 * is expected to be able to edit.
 */
async function canonicalOverridePath(value: unknown): Promise<string> {
  if (typeof value !== "string" || !value.trim()) {
    throw new GitIdentityError("path_required", "Repository path is required");
  }
  const trimmed = value.trim();
  if (trimmed.includes("\0")) throw new GitIdentityError("path_invalid", "Repository path contains a null byte");
  const absolute = resolve(trimmed);
  let directory = false;
  try {
    directory = statSync(absolute).isDirectory();
  } catch {
    directory = false;
  }
  if (!directory) {
    throw new GitIdentityError("path_invalid", "Repository path must be an existing directory");
  }
  const { projectRoot } = await resolveProject(absolute);
  return projectRoot;
}

export function saveDefaultGitIdentity(input: unknown): GitIdentityStore {
  const identity = validateGitIdentityInput(input);
  const store = loadGitIdentityStore();
  return writeStore({ version: STORE_VERSION, default: identity, overrides: store.overrides });
}

export function clearDefaultGitIdentity(): GitIdentityStore {
  const store = loadGitIdentityStore();
  return writeStore({ version: STORE_VERSION, overrides: store.overrides });
}

export async function saveProjectGitIdentity(path: unknown, input: unknown): Promise<GitIdentityStore> {
  const identity = validateGitIdentityInput(input);
  const projectRoot = await canonicalOverridePath(path);
  const store = loadGitIdentityStore();
  const key = comparableProjectPath(projectRoot);
  const overrides = store.overrides.filter((override) => comparableProjectPath(override.path) !== key);
  overrides.push({ path: projectRoot, ...identity });
  return writeStore({ version: STORE_VERSION, ...(store.default ? { default: store.default } : {}), overrides });
}

/** Idempotent: clearing an override that was never there succeeds and writes an
 *  equivalent store, so the UI never has to distinguish "removed" from "gone". */
export async function clearProjectGitIdentity(path: unknown): Promise<GitIdentityStore> {
  const projectRoot = await canonicalOverridePath(path);
  const store = loadGitIdentityStore();
  const key = comparableProjectPath(projectRoot);
  const overrides = store.overrides.filter((override) => comparableProjectPath(override.path) !== key);
  if (overrides.length === store.overrides.length) return store;
  return writeStore({ version: STORE_VERSION, ...(store.default ? { default: store.default } : {}), overrides });
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** The whole resolution rule as a pure function of a store and a project root,
 *  so the ordering is testable without a checkout or a file. */
export function selectGitIdentity(input: { store: GitIdentityStore; projectRoot: string }): ResolvedGitIdentity | null {
  const { store, projectRoot } = input;
  const key = comparableProjectPath(projectRoot);
  const override = store.overrides.find((entry) => comparableProjectPath(entry.path) === key);
  if (override) return { identity: { name: override.name, email: override.email }, via: "project", projectRoot };
  if (store.default) return { identity: { name: store.default.name, email: store.default.email }, via: "default", projectRoot };
  return null;
}

/** The identity for a cwd, or `null` — an explicit state, never a guess. */
export async function resolveGitIdentity(input: { cwd?: string; store?: GitIdentityStore } = {}): Promise<ResolvedGitIdentity | null> {
  const { projectRoot } = await resolveProject(input.cwd ?? process.cwd());
  return selectGitIdentity({ store: input.store ?? loadGitIdentityStore(), projectRoot });
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** A child's identity environment. Plain string map because that is what every
 *  consumer merges it into — an `RpcProcessOptions.env`, a pty spawn env.
 *
 *  Empty means "no identity", never "an empty identity": git reads
 *  GIT_AUTHOR_EMAIL="" as an empty ident to be refused, which is the opposite of
 *  leaving it unset. */
export type GitIdentityEnv = Record<string, string>;

const NO_IDENTITY_ENV: GitIdentityEnv = {};

/** The four variables, or nothing at all. Pure, so delivery is testable without
 *  a checkout.
 *
 *  Never an `OMP_WEB_`-prefixed name: hostChildEnv() deletes that whole prefix
 *  before a child sees it, so an identity carried in one would be stripped on the
 *  way to git. These are git's own documented names, which is also why all four
 *  are written: author and committer are read independently, so setting only one
 *  pair leaves a commit attributed to someone and recorded by another. */
export function gitIdentityEnv(resolved: ResolvedGitIdentity | null | undefined): GitIdentityEnv {
  const identity = resolved?.identity;
  if (!identity || !identity.name || !identity.email) return NO_IDENTITY_ENV;
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

declare global {
  var __ompWebGitIdentityCache: Map<string, { env: GitIdentityEnv; expiresAt: number }> | undefined;
}

/** Matches lib/gh-env.ts and lib/file-access.ts: a bounded staleness against
 *  local state, dropped outright by the route on every write so an identity
 *  edited in Settings reaches the next child at once. It exists because
 *  /api/terminal/input attaches on every keystroke and each attach needs an
 *  environment. */
const IDENTITY_CACHE_TTL_MS = 5_000;
const IDENTITY_CACHE_MAX_ENTRIES = 64;

function cache(): Map<string, { env: GitIdentityEnv; expiresAt: number }> {
  if (!globalThis.__ompWebGitIdentityCache) globalThis.__ompWebGitIdentityCache = new Map();
  return globalThis.__ompWebGitIdentityCache;
}

export function invalidateGitIdentityCache(): void {
  globalThis.__ompWebGitIdentityCache?.clear();
}

/** The identity environment for a child about to be started in `cwd`. Never
 *  throws: a store it cannot read, or a path it cannot resolve, leaves the child
 *  exactly as the operator's own environment had it. */
export async function gitIdentityEnvForSpawn(cwd: string): Promise<GitIdentityEnv> {
  const entries = cache();
  const now = Date.now();
  const cached = entries.get(cwd);
  if (cached && cached.expiresAt > now) return cached.env;
  try {
    const env = gitIdentityEnv(await resolveGitIdentity({ cwd }));
    if (entries.size >= IDENTITY_CACHE_MAX_ENTRIES && !entries.has(cwd)) {
      entries.delete(entries.keys().next().value as string);
    }
    entries.set(cwd, { env, expiresAt: now + IDENTITY_CACHE_TTL_MS });
    return env;
  } catch {
    return NO_IDENTITY_ENV;
  }
}

// ---------------------------------------------------------------------------
// The route's write, as one dispatchable operation.
// ---------------------------------------------------------------------------

/**
 * Apply one settings write.
 *
 *   `{ name, email }`                      → the global default
 *   `{ project, name, email }`             → that repository's override
 *   `{ clear: true }`                      → remove the global default
 *   `{ project, clear: true }`             → remove that repository's override
 *
 * There is deliberately no read-by-cwd here. This is one global-plus-overrides
 * record, not a filesystem probe: GET takes no request at all, so a browser
 * cannot ask "which identity does <arbitrary directory> use" and be told.
 */
export async function applyGitIdentityUpdate(input: unknown): Promise<GitIdentityStore> {
  if (!isRecord(input)) throw new GitIdentityError("identity_invalid", "Identity must be an object");
  if (input.clear !== undefined && typeof input.clear !== "boolean") {
    throw new GitIdentityError("clear_invalid", "Clear must be a boolean");
  }
  const clear = input.clear === true;
  if (input.project !== undefined) {
    if (clear) return clearProjectGitIdentity(input.project);
    return saveProjectGitIdentity(input.project, { name: input.name, email: input.email });
  }
  if (clear) return clearDefaultGitIdentity();
  return saveDefaultGitIdentity({ name: input.name, email: input.email });
}
