import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAgentDir } from "./omp/paths";
import { isRecord } from "./type-guards";

// ============================================================================
// Named git credentials (PAT / SSH) stored next to omp's session files.
//
// The store lives under getAgentDir() because that is the only path on the
// persisted volume: ~/.config/gh and ~/.ssh sit in the container layer and are
// gone after a recreate.
//
// Two properties make this the first secret-holding ~/.omp/agent/*.json:
//
// 1. Both files are written 0o600. projects.json and omp-web-settings.json are
//    world-readable, and copying that precedent here would expose every token
//    and private key to any other process in the container. See the mode in
//    writeSecretFile() and the same 0o600 discipline in bin/service-env.js:69
//    (web password) and bin/omp-web.js:233 (update control files).
// 2. Secrets are AES-256-GCM ciphertext, keyed by a LOCAL key file — never by
//    rotatable material such as OMP_WEB_PASSWORD. Rotating the web password
//    would otherwise orphan every stored SSH key with no way to recover it.
//    The cost is explicit: delete git-credentials.key and every stored secret
//    becomes permanently unreadable, so the UI says so next to the file path.
//    Losing the key does NOT delete the store, and a metadata-only edit keeps
//    the ciphertext intact, so restoring the key file recovers the secrets.
//
// Secrets are write-only across the API boundary: listGitCredentials() builds a
// fresh summary object rather than spreading the record, so no GET — and not
// even the PUT response — can serialize a token, key, or passphrase. This is
// the same boundary redactMcpServer() draws for MCP `env`/`headers`.
//
// Whatever hands these credentials to git must NOT carry a secret in an
// OMP_WEB_* environment variable: hostChildEnv() strips that prefix from every
// child env, so the secret would be deleted before git ever saw it.
//
// Known limit: the write is atomic (temp + rename), so a crash never leaves a
// torn store, but it is a read-modify-write with no cross-process lock. The dev
// server (30178) and the installed app (30177) editing two credentials at the
// same instant can lose the later one — the same window projects.json and
// omp-web-settings.json have. Add a lockfile like withMcpConfigLock() before
// treating that as a bug.
// ============================================================================

export type GitCredentialType = "pat" | "ssh";

/** Everything the browser may see. Secret fields are deliberately absent. */
export interface GitCredentialSummary {
  id: string;
  name: string;
  host: string;
  account: string;
  type: GitCredentialType;
  isDefaultForHost: boolean;
  hasToken: boolean;
  hasPrivateKey: boolean;
  hasPassphrase: boolean;
}

/** A fully decrypted credential — server-side only, never serialized. */
export interface GitCredential extends GitCredentialSummary {
  token?: string;
  privateKey?: string;
  passphrase?: string;
}

const SECRET_FIELDS = ["token", "privateKey", "passphrase"] as const;
type SecretField = (typeof SECRET_FIELDS)[number];

export const GIT_CREDENTIAL_FILE = "git-credentials.json";
export const GIT_CREDENTIAL_KEY_FILE = "git-credentials.key";

const STORE_VERSION = 1;
const CIPHER = "aes-256-gcm";
const ENVELOPE_PREFIX = "v1";
const KEY_BYTES = 32;
const MAX_CREDENTIALS = 100;
const MAX_SECRET_BYTES = 256 * 1024;
const MAX_NAME = 80;
const MAX_HOST = 255;
const MAX_ACCOUNT = 128;
/** Same charset as subagent ids: filesystem-safe on every platform. */
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{1,80}$/;
const HOST = /^[A-Za-z0-9._:[\]-]+$/;

/** The on-disk record: metadata plus ciphertext, never plaintext. */
interface StoredGitCredential {
  id: string;
  name: string;
  host: string;
  account: string;
  type: GitCredentialType;
  isDefaultForHost: boolean;
  secrets?: Partial<Record<SecretField, string>>;
}

export interface GitCredentialStore {
  version: number;
  credentials: StoredGitCredential[];
}

export interface ValidatedGitCredentialInput {
  name: string;
  host: string;
  account: string;
  type: GitCredentialType;
  isDefaultForHost: boolean;
  token?: string;
  privateKey?: string;
  passphrase?: string;
}

