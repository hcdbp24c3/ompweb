import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { isMap, isScalar, isSeq, parseDocument, stringify, type Document } from "yaml";
import { getModelsConfigPath } from "./paths";
import { isRecord } from "../type-guards";

/**
 * Direct YAML access to omp's custom-models file (~/.omp/agent/models.yml).
 * Types and validation mirror the minimal subset of
 * oh-my-pi/packages/coding-agent/src/config/models-config(-schema).ts that the
 * web editor round-trips; unknown fields are preserved untouched.
 */

/** omp's ProviderDiscoverySchema discriminant. The list is copied from the
 * schema, not from omp's docs — `apple-foundation-models` is undocumented. */
export type DiscoveryType =
  | "ollama"
  | "llama.cpp"
  | "lm-studio"
  | "openai-models-list"
  | "proxy"
  | "litellm"
  | "apple-foundation-models";

/** Lets omp resolve a provider's model list from the server itself, so the
 * models never have to be written out by hand. `injectV1` (defaults to true)
 * only means something for `openai-models-list`, the one type whose URL is
 * built by injecting `/v1`. */
export interface ProviderDiscovery {
  type: DiscoveryType;
  timeoutMs?: number;
  injectV1?: boolean;
}

/** omp's ModelTokenizerSchema: tokenizers with bespoke offset tables. */
export type Tokenizer =
  | "claude-v3"
  | "claude-v47"
  | "claude-v5"
  | "claude-v5-sonnet"
  | "qwen3"
  | "deepseek-v3"
  | "kimi-k2"
  | "glm5";

export interface ModelThinkingConfig {
  mode?: string;
  efforts?: string[];
  defaultLevel?: string;
  effortMap?: Record<string, string>;
  [key: string]: unknown;
}

export interface ModelDefinition {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinking?: ModelThinkingConfig;
  input?: string[];
  contextWindow?: number;
  /** Upper bound of the variable context window; must be >= contextWindow. */
  maxContextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  compat?: Record<string, unknown>;
  supportsTools?: boolean;
  tokenizer?: Tokenizer;
  /** Send the provider's own max output cap instead of this model's maxTokens. */
  omitMaxOutputTokens?: boolean;
  premiumMultiplier?: number;
  [key: string]: unknown;
}

export interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  /**
   * Environment variables this provider's credential may arrive in. omp's own
   * catalog ships providers exactly this way (`"envVars":["ZAI_API_KEY"]`) with
   * no `apiKey` at all, which is how omp-web hands over a key it stores
   * encrypted instead of writing the secret into models.yml.
   */
  envVars?: string[];
  api?: string;
  auth?: "apiKey" | "none" | "oauth";
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  discovery?: ProviderDiscovery;
  /** Send the key as `Authorization:` rather than the api's default header. */
  authHeader?: boolean;
  /** Relax anthropic-messages tool schemas for Anthropic-compatible proxies. */
  disableStrictTools?: boolean;
  models?: ModelDefinition[];
  modelOverrides?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ModelsFileConfig {
  providers?: Record<string, ProviderConfig>;
  [key: string]: unknown;
}

/** Mirrors validateProviderConfiguration(mode: "models-config") in omp's
 * coding-agent/src/config/models-config.ts, plus the narrows on
 * ProviderDiscoverySchema and ModelDefinitionSchema. Throws on failure. */
