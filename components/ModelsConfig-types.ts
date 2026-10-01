// Shared models.yml types, constants, and pure helpers extracted from
// ModelsConfig.tsx (pure extraction, no behavior change).

export type IconComponent = React.ComponentType<{ size?: number | string; style?: React.CSSProperties }>;

// Provider glyphs are derived from the provider id. Provider ids come from
// OMP/models.yml at runtime, so adding one never requires a UI registry entry.

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OAuthProvider {
  id: string;
  name: string;
  usesCallbackServer: boolean;
  loggedIn: boolean;
}

export interface ApiKeyProvider {
  id: string;
  displayName: string;
  configured: boolean;
  modelCount: number;
}

export type OAuthLoginState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "auth"; url: string; instructions: string | null; token: string }
  | { phase: "device_code"; userCode: string; verificationUri: string; intervalSeconds: number | null; expiresInSeconds: number | null }
  | { phase: "prompt"; message: string; placeholder: string | null; token: string }
  | { phase: "select"; message: string; options: { id: string; label: string }[]; token: string }
  | { phase: "progress"; message: string }
  | { phase: "success" }
  | { phase: "error"; message: string };

// Mirrors the ModelThinkingSchema subset of omp's models.yml
// (oh-my-pi/packages/coding-agent/src/config/models-config-schema.ts).
export interface ThinkingConfig {
  mode?: string;
  efforts?: string[];
  defaultLevel?: string;
  effortMap?: Record<string, string>;
}

// Option lists are copied from omp's schema bundles, not from its docs: the
// docs omit `apple-foundation-models`, and the two extra api ids only exist in
// the schema. The union types are derived from the lists so a value can never
// be valid for the type and missing from the dropdown (or vice versa).
export const DISCOVERY_TYPES = [
  "ollama",
  "llama.cpp",
  "lm-studio",
  "openai-models-list",
  "proxy",
  "litellm",
  "apple-foundation-models",
] as const;
export type DiscoveryType = typeof DISCOVERY_TYPES[number];

export const TOKENIZER_OPTIONS = [
  "claude-v3",
  "claude-v47",
  "claude-v5",
  "claude-v5-sonnet",
  "qwen3",
  "deepseek-v3",
  "kimi-k2",
  "glm5",
] as const;
export type Tokenizer = typeof TOKENIZER_OPTIONS[number];

/** omp's ProviderAuthSchema (models-config-schema-bundle.ts). `auth` says where
 *  the credential comes from, which is why it is a select and not a checkbox:
 *  `apiKey` (the default when unset), `none`, and `oauth` — the credential omp
 *  already holds for that provider id. */
export const AUTH_MODES = ["apiKey", "none", "oauth"] as const;
export type AuthMode = typeof AUTH_MODES[number];

export const isAuthMode = (value: string): value is AuthMode =>
  (AUTH_MODES as readonly string[]).includes(value);

/** Every row the auth select offers: the three known modes, then whatever the
 *  file declares. AUTH_MODES is omp's enum, not a promise that models.yml only
 *  ever contains those three — a hand-written provider can name anything, and a
 *  select that cannot display it drops the value on the next unrelated save
 *  (`mergeNode` deletes every key the payload omits). */
export const authRows = (declared: string | undefined): string[] =>
  declared && !isAuthMode(declared) ? [...AUTH_MODES, declared] : [...AUTH_MODES];

/** True when `auth` leaves `apiKey` to mean nothing at all — i.e. models.yml has
 *  no key to show and omp will not send one. That is only `auth: none`, which
 *  omp records in `keylessProviders` (model-registry.ts:1602-1604); unset is
 *  omp's `apiKey` default.
 *
 *  Deliberately NOT true for `oauth`: `auth: oauth` only forces OAuth-style
 *  request shaping (`resolveCustomModelIsOAuth` in custom-models.ts:57-62), and
 *  omp still feeds `providerApiKey` into the Bearer header resolver
 *  (`mergeCustomModelHeaders(…, authHeader, providerApiKey)` at :100). A
 *  Claude-Code-style proxy behind `auth: oauth` legitimately carries both, so
 *  hiding or clearing the key there would delete a value omp still reads. An
 *  unrecognised mode is treated the same way: never destroy what we cannot
 *  explain. */
export const authIsKeyless = (auth: string | undefined): boolean => auth === "none";