/** Error carrying a stable code for client localization. */
export class GitCredentialError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GitCredentialError";
    this.code = code;
  }
}

export function gitCredentialsPath(): string {
  return resolve(getAgentDir(), GIT_CREDENTIAL_FILE);
}

export function gitCredentialKeyPath(): string {
  return resolve(getAgentDir(), GIT_CREDENTIAL_KEY_FILE);
}

// ---------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------

/** Read the local key. `undefined` means "cannot decrypt", never "throw":
 *  a missing or damaged key file must degrade to a readable, secret-less list. */
function readKey(): Buffer | undefined {
  let raw: string;
  try {
    raw = readFileSync(gitCredentialKeyPath(), "utf8");
  } catch {
    return undefined;
  }
  const key = Buffer.from(raw.trim(), "base64");
  return key.length === KEY_BYTES ? key : undefined;
}

/** The local key, created on first use. An existing but unusable key file is
 *  refused rather than regenerated — silently minting a new one would orphan
 *  every stored secret while appearing to succeed. */
function ensureKey(): Buffer {
  const path = gitCredentialKeyPath();
  let raw: string | null = null;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    raw = null;
  }
  if (raw !== null) {
    const key = Buffer.from(raw.trim(), "base64");
    if (key.length !== KEY_BYTES) {
      throw new GitCredentialError(
        "key_unreadable",
        `${path} is not a usable ${KEY_BYTES}-byte key. Restore it, or delete it to generate a new one (stored secrets become unreadable).`,
      );
    }
    return key;
  }
  const key = randomBytes(KEY_BYTES);
  writeSecretFile(path, key.toString("base64"));
  return key;
}