export function validateModelsConfig(config: ModelsFileConfig): void {
  if (!isRecord(config)) throw new Error("Config must be an object");
  config = sanitizeModelsConfig(config);
  const providers = config.providers ?? {};
  if (!isRecord(providers)) throw new Error('"providers" must be an object');
  for (const [providerName, provider] of Object.entries(providers)) {
    if (!isRecord(provider)) throw new Error(`Provider ${providerName}: must be an object`);
    const models = Array.isArray(provider.models) ? provider.models : [];
    const discovery = provider.discovery;
    if (models.length > 0) {
      if (!provider.baseUrl) {
        throw new Error(`Provider ${providerName}: "baseUrl" is required when defining custom models.`);
      }
      // omp only demands an apiKey when the provider is actually going to send
      // one: `!apiKey && auth !== "none" && auth !== "oauth"` (models-config.ts
      // in coding-agent). `oauth` is the credential omp already holds for that
      // provider id — a hand-written `auth: oauth` file loads in omp, so
      // rejecting it here made Settings → Save answer 400 and write nothing.
      const auth = provider.auth ?? "apiKey";
      // A declared envVar satisfies the credential requirement, and this is not
      // a guess: omp's shipped catalog is full of providers defined only by
      // `envVars` (`"zai": {"envVars":["ZAI_API_KEY"]}`), so a provider with one
      // and no `apiKey` is exactly what omp itself accepts.
      const hasEnvVar = Array.isArray(provider.envVars)
        && provider.envVars.some((name) => typeof name === "string" && /^[A-Z][A-Z0-9_]*$/.test(name));
      if (!provider.apiKey && !hasEnvVar && auth !== "none" && auth !== "oauth") {
        throw new Error(
          `Provider ${providerName}: "apiKey" is required when defining custom models unless it declares an envVar, or auth is "none" or "oauth".`,
        );
      }
    } else {
      // A provider without models is only reachable if it declares something
      // that still points at a server. omp tests truthiness, so
      // `disableStrictTools: false` and an empty modelOverrides map do not count.
      const hasModelOverrides = isRecord(provider.modelOverrides) && Object.keys(provider.modelOverrides).length > 0;
      if (
        !provider.baseUrl &&
        !provider.headers &&
        !provider.apiKey &&
        provider.auth !== "none" &&
        !provider.compat &&
        !provider.disableStrictTools &&
        !provider.guardrailIdentifier &&
        !provider.requestMetadata &&
        !provider.remoteCompaction &&
        !hasModelOverrides &&
        !discovery
      ) {
        throw new Error(
          `Provider ${providerName}: must specify "baseUrl", "headers", "apiKey", "auth: none", "compat", "disableStrictTools", "guardrailIdentifier", "requestMetadata", "remoteCompaction", "modelOverrides", "discovery", or "models"`,
        );
      }
    }

    if (discovery) {
      if (!isRecord(discovery)) {
        throw new Error(`Provider ${providerName}: "discovery" must be an object`);
      }
      // "proxy" is exempt: it forwards the api the model ends up using, so a
      // provider-level api would be redundant.
      if (!provider.api && discovery.type !== "proxy") {
        throw new Error(`Provider ${providerName}: "api" is required when discovery is enabled at provider level.`);
      }
      if (discovery.injectV1 !== undefined && discovery.type !== "openai-models-list") {
        throw new Error(`Provider ${providerName}: discovery.injectV1 is only valid for "openai-models-list" discovery.`);
      }
      if (
        discovery.timeoutMs !== undefined &&
        (typeof discovery.timeoutMs !== "number" || discovery.timeoutMs <= 0 || !Number.isFinite(discovery.timeoutMs))
      ) {
        throw new Error(`Provider ${providerName}: discovery.timeoutMs must be a positive finite number.`);
      }
    }

    for (const model of models) {
      if (!isRecord(model) || typeof model.id !== "string" || !model.id) {
        throw new Error(`Provider ${providerName}: model missing "id"`);
      }
      if (!provider.api && !model.api) {
        throw new Error(`Provider ${providerName}, model ${model.id}: no "api" specified. Set at provider or model level.`);
      }
      if (typeof model.contextWindow === "number" && model.contextWindow <= 0) {
        throw new Error(`Provider ${providerName}, model ${model.id}: invalid contextWindow`);
      }
      if (typeof model.maxTokens === "number" && model.maxTokens <= 0) {
        throw new Error(`Provider ${providerName}, model ${model.id}: invalid maxTokens`);
      }
      // maxContextWindow caps the variable window, so it can never be smaller
      // than the base contextWindow.
      if (
        model.maxContextWindow !== undefined &&
        (!Number.isSafeInteger(model.maxContextWindow) ||
          model.maxContextWindow <= 0 ||
          (typeof model.contextWindow === "number" && model.maxContextWindow < model.contextWindow))
      ) {
        throw new Error(
          `Provider ${providerName}, model ${model.id}: maxContextWindow must be a positive integer no smaller than contextWindow`,
        );
      }
      // omp's schema requires all four cost fields whenever cost is present
      // (partial costs make omp reject the whole file), so refuse to write one.
      if (isRecord(model.cost)) {
        for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
          const value = model.cost[key];
          if (typeof value !== "number" || !Number.isFinite(value)) {
            throw new Error(`Provider ${providerName}, model ${model.id}: cost.${key} is required (cost needs input, output, cacheRead, and cacheWrite)`);
          }
        }
      }
    }
  }
}