/** Lets omp ask the server for the model list instead of the user writing it
 * out. `injectV1` only applies to `openai-models-list` (omp's schema rejects
 * it elsewhere), and `proxy` is the one type that needs no provider-level api. */
export interface ProviderDiscovery {
  type: DiscoveryType;
  timeoutMs?: number;
  injectV1?: boolean;
}

export interface ModelEntry {
  id: string;
  name?: string;
  api?: string;
  /** Per-model endpoint override; the provider's baseUrl is used when absent. */
  baseUrl?: string;
  reasoning?: boolean;
  thinking?: ThinkingConfig;
  input?: string[];
  contextWindow?: number;
  /** Upper bound of the variable context window; must be >= contextWindow. */
  maxContextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  supportsTools?: boolean;
  tokenizer?: Tokenizer;
  omitMaxOutputTokens?: boolean;
  premiumMultiplier?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  compat?: Record<string, unknown>;
}

export interface ProviderEntry {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  auth?: AuthMode;
  headers?: Record<string, string>;
  discovery?: ProviderDiscovery;
  authHeader?: boolean;
  disableStrictTools?: boolean;
  compat?: Record<string, unknown>;
  models?: ModelEntry[];
  modelOverrides?: Record<string, unknown>;
}

export interface ModelsFileData {
  providers?: Record<string, ProviderEntry>;
}

/** One row of `/api/models-config/discover`'s response. `contextWindow` /
 *  `maxTokens` are `null` when the server does not report them, which is not
 *  the same as a models.yml entry — see `discoveredToModelEntry`. */
export interface DiscoveredModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  thinking?: ThinkingConfig;
  input?: string[];
  contextWindow?: number | null;
  maxTokens?: number | null;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

/** Why a discovery came back with no models, when the route could tell.
 *  `discovery_returned_nothing` means omp ran the configured discovery and
 *  resolved nothing — omp reports that as its generic "No models available" boot
 *  refusal, so the route translates it. Absent when the server answered with an
 *  honest empty list (or the route could not distinguish the two).
 *  Mirrors `DISCOVERY_EMPTY_REASON` in app/api/models-config/discover/route.ts. */
export type DiscoverEmptyReason = "discovery_returned_nothing";

/** Prefills a models.yml model entry from a discovered model. `null` becomes
 *  `undefined` so an unreported limit is omitted instead of written as `null`. */
export function discoveredToModelEntry(model: DiscoveredModel): ModelEntry {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    thinking: model.thinking,
    input: model.input,
    contextWindow: model.contextWindow ?? undefined,
    maxTokens: model.maxTokens ?? undefined,
    cost: model.cost,
  };
}

export type ModelTestState =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "success"; latencyMs?: number; status?: number; responseText?: string }
  | { phase: "error"; message: string; latencyMs?: number; status?: number };

export type Selection =
  | { type: "provider"; name: string }
  | { type: "model"; providerName: string; index: number }
  | { type: "oauth"; providerId: string }
  | { type: "apikey"; providerId: string }
  | { type: "roles" }
  | { type: "picker" }
  | { type: "registry" }
  | { type: "fallbacks" };
export interface RuntimeModelEntry {
  id: string;
  name: string;
  provider: string;
  thinkingLevels?: string[];
}

export interface ConnectedProvider {
  id: string;
  name: string;
  disabled: boolean;
}

export type NativeRegistrySettings = {
  enabledModels?: string[];
  disabledProviders?: string[];
  modelProviderOrder?: string[];
  registryHasScopedEntries?: boolean;
};

export type RetrySettings = {
  retry?: { enabled?: boolean; maxRetries?: number; modelFallback?: boolean; fallbackRevertPolicy?: "cooldown-expiry" | "never"; fallbackChains?: Record<string, string[]> };
};
export const COMPOSER_MODELS_STORAGE_KEY = "omp-composer-models";
export const NATIVE_MODEL_ROLES = ["default", "smol", "slow", "vision", "plan", "designer", "commit", "tiny", "task", "advisor"];
// omp's models.yml ApiSchema (config/models-config-schema-bundle.ts)
export const API_OPTIONS = [
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
  "anthropic-messages",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-gemini-cli",
  "google-vertex",
  "openrouter-decisions",
  "typesafe",
] as const;
export const hoverRow = (selected: boolean) => ({
  onMouseEnter: (e: React.MouseEvent<HTMLElement>) => { if (!selected) e.currentTarget.style.background = "var(--bg-hover)"; },
  onMouseLeave: (e: React.MouseEvent<HTMLElement>) => { if (!selected) e.currentTarget.style.background = "none"; },
});