function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, ensureKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    ENVELOPE_PREFIX,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function decryptSecret(envelope: unknown): string | undefined {
  if (typeof envelope !== "string") return undefined;
  const [prefix, iv, tag, payload] = envelope.split(".");
  if (prefix !== ENVELOPE_PREFIX || !iv || !tag || !payload) return undefined;
  const key = readKey();
  if (!key) return undefined;
  try {
    const decipher = createDecipheriv(CIPHER, key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(payload, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key or tampered ciphertext: the record stays visible, its secret
    // does not. Re-encrypting here would destroy a recoverable ciphertext.
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function requiredString(value: unknown, code: string, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new GitCredentialError(code, `${label} is required`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new GitCredentialError(code, `${label} must be at most ${max} characters`);
  return trimmed;
}

function normalizeHost(value: unknown): string {
  const host = requiredString(value, "host_invalid", "Host", MAX_HOST);
  // No scheme, no `user@`, no path: the host is matched against git remotes and
  // must never carry a credential or a URL.
  if (!HOST.test(host)) throw new GitCredentialError("host_invalid", "Host must be a bare host name — no scheme, user, or path");
  return host.toLowerCase();
}

function normalizeAccount(value: unknown): string {
  const account = requiredString(value, "account_required", "Account", MAX_ACCOUNT);
  for (const char of account) {
    const code = char.codePointAt(0) ?? 0;
    if (char.trim() === "" || code < 0x20 || code === 0x7f) {
      throw new GitCredentialError("account_required", "Account must not contain whitespace or control characters");
    }
  }
  return account;
}

/** An empty string means "leave empty to keep the existing secret" — the UI
 *  shows a masked placeholder instead of the stored value, so a save that does
 *  not touch the secret must not wipe it. */
function optionalSecret(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new GitCredentialError("secret_invalid", `${label} must be a string`);
  if (!value) return undefined;
  if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
    throw new GitCredentialError("secret_invalid", `${label} must be at most ${MAX_SECRET_BYTES} bytes`);
  }
  return value;
}

/** Validate and normalize one payload. `existing` is the stored record being
 *  replaced, so an omitted secret can be validated against the stored one. */
export function validateGitCredentialInput(input: unknown, existing?: StoredGitCredential): ValidatedGitCredentialInput {
  if (!isRecord(input)) throw new GitCredentialError("credential_invalid", "Credential must be an object");
  const name = requiredString(input.name, "name_required", "Name", MAX_NAME);
  const host = normalizeHost(input.host);
  // `account` is what makes per-owner selection possible downstream, so it is
  // required rather than optional metadata.
  const account = normalizeAccount(input.account);
  const type = input.type === "ssh" ? "ssh" : input.type === "pat" ? "pat" : null;
  if (!type) throw new GitCredentialError("type_invalid", "Type must be pat or ssh");
  if (input.isDefaultForHost !== undefined && typeof input.isDefaultForHost !== "boolean") {
    throw new GitCredentialError("default_invalid", "Default for host must be a boolean");
  }
  const token = optionalSecret(input.token, "Token");
  const privateKey = optionalSecret(input.privateKey, "Private key");
  const passphrase = optionalSecret(input.passphrase, "Passphrase");
  if (type === "pat" && token === undefined && !existing?.secrets?.token) {
    throw new GitCredentialError("token_required", "A personal access token is required");
  }
  if (type === "ssh" && privateKey === undefined && !existing?.secrets?.privateKey) {
    throw new GitCredentialError("private_key_required", "A private key is required for an ssh credential");
  }
  return {
    name,
    host,
    account,
    type,
    isDefaultForHost: input.isDefaultForHost === true,
    ...(token !== undefined ? { token } : {}),
    ...(privateKey !== undefined ? { privateKey } : {}),
    ...(passphrase !== undefined ? { passphrase } : {}),
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Atomic write, owner-readable only. This is the ONE writer in the agent dir
 *  that passes a mode: it is the first file here that holds a secret. The
 *  explicit chmod after the rename covers a store that was loosened out of
 *  band (a copy, a container volume restore, an older umask). */
function writeSecretFile(path: string, contents: string): void {
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

function pickSecrets(raw: Record<string, unknown>): Partial<Record<SecretField, string>> | undefined {
  const secrets: Partial<Record<SecretField, string>> = {};
  for (const field of SECRET_FIELDS) {
    const value = raw[field];
    if (typeof value === "string" && value) secrets[field] = value;
  }
  return Object.keys(secrets).length > 0 ? secrets : undefined;
}

/** Parse the store; a missing, corrupt, or foreign-shaped file degrades to an
 *  empty store rather than throwing, exactly like parseProjectRegistry. */
export function parseGitCredentialStore(raw: string): GitCredentialStore {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.credentials)) return { version: STORE_VERSION, credentials: [] };
    const credentials: StoredGitCredential[] = [];
    for (const item of parsed.credentials) {
      if (!isRecord(item)) continue;
      const id = typeof item.id === "string" ? item.id : "";
      const name = typeof item.name === "string" ? item.name.trim() : "";
      const host = typeof item.host === "string" ? item.host.trim().toLowerCase() : "";
      const account = typeof item.account === "string" ? item.account.trim() : "";
      const type = item.type === "ssh" ? "ssh" : item.type === "pat" ? "pat" : null;
      if (!CREDENTIAL_ID.test(id) || !name || !host || !account || !type) continue;
      const secrets = isRecord(item.secrets) ? pickSecrets(item.secrets) : undefined;
      credentials.push({
        id,
        name,
        host,
        account,
        type,
        isDefaultForHost: item.isDefaultForHost === true,
        ...(secrets ? { secrets } : {}),
      });
    }
    return { version: STORE_VERSION, credentials };
  } catch {
    return { version: STORE_VERSION, credentials: [] };
  }
}

function readStoredCredentials(): GitCredentialStore {
  try {
    return parseGitCredentialStore(readFileSync(gitCredentialsPath(), "utf8"));
  } catch {
    return { version: STORE_VERSION, credentials: [] };
  }
}

/** Only the secrets that belong to the credential's type are ever stored or
 *  exposed, so a type change drops the fields it no longer applies to. */
function secretFieldsFor(type: GitCredentialType): readonly SecretField[] {
  return type === "pat" ? (["token"] as const) : (["privateKey", "passphrase"] as const);
}

function toSummary(stored: StoredGitCredential): GitCredentialSummary {
  return {
    id: stored.id,
    name: stored.name,
    host: stored.host,
    account: stored.account,
    type: stored.type,
    isDefaultForHost: stored.isDefaultForHost,
    hasToken: stored.type === "pat" && Boolean(stored.secrets?.token),
    hasPrivateKey: stored.type === "ssh" && Boolean(stored.secrets?.privateKey),
    hasPassphrase: stored.type === "ssh" && Boolean(stored.secrets?.passphrase),
  };
}

function toGitCredential(stored: StoredGitCredential): GitCredential {
  const token = decryptSecret(stored.secrets?.token);
  const privateKey = decryptSecret(stored.secrets?.privateKey);
  const passphrase = decryptSecret(stored.secrets?.passphrase);
  return {
    ...toSummary(stored),
    ...(token !== undefined ? { token } : {}),
    ...(privateKey !== undefined ? { privateKey } : {}),
    ...(passphrase !== undefined ? { passphrase } : {}),
  };
}

/** Server-side only: the decrypted list. Never return this from a route. */
export function loadGitCredentials(): GitCredential[] {
  return readStoredCredentials().credentials.map(toGitCredential);
}

/** The browser's view: paths and flags, no secret of any kind. */
export function listGitCredentials(): { path: string; credentials: GitCredentialSummary[] } {
  return { path: gitCredentialsPath(), credentials: readStoredCredentials().credentials.map(toSummary) };
}

function requestedIdOf(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!id) return undefined;
  if (!CREDENTIAL_ID.test(id)) throw new GitCredentialError("id_invalid", "Credential id may contain letters, numbers, dashes, and underscores");
  return id;
}

export function saveGitCredential(input: unknown): GitCredential {
  const store = readStoredCredentials();
  const requestedId = requestedIdOf(input);
  const existing = requestedId ? store.credentials.find((credential) => credential.id === requestedId) : undefined;
  const normalized = validateGitCredentialInput(input, existing);
  const id = existing?.id ?? requestedId ?? randomUUID();
  if (!existing && store.credentials.length >= MAX_CREDENTIALS) {
    throw new GitCredentialError("too_many", `At most ${MAX_CREDENTIALS} git credentials can be stored`);
  }
  const secrets: Partial<Record<SecretField, string>> = {};
  for (const field of secretFieldsFor(normalized.type)) {
    const provided = normalized[field];
    if (provided !== undefined) secrets[field] = encryptSecret(provided);
    // An omitted secret keeps the stored ciphertext VERBATIM. It is never
    // decrypted and re-encrypted, so a metadata edit cannot destroy a secret
    // that is only unreadable right now (damaged key file, rotated key).
    else if (existing?.secrets?.[field]) secrets[field] = existing.secrets[field];
  }
  const record: StoredGitCredential = {
    id,
    name: normalized.name,
    host: normalized.host,
    account: normalized.account,
    type: normalized.type,
    isDefaultForHost: normalized.isDefaultForHost,
    ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
  };
  // The host default is exclusive: promoting one credential retires the
  // previous default for that host and leaves every other host alone.
  const others = store.credentials
    .filter((credential) => credential.id !== id)
    .map((credential) => (record.isDefaultForHost && credential.host === record.host
      ? { ...credential, isDefaultForHost: false }
      : credential));
  writeSecretFile(gitCredentialsPath(), `${JSON.stringify({ version: STORE_VERSION, credentials: [...others, record] }, null, 2)}\n`);
  return toGitCredential(record);
}

export function deleteGitCredential(id: unknown): { path: string } {
  const target = typeof id === "string" ? id.trim() : "";
  if (!CREDENTIAL_ID.test(target)) {
    throw new GitCredentialError("id_invalid", "Credential id may contain letters, numbers, dashes, and underscores");
  }
  const store = readStoredCredentials();
  if (!store.credentials.some((credential) => credential.id === target)) {
    throw new GitCredentialError("credential_not_found", "Git credential was not found");
  }
  writeSecretFile(gitCredentialsPath(), `${JSON.stringify({ version: STORE_VERSION, credentials: store.credentials.filter((credential) => credential.id !== target) }, null, 2)}\n`);
  return { path: gitCredentialsPath() };
}

/** The key file lives beside the store; the UI shows it so the user knows what
 *  a backup must include and what deleting it costs. */
export function gitCredentialsFiles(): { path: string; keyPath: string } {
  return { path: gitCredentialsPath(), keyPath: gitCredentialKeyPath() };
}