/** Thrown when models.yml exists but cannot be parsed. Overwriting such a file
 * would silently delete every provider the user hand-wrote, so writes refuse
 * unless the caller explicitly opts in. */
export class ModelsConfigParseError extends Error {
  readonly path: string;
  readonly detail: string;
  constructor(path: string, detail: string) {
    super(`${path} is not valid YAML: ${detail}`);
    this.name = "ModelsConfigParseError";
    this.path = path;
    this.detail = detail;
  }
}

export interface ModelsConfigFile {
  path: string;
  exists: boolean;
  /** Raw file text, kept so writes can merge into the original document. */
  source?: string;
  /** Empty when `parseError` is set — never write this back over the file. */
  config: ModelsFileConfig;
  parseError?: string;
}

/** Drop empty model rows produced by blank YAML sequence entries or an empty
 * `id`. Malformed non-empty rows are retained so validation can report them. */
function sanitizeModelsConfig(config: ModelsFileConfig): ModelsFileConfig {
  if (!isRecord(config.providers)) return config;
  const providers = Object.fromEntries(Object.entries(config.providers).map(([providerId, provider]) => {
    if (!isRecord(provider) || !Array.isArray(provider.models)) return [providerId, provider];
    const models = provider.models.filter((model) => (
      !isRecord(model) || typeof model.id !== "string" || model.id.trim().length > 0
    ));
    return [providerId, { ...provider, models }];
  }));
  return { ...config, providers };
}

/** Read models.yml, reporting rather than swallowing parse failures. */
export function readModelsConfigFile(): ModelsConfigFile {
  const path = getModelsConfigPath();
  if (!existsSync(path)) return { path, exists: false, config: { providers: {} } };

  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    return { path, exists: true, config: { providers: {} }, parseError: String(error) };
  }

  // parseDocument collects syntax errors instead of throwing on the first one.
  const doc = parseDocument(source);
  if (doc.errors.length > 0) {
    return { path, exists: true, source, config: { providers: {} }, parseError: doc.errors[0].message };
  }
  const parsed = doc.toJS() as unknown;
  if (parsed === null || parsed === undefined) {
    return { path, exists: true, source, config: { providers: {} } };
  }
  if (!isRecord(parsed)) {
    return {
      path,
      exists: true,
      source,
      config: { providers: {} },
      parseError: "the top level of models.yml must be a mapping",
    };
  }
  return { path, exists: true, source, config: sanitizeModelsConfig(parsed as ModelsFileConfig) };
}

/** Tolerant read for consumers that only inspect the config (a broken file
 * reads as empty). Anything that writes the file back must go through
 * readModelsConfigFile()/writeModelsConfig() so a parse error blocks the write. */
