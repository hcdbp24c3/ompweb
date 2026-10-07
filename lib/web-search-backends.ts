/**
 * Web-search backends and the environment variables omp actually reads for them.
 *
 * Every name here was read out of the omp binary, not guessed. Two facts from
 * that reading shape this whole module:
 *
 * 1. **Not every backend wants an API key.** DuckDuckGo appears in the binary
 *    with no credential variable at all, and SearXNG wants an ENDPOINT plus
 *    optional basic-auth, not a token. So the model is "a set of named fields
 *    per backend", not "one apiKey string per backend" — a one-key-per-backend
 *    editor would be unable to express SearXNG at all, and would invent a key
 *    field for DuckDuckGo that goes nowhere.
 *
 * 2. **omp reads these from the environment, not from config.yml.** The binary
 *    harvests `exaApiKeys` out of MCP server definitions and assigns it to
 *    `Bun.env.EXA_API_KEY`; there is no `webSearch.apiKey` in the settings
 *    schema (`webSearch` is a builtin TOOL group under `builtins`, sibling to
 *    `bash` and `grep`). So omp-web owns the secret and hands it down as an env
 *    var, the same way `lib/gh-env.ts` hands `GH_TOKEN` to a child.
 */
export type WebSearchBackendId = "brave" | "duckduckgo" | "exa" | "jina" | "perplexity" | "searxng" | "tavily";

export interface WebSearchField {
  /** The environment variable omp reads. */
  env: string;
  label: string;
  kind: "apiKey" | "url" | "text";
  /** Optional fields may be left empty; a required one may not. */
  optional?: boolean;
}

/**
 * `duckduckgo` is listed with no fields on purpose — it needs no credential,
 * and omitting it from the set entirely would hide a backend that works today.
 */
export const WEB_SEARCH_BACKENDS: ReadonlyArray<{ id: WebSearchBackendId; label: string; fields: readonly WebSearchField[] }> = [
  { id: "brave", label: "Brave Search", fields: [{ env: "BRAVE_API_KEY", label: "API key", kind: "apiKey" }] },
  { id: "duckduckgo", label: "DuckDuckGo", fields: [] },
  { id: "exa", label: "Exa", fields: [{ env: "EXA_API_KEY", label: "API key", kind: "apiKey" }] },
  { id: "jina", label: "Jina", fields: [{ env: "JINA_API_KEY", label: "API key", kind: "apiKey" }] },
  { id: "perplexity", label: "Perplexity", fields: [{ env: "PERPLEXITY_API_KEY", label: "API key", kind: "apiKey" }] },
  {
    id: "searxng",
    label: "SearXNG",
    fields: [
      { env: "SEARXNG_ENDPOINT", label: "Endpoint URL", kind: "url" },
      { env: "SEARXNG_BASIC_USERNAME", label: "Username", kind: "text", optional: true },
      { env: "SEARXNG_BASIC_PASSWORD", label: "Password", kind: "apiKey", optional: true },
    ],
  },
  { id: "tavily", label: "Tavily", fields: [{ env: "TAVILY_API_KEY", label: "API key", kind: "apiKey" }] },
];

const BY_ID = new Map(WEB_SEARCH_BACKENDS.map((backend) => [backend.id, backend]));

export function isWebSearchBackendId(value: unknown): value is WebSearchBackendId {
  return typeof value === "string" && BY_ID.has(value as WebSearchBackendId);
}

export function webSearchBackend(id: string): { id: WebSearchBackendId; label: string; fields: readonly WebSearchField[] } | undefined {
  return BY_ID.get(id as WebSearchBackendId);
}

/** The env vars a backend's fields map onto, for a settings screen. */
export function webSearchFieldsFor(id: string): readonly WebSearchField[] {
  return BY_ID.get(id as WebSearchBackendId)?.fields ?? [];
}

/**
 * The environment for a child process, from stored values.
 *
 * Only fields the backend actually declares are emitted. An empty value is
 * SKIPPED rather than emitted as `""`: a program that checks whether a variable
 * is set treats an empty string as "configured, and wrong", which produces a
 * confusing auth failure instead of "no search backend configured".
 */
export function webSearchEnv(
  stored: Readonly<Record<string, Readonly<Record<string, string>>>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const backend of WEB_SEARCH_BACKENDS) {
    const values = stored[backend.id];
    if (!values) continue;
    for (const field of backend.fields) {
      const value = values[field.env];
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (!trimmed) continue;
      env[field.env] = trimmed;
    }
  }
  return env;
}

/**
 * A required field left blank makes the backend unusable, and the failure would
 * surface much later as an opaque 401 from omp. Caught at save time instead.
 */
export function validateWebSearchValues(
  backendId: string,
  values: Readonly<Record<string, string>>,
): { ok: true } | { ok: false; error: string } {
  const backend = webSearchBackend(backendId);
  if (!backend) return { ok: false, error: `Unknown web search backend: ${backendId}` };
  for (const field of backend.fields) {
    const value = values[field.env];
    const filled = typeof value === "string" && value.trim().length > 0;
    if (!filled && !field.optional) {
      return { ok: false, error: `${backend.label}: ${field.label} is required` };
    }
  }
  return { ok: true };
}