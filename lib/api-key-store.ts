import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAgentDir } from "./omp/paths";
import { isRecord } from "./type-guards";
import { decryptSecretEnvelope, encryptSecretEnvelope } from "./git-credentials";
import { webSearchBackend, webSearchEnv, validateWebSearchValues, WEB_SEARCH_BACKENDS } from "./web-search-backends";

/**
 * Encrypted storage for web-search credentials.
 *
 * The envelope is `lib/git-credentials.ts`'s AES-256-GCM primitive, reused
 * rather than reimplemented: one cipher, one key file, so there is a single
 * secret to back up and a single thing to rotate. The store file is separate
 * because the SHAPE is unrelated — a git credential is a host/account/token for
 * one repository, a web-search value is an env var for a search backend — and
 * forcing one into the other's schema would produce a "host" field that means
 * nothing.
 *
 * Server-side only, like every other credential reader here. `listWebSearchKeys`
 * is the only function a browser may call and it returns `hasValue` flags, never
 * a decrypted secret: an endpoint that answers with the key defeats the point of
 * encrypting it at rest.
 */
export const WEB_SEARCH_KEY_FILE = "web-search-keys.json";

interface StoredBackend {
  /** env var -> envelope. Only variables the backend declares are kept. */
  [env: string]: string;
}

interface WebSearchKeyStore {
  version: 1;
  backends: Record<string, StoredBackend>;
  /** models.yml provider id -> its env var name -> envelope. */
  providers: Record<string, StoredBackend>;
}

export interface WebSearchFieldStatus {
  env: string;
  label: string;
  kind: "apiKey" | "url" | "text";
  optional?: boolean;
  /** Whether a secret is stored. NEVER the secret. */
  hasValue: boolean;
}

export interface WebSearchBackendStatus {
  id: string;
  label: string;
  fields: WebSearchFieldStatus[];
  /** True when the backend has everything its required fields need. */
  configured: boolean;
}

export function webSearchKeysPath(): string {
  return resolve(getAgentDir(), WEB_SEARCH_KEY_FILE);
}

function readStore(): WebSearchKeyStore {
  let raw: string;
  try {
    raw = readFileSync(webSearchKeysPath(), "utf8");
  } catch {
    return { version: 1, backends: {}, providers: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { version: 1, backends: {}, providers: {} };
  }
  if (!isRecord(parsed) || !isRecord(parsed.backends)) return { version: 1, backends: {}, providers: {} };
  const backends: Record<string, StoredBackend> = {};
  for (const [id, value] of Object.entries(parsed.backends)) {
    if (!webSearchBackend(id) || !isRecord(value)) continue;
    const bucket: StoredBackend = {};
    for (const [env, envelope] of Object.entries(value)) {
      if (typeof envelope === "string") bucket[env] = envelope;
    }
    backends[id] = bucket;
  }
  const providers: Record<string, StoredBackend> = {};
  if (isRecord(parsed.providers)) {
    for (const [id, value] of Object.entries(parsed.providers)) {
      if (!isRecord(value)) continue;
      const bucket: StoredBackend = {};
      for (const [env, envelope] of Object.entries(value)) {
        if (isEnvVarName(env) && typeof envelope === "string") bucket[env] = envelope;
      }
      providers[id] = bucket;
    }
  }
  return { version: 1, backends, providers };
}

/**
 * Variables a credential store must never be able to write into a child's
 * environment, whatever the name looks like.
 *
 * `PATH` is the sharp one: it matches every naming rule below, so without this
 * denylist a hand-edited store entry called `PATH` would shadow the real PATH of
 * EVERY child process and redirect what `omp` and `git` execute. The rest are
 * the standard ways an environment variable becomes code execution.
 */
const RESERVED_ENV_NAMES: ReadonlySet<string> = new Set([
  "PATH", "HOME", "SHELL", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "NODE_OPTIONS",
  "NODE_PATH", "BASH_ENV", "ENV", "IFS", "PROMPT_COMMAND", "PS4",
  "OMP_WEB_OMP_BIN", "OMP_WEB_PASSWORD", "GIT_CONFIG_GLOBAL", "GIT_SSH_COMMAND",
]);

/** omp env var naming, and the shape hostChildEnv() will actually pass through. */
export function isEnvVarName(value: string): boolean {
  if (!/^[A-Z][A-Z0-9_]*$/.test(value)) return false;
  // hostChildEnv() deletes this whole prefix, so such a value would be stripped
  // before the child ever saw it — stored, encrypted, delivered, and useless.
  if (value.startsWith("OMP_WEB_")) return false;
  return !RESERVED_ENV_NAMES.has(value);
}

/** Atomic, 0600, temp file + rename — the same discipline as the git store. */
function writeStore(store: WebSearchKeyStore): void {
  const path = webSearchKeysPath();
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } finally {
    try {
      if (existsSync(temp)) rmSync(temp);
    } catch {
      // Nothing to do: the rename already succeeded or already failed.
    }
  }
}

/** Status for the settings screen. Contains no secret, by construction. */
export function listWebSearchKeys(): { path: string; backends: WebSearchBackendStatus[] } {
  const store = readStore();
  return {
    path: webSearchKeysPath(),
    backends: WEB_SEARCH_BACKENDS.map((backend) => {
      const stored = store.backends[backend.id] ?? {};
      const fields = backend.fields.map((field) => ({
        env: field.env,
        label: field.label,
        kind: field.kind,
        optional: field.optional,
        hasValue: typeof stored[field.env] === "string" && stored[field.env].length > 0,
      }));
      return {
        id: backend.id,
        label: backend.label,
        fields,
        configured: fields.every((field) => field.hasValue || field.optional === true),
      };
    }),
  };
}