export const hoverAccent = {
  onMouseEnter: (e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.color = "var(--accent)"; e.currentTarget.style.borderColor = "var(--accent)"; },
  onMouseLeave: (e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.borderColor = "var(--border)"; },
};
export type EndpointPreset = {
  label: string;
  baseUrl: string;
  /** "none" forces no-auth; "apiKey" forces key-based auth; "keep" preserves the current auth mode. */
  auth: "none" | "apiKey" | "keep";
};

export const ENDPOINT_PRESETS: EndpointPreset[] = [
  { label: "🦙 Ollama", baseUrl: "http://localhost:11434/v1", auth: "none" },
  { label: "⚡ LM Studio / vLLM", baseUrl: "http://localhost:1234/v1", auth: "none" },
  { label: "🌐 OpenRouter", baseUrl: "https://openrouter.ai/api/v1", auth: "apiKey" },
  { label: "🤖 Local Proxy (:2455)", baseUrl: "http://127.0.0.1:2455/v1", auth: "keep" },
];

export const presetButtonStyle = {
  padding: "4px 8px",
  fontSize: 11,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg)",
  color: "var(--text)",
  cursor: "pointer",
} as const;
export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];

export const LEVEL_COLORS: Record<ThinkingLevel, string> = {
  minimal: "var(--text-dim)",
  low:     "color-mix(in srgb, var(--accent) 45%, var(--text-muted))",
  medium:  "var(--accent)",
  high:    "var(--accent-hover)",
  xhigh:   "var(--status-warning)",
  max:     "var(--status-error)",
};

// ── Thinking ladder ──────────────────────────────────────────────────────────
// THINKING_LEVELS is the six levels omp's own registry happens to use, not the
// schema: models.yml is hand-written and omp's catalog declares levels outside
// it. Rebuilding `efforts` from this list therefore deleted every other effort
// the next time the user touched an unrelated field, so the editor works on a
// union instead — known levels in canonical order, then whatever the file has.

/** omp's ModelThinkingSchema mode enum (models-config-schema-bundle.ts). */
export const THINKING_MODES = [
  "effort",
  "budget",
  "google-level",
  "anthropic-adaptive",
  "anthropic-budget-effort",
] as const;
export type ThinkingMode = typeof THINKING_MODES[number];

export const isThinkingLevel = (value: string): value is ThinkingLevel =>
  (THINKING_LEVELS as readonly string[]).includes(value);

/** Efforts the file already declares that THINKING_LEVELS has never heard of. */
export const unknownThinkingEfforts = (efforts: string[] | undefined): string[] =>
  (efforts ?? []).filter((effort) => !isThinkingLevel(effort));

/** Every row the editor offers: the six known levels (so a disabled one can be
 *  re-enabled) followed by whatever the file declares. */
export const thinkingRows = (efforts: string[] | undefined): string[] =>
  [...THINKING_LEVELS, ...unknownThinkingEfforts(efforts)];

/** What to persist for `efforts`. Known levels in canonical order, unknown ones
 *  after them in the order the file listed them. */
export const orderedThinkingEfforts = (included: Iterable<string>): string[] => {
  const set = new Set(included);
  return [
    ...THINKING_LEVELS.filter((level) => set.has(level)),
    ...[...set].filter((effort) => !isThinkingLevel(effort)),
  ];
};

export const thinkingLevelColor = (level: string): string =>
  isThinkingLevel(level) ? LEVEL_COLORS[level] : "var(--text-dim)";

export const COST_LABEL_KEYS = {
  input: "modelsConfig.costInput",
  output: "modelsConfig.costOutput",
  cacheRead: "modelsConfig.costCacheRead",
  cacheWrite: "modelsConfig.costCacheWrite",
} as const;
// ── Provider icon ─────────────────────────────────────────────────────────────

export function providerInitials(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "?";
}

// ── Model label ──────────────────────────────────────────────────────────────

/** omp's display name, falling back to the id — the label every model surface
 *  shows. A display name is not an identifier: two models of one provider may
 *  share it, so only `provider/id` identifies a model. */
export const modelLabel = (name: string | undefined, id: string): string => name || id;

/** The id to show next to that label, or null when it would only repeat it —
 *  omp ships `name === id` for custom providers. */
export const modelIdSuffix = (name: string | undefined, id: string): string | null =>
  name && name !== id ? id : null;