export function readModelsConfig(): ModelsFileConfig {
  return readModelsConfigFile().config;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Comments live on the node they follow/precede, so a replaced node has to
 * inherit them or the user's annotations drift onto the wrong key. */
function carryComments(from: unknown, to: unknown): void {
  if (!from || !to || typeof from !== "object" || typeof to !== "object") return;
  const src = from as { comment?: string | null; commentBefore?: string | null; spaceBefore?: boolean };
  const dst = to as { comment?: string | null; commentBefore?: string | null; spaceBefore?: boolean };
  if (src.comment != null) dst.comment = src.comment;
  if (src.commentBefore != null) dst.commentBefore = src.commentBefore;
  if (src.spaceBefore) dst.spaceBefore = src.spaceBefore;
}

function scalarKey(key: unknown): string | undefined {
  if (isScalar(key) && (typeof key.value === "string" || typeof key.value === "number")) {
    return String(key.value);
  }
  return typeof key === "string" ? key : undefined;
}

function itemId(item: unknown): string | undefined {
  if (!isMap(item)) return undefined;
  const value = item.get("id");
  return typeof value === "string" ? value : undefined;
}

/** Rewrite `node` so it represents `value`, reusing the existing AST wherever
 * old and new agree — that reuse is what preserves comments and layout. */
function mergeNode(doc: Document, node: unknown, value: unknown): unknown {
  if (isMap(node) && isPlainRecord(value)) {
    const wanted = new Map(Object.entries(value).filter(([, v]) => v !== undefined));
    // Keys with non-scalar (complex) keys are left alone rather than dropped.
    node.items = node.items.filter((pair) => {
      const key = scalarKey(pair.key);
      return key === undefined || wanted.has(key);
    });
    for (const [key, v] of wanted) {
      const pair = node.items.find((p) => scalarKey(p.key) === key);
      if (pair) pair.value = mergeNode(doc, pair.value, v);
      else node.set(doc.createNode(key), doc.createNode(v));
    }
    return node;
  }

  if (isSeq(node) && Array.isArray(value)) {
    const previous = [...node.items];
    // Match by `id` first: the editor reorders/removes models, and positional
    // matching would move a model's comments onto its neighbour.
    const byId = new Map<string, unknown>();
    for (const item of previous) {
      const id = itemId(item);
      if (id !== undefined && !byId.has(id)) byId.set(id, item);
    }
    node.items = value.map((entry, index) => {
      const id = isPlainRecord(entry) && typeof entry.id === "string" ? entry.id : undefined;
      let old: unknown;
      if (id !== undefined) {
        old = byId.get(id);
        if (old !== undefined) byId.delete(id);
      } else {
        old = previous[index];
      }
      return mergeNode(doc, old, entry);
    }) as typeof node.items;
    return node;
  }

  if (isScalar(node) && !isPlainRecord(value) && !Array.isArray(value)) {
    // Keep the original scalar (and its quoting style) only for same-typed
    // values — reusing a quoted string node for a number would re-quote it.
    if (typeof node.value === typeof value) {
      node.value = value;
      return node;
    }
  }

  const created = doc.createNode(value);
  carryComments(node, created);
  return created;
}

/** Serialize a config. When `existingSource` is a parseable document the edit
 * is applied onto it so hand-written comments and formatting survive. */
export function serializeModelsConfig(config: ModelsFileConfig, existingSource?: string): string {
  if (existingSource === undefined || existingSource.trim() === "") return stringify(config);
  const doc = parseDocument(existingSource);
  if (doc.errors.length > 0) return stringify(config);
  if (!isMap(doc.contents)) {
    // Comment-only or non-mapping document: replacing contents still keeps the
    // file's leading comments (they hang off the document, not the node).
    doc.contents = doc.createNode(config) as unknown as typeof doc.contents;
    return doc.toString();
  }
  mergeNode(doc, doc.contents, config);
  return doc.toString();
}

export interface WriteModelsConfigOptions {
  /** Replace an unparseable models.yml instead of refusing — destroys whatever
   * the user has in the file, so only pass it on an explicit user request. */
  overwriteUnparseable?: boolean;
}

export function writeModelsConfig(config: ModelsFileConfig, options: WriteModelsConfigOptions = {}): void {
  const current = readModelsConfigFile();
  if (current.parseError && !options.overwriteUnparseable) {
    throw new ModelsConfigParseError(current.path, current.parseError);
  }
  const text = serializeModelsConfig(sanitizeModelsConfig(config), current.parseError ? undefined : current.source);
  const dir = dirname(current.path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Write-then-rename: a crash mid-write must not leave models.yml truncated,
  // which would disable every custom model until the user repairs it by hand.
  const temp = join(dir, `.${basename(current.path)}.omp-web-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(temp, text, "utf8");
    renameSync(temp, current.path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