/**
 * Store one backend's fields. Validation happens BEFORE anything is written, so
 * a rejected save cannot leave half a backend configured.
 */
export function saveWebSearchBackend(id: string, values: Record<string, string>): WebSearchBackendStatus {
  const backend = webSearchBackend(id);
  if (!backend) throw new Error(`Unknown web search backend: ${id}`);
  const validation = validateWebSearchValues(id, values);
  if (!validation.ok) throw new Error(validation.error);

  const store = readStore();
  const bucket: StoredBackend = {};
  for (const field of backend.fields) {
    const value = values[field.env];
    // Only the backend's own variables are written, so a hand-crafted request
    // cannot persist an arbitrary key that would later be exported to every
    // child process.
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    bucket[field.env] = encryptSecretEnvelope(trimmed);
  }
  if (Object.keys(bucket).length === 0) delete store.backends[id];
  else store.backends[id] = bucket;
  writeStore(store);

  const status = listWebSearchKeys().backends.find((entry) => entry.id === id);
  if (!status) throw new Error(`Unknown web search backend: ${id}`);
  return status;
}

/** Forget one backend entirely. */
export function deleteWebSearchBackend(id: string): { path: string } {
  if (!webSearchBackend(id)) throw new Error(`Unknown web search backend: ${id}`);
  const store = readStore();
  if (store.backends[id]) {
    delete store.backends[id];
    writeStore(store);
  }
  return { path: webSearchKeysPath() };
}

/**
 * The decrypted environment for a child process. Server-side only.
 *
 * A damaged or undecryptable envelope contributes nothing rather than throwing:
 * a key that cannot be read must not stop a session from starting, and omp
 * reports the absence of a search backend far better than omp-web can.
 */
function decryptAll(store: WebSearchKeyStore): Record<string, Record<string, string>> {
  const plain: Record<string, Record<string, string>> = {};
  for (const [id, bucket] of Object.entries(store.backends)) {
    const values: Record<string, string> = {};
    for (const [env, envelope] of Object.entries(bucket)) {
      const value = decryptSecretEnvelope(envelope);
      if (typeof value === "string") values[env] = value;
    }
    plain[id] = values;
  }
  return plain;
}

export function loadWebSearchEnv(): Record<string, string> {
  return webSearchEnv(decryptAll(readStore()));
}

/**
 * The decrypted environment for a child process, for BOTH kinds of secret.
 *
 * Provider keys are merged as-is because their env var name is the one the
 * provider's models.yml entry declares, and the store only accepts a
 * conventional upper-case name at write time — so nothing stored here can
 * shadow PATH or LD_PRELOAD. Server-side only.
 */
export function loadOmpSecretEnv(): Record<string, string> {
  const store = readStore();
  const env: Record<string, string> = { ...webSearchEnv(decryptAll(store)) };
  for (const bucket of Object.entries(store.providers).map(([, value]) => value)) {
    for (const [name, envelope] of Object.entries(bucket)) {
      const value = decryptSecretEnvelope(envelope);
      if (typeof value === "string" && value.length > 0) env[name] = value;
    }
  }
  return env;
}

// ---------------------------------------------------------------------------
// Model-provider credentials
//
// A provider's secret lives here, encrypted, under the env var its models.yml
// entry declares. omp-web never writes the literal into models.yml: the file
// names `envVars: ["X_PROV_API_KEY"]` and the value is injected into the child
// process, the same way GH_TOKEN and the web-search keys are.
//
// Deliberately NOT `apiKey: ENV_NAME` in models.yml. That convention exists,
// but omp shipped a bug where the env var's NAME was sent as the key, making
// models fail to load or disappear outright (omp PR #13815). `envVars` is what
// omp's own catalog uses — `"zai": {"envVars":["ZAI_API_KEY"]}` — so it is the
// mechanism that is observed to work.
// ---------------------------------------------------------------------------

export interface ProviderKeyStatus {
  providerId: string;
  envVar: string;
  /** Presence only. A route may return this; it may never return the secret. */
  hasValue: boolean;
}

export function listProviderKeys(): { path: string; providers: ProviderKeyStatus[] } {
  const store = readStore();
  const providers: ProviderKeyStatus[] = [];
  for (const [providerId, bucket] of Object.entries(store.providers)) {
    for (const [envVar, envelope] of Object.entries(bucket)) {
      providers.push({ providerId, envVar, hasValue: envelope.length > 0 });
    }
  }
  providers.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.envVar.localeCompare(b.envVar));
  return { path: webSearchKeysPath(), providers };
}

export function saveProviderKey(providerId: string, envVar: string, value: string): ProviderKeyStatus {
  const id = providerId.trim();
  if (!id) throw new Error("providerId is required");
  if (!isEnvVarName(envVar)) {
    throw new Error(`Invalid environment variable name: ${envVar}`);
  }
  const trimmed = value.trim();
  if (!trimmed) throw new Error("value is required");
  const store = readStore();
  const bucket = { ...(store.providers[id] ?? {}), [envVar]: encryptSecretEnvelope(trimmed) };
  store.providers[id] = bucket;
  writeStore(store);
  return { providerId: id, envVar, hasValue: true };
}

export function deleteProviderKey(providerId: string, envVar?: string): { path: string } {
  const store = readStore();
  const id = providerId.trim();
  if (envVar) {
    const bucket = store.providers[id];
    if (bucket) {
      delete bucket[envVar];
      if (Object.keys(bucket).length === 0) delete store.providers[id];
      writeStore(store);
    }
  } else if (store.providers[id]) {
    delete store.providers[id];
    writeStore(store);
  }
  return { path: webSearchKeysPath() };
}
