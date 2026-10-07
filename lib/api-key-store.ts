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
    return { version: 1, backends: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { version: 1, backends: {} };
  }
  if (!isRecord(parsed) || !isRecord(parsed.backends)) return { version: 1, backends: {} };
  const backends: Record<string, StoredBackend> = {};
  for (const [id, value] of Object.entries(parsed.backends)) {
    if (!webSearchBackend(id) || !isRecord(value)) continue;
    const bucket: StoredBackend = {};
    for (const [env, envelope] of Object.entries(value)) {
      if (typeof envelope === "string") bucket[env] = envelope;
    }
    backends[id] = bucket;
  }
  return { version: 1, backends };
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
export function loadWebSearchEnv(): Record<string, string> {
  const store = readStore();
  const plain: Record<string, Record<string, string>> = {};
  for (const [id, bucket] of Object.entries(store.backends)) {
    const values: Record<string, string> = {};
    for (const [env, envelope] of Object.entries(bucket)) {
      const value = decryptSecretEnvelope(envelope);
      if (typeof value === "string") values[env] = value;
    }
    plain[id] = values;
  }
  return webSearchEnv(plain);
}