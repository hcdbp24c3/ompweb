import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { providerInitials } = await jiti.import("./ModelsConfig.tsx");
const {
  API_OPTIONS,
  DISCOVERY_TYPES,
  LEVEL_COLORS,
  THINKING_LEVELS,
  THINKING_MODES,
  TOKENIZER_OPTIONS,
  modelIdSuffix,
  modelLabel,
  orderedThinkingEfforts,
  thinkingLevelColor,
  thinkingRows,
} = await jiti.import("./ModelsConfig-types.ts");

test("provider glyphs derive from arbitrary runtime provider ids", () => {
  assert.equal(providerInitials("acme-provider"), "AP");
  assert.equal(providerInitials("my_custom_gateway"), "MC");
  assert.equal(providerInitials("provider"), "P");
  assert.equal(providerInitials(""), "?");
});

// ── Shared model label ───────────────────────────────────────────────────────
// `name` is a display label, not an identifier: omp lets two models of one
// provider share it, and custom providers ship `name === id`. Every model
// surface spelled the fallback and the "is the id worth showing again?" test out
// for itself, so the two answers could drift apart.

test("modelLabel falls back to the id when omp ships no display name", () => {
  assert.equal(modelLabel(undefined, "gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(modelLabel("Codex Tier", "gpt-5.6-sol"), "Codex Tier");
});

test("modelIdSuffix drops the id when it would only repeat the label", () => {
  assert.equal(modelIdSuffix("my-model", "my-model"), null);
  assert.equal(modelIdSuffix(undefined, "my-model"), null);
  assert.equal(modelIdSuffix("Codex Tier", "gpt-5.6-sol"), "gpt-5.6-sol");
});

/** A label and an id suffix are one decision, so they have to come from one
 *  place. `ChatInput-model-options.ts` is excluded on purpose: its `name || id`
 *  is a sort key, not a label, and sorting must stay name-first. */
test("no model surface spells the name-or-id label out inline", () => {
  const inline = /\.name\s*\|\|\s*[A-Za-z_$][\w$]*\.(?:id|modelId)\b/;
  for (const file of ["ModelsConfig.tsx", "ModelsConfig-panels.tsx", "ChatInput-model-picker.tsx"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, inline, `${file} still builds its own model label`);
  }
});

// The option lists are copied from omp's schema, not from its docs: the docs
// omit apple-foundation-models and the last two api ids.
test("API_OPTIONS matches omp's ApiSchema", () => {
  assert.deepEqual([...API_OPTIONS], [
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
  ]);
});

test("DISCOVERY_TYPES matches omp's ProviderDiscoverySchema", () => {
  assert.deepEqual([...DISCOVERY_TYPES], [
    "ollama",
    "llama.cpp",
    "lm-studio",
    "openai-models-list",
    "proxy",
    "litellm",
    "apple-foundation-models",
  ]);
});

test("TOKENIZER_OPTIONS matches omp's ModelTokenizerSchema", () => {
  assert.deepEqual([...TOKENIZER_OPTIONS], [
    "claude-v3",
    "claude-v47",
    "claude-v5",
    "claude-v5-sonnet",
    "qwen3",
    "deepseek-v3",
    "kimi-k2",
    "glm5",
  ]);
});

// The provider editor must not fall back to English text: every key the new
// controls read has to exist in all three locales, and the plural count needs
// both forms. A missing key renders as the raw key, which is how a hardcoded
// English string sneaks back in.
const LOCALES = ["en", "ja", "zh-CN"];
const DICTIONARIES = Object.fromEntries(
  LOCALES.map((locale) => [locale, JSON.parse(readFileSync(new URL(`../lib/i18n/locales/${locale}.json`, import.meta.url), "utf8"))]),
);

const PROVIDER_EDITOR_KEYS = [
  "modelsConfig.modelDiscovery",
  "modelsConfig.discoverySource",
  "modelsConfig.discoverySourceHint",
  "modelsConfig.noDiscovery",
  "modelsConfig.discoveryTimeout",
  "modelsConfig.discoveryTimeoutHint",
  "modelsConfig.discoveryTimeoutInvalid",
  "modelsConfig.discoveryInjectV1",
  "modelsConfig.discoveryInjectV1Hint",
  "modelsConfig.discoverModels",
  "modelsConfig.discovering",
  "modelsConfig.discoverModelsHint",
  "modelsConfig.modelsFound.one",
  "modelsConfig.modelsFound.other",
  "modelsConfig.discoverNoModels",
  "modelsConfig.addSelectedModels",
  "modelsConfig.requestHeaders",
  "modelsConfig.requestHeadersHint",
  "modelsConfig.addHeader",
  "modelsConfig.removeHeader",
  "modelsConfig.headerName",
  "modelsConfig.headerValue",
  "modelsConfig.authHeader",
  "modelsConfig.authHeaderHint",
  "modelsConfig.disableStrictTools",
  "modelsConfig.disableStrictToolsHint",
  "errors.discover_failed",
];

/** The two components this task added, so the pre-existing hardcoded English
 *  elsewhere in ModelsConfig.tsx (quick-preset heading, OAuth cards) does not
 *  mask — or excuse — a regression here. */
function addedProviderEditorSource() {
  const source = readFileSync(new URL("./ModelsConfig.tsx", import.meta.url), "utf8");
  const discovery = source.slice(source.indexOf("function ProviderDiscoveryEditor"), source.indexOf("function ProviderDetail"));
  const headers = source.slice(source.indexOf("function ProviderHeadersEditor"), source.indexOf("function ProviderDetail"));
  assert.notEqual(discovery.length, 0, "ProviderDiscoveryEditor not found in ModelsConfig.tsx");
  assert.notEqual(headers.length, 0, "ProviderHeadersEditor not found in ModelsConfig.tsx");
  return discovery + headers;
}

test("every provider-editor key is translated in all three locales", () => {
  for (const locale of LOCALES) {
    const missing = PROVIDER_EDITOR_KEYS.filter((key) => typeof DICTIONARIES[locale][key] !== "string");
    assert.deepEqual(missing, [], `missing in ${locale}`);
  }
});

test("the provider editor translates every key it looks up", () => {
  const added = addedProviderEditorSource();
  const plain = [...added.matchAll(/\bt\("([^"]+)"/g)].map((match) => match[1]);
  // tn() resolves <key>.one / <key>.other at runtime, so expand it here.
  const plural = [...added.matchAll(/\btn\("([^"]+)"/g)].flatMap((match) => [`${match[1]}.one`, `${match[1]}.other`]);
  const referenced = [...plain, ...plural];

  assert.ok(referenced.length >= 20, `expected the new controls to use i18n, saw ${referenced.length} keys`);

  for (const locale of LOCALES) {
    const missing = referenced.filter((key) => typeof DICTIONARIES[locale][key] !== "string");
    assert.deepEqual(missing, [], `missing from ${locale}.json`);
  }
});

test("the provider editor hardcodes no user-facing English", () => {
  const source = addedProviderEditorSource();
  // A run of two or more real words is prose; single tokens are attribute
  // values ("button", "X-Team", "modelsConfig.discoverModels") and anything
  // with a digit, a percent or a paren is a CSS value or an i18n key.
  const isProse = (value) =>
    /^[A-Za-z][A-Za-z'’.\-]*(\s+[A-Za-z][A-Za-z'’.\-]*)+$/.test(value.trim())
    && (value.match(/[A-Za-z]{3,}/g) ?? []).length >= 2
    && !/[\d%()]/.test(value);

  const quoted = [...source.matchAll(/"([^"\\\n]{2,})"/g)].map((match) => match[1]);
  const jsxText = [...source.matchAll(/>\s*([A-Za-z][^<>{}]*?)</g)].map((match) => match[1]);
  const prose = [...quoted, ...jsxText].filter(isProse);

  assert.deepEqual([...new Set(prose)], [], "user-facing text must go through t()/tn()");
});


// ── Thinking ladder ──────────────────────────────────────────────────────────
// The editor used to rebuild `efforts` as THINKING_LEVELS.filter(...), which
// silently deleted every effort that is not one of the six known names the next
// time the user touched an unrelated field. models.yml is hand-written and omp's
// own catalog uses levels this list has never heard of, so the ladder has to be
// a union: known names in canonical order, then whatever the file declares.

test("THINKING_MODES matches omp's thinking mode enum", () => {
  assert.deepEqual([...THINKING_MODES], [
    "effort",
    "budget",
    "google-level",
    "anthropic-adaptive",
    "anthropic-budget-effort",
  ]);
});

test("an effort outside THINKING_LEVELS survives an edit to a known one", () => {
  const configured = ["low", "medium", "ultra"];
  const included = new Set(configured);
  included.delete("low");

  assert.deepEqual(
    orderedThinkingEfforts(included),
    ["medium", "ultra"],
    "toggling one level must not delete a hand-written effort",
  );
});

test("the known ladder is written back in canonical order, unknown ones after it", () => {
  assert.deepEqual(orderedThinkingEfforts(["max", "ultra", "low"]), ["low", "max", "ultra"]);
});

test("an unset efforts list means the full known ladder", () => {
  assert.deepEqual(orderedThinkingEfforts(THINKING_LEVELS), [...THINKING_LEVELS]);
});

test("thinkingRows offers every known level plus whatever the file declares", () => {
  assert.deepEqual(thinkingRows(undefined), [...THINKING_LEVELS], "an auto-derived ladder still shows all six toggles");
  assert.deepEqual(thinkingRows(["ultra"]), [...THINKING_LEVELS, "ultra"]);
  assert.deepEqual(thinkingRows(["ultra", "turbo"]), [...THINKING_LEVELS, "ultra", "turbo"], "in the order the file listed them");
});

test("an unknown effort gets the neutral dot instead of an undefined colour", () => {
  assert.equal(thinkingLevelColor("max"), LEVEL_COLORS.max);
  assert.equal(thinkingLevelColor("ultra"), "var(--text-dim)");
});

// ── i18n for the model editor ────────────────────────────────────────────────
// Scoped the same way as the provider editor above: the two components this task
// owns. ModelDetail keeps pre-existing hardcoded English in its placeholders, so
// the keys it gained are pinned by name instead.

const MODEL_EDITOR_KEYS = [
  "modelsConfig.thinkingMode",
  "modelsConfig.thinkingModeHint",
  "modelsConfig.thinkingDefaultLevel",
  "modelsConfig.thinkingDefaultLevelHint",
  "modelsConfig.modelDefault",
  "modelsConfig.capabilities",
  "modelsConfig.supportsTools",
  "modelsConfig.supportsToolsHint",
  "modelsConfig.premiumMultiplier",
  "modelsConfig.premiumMultiplierHint",
  "modelsConfig.baseUrlOverride",
  "modelsConfig.tokenizer",
  "modelsConfig.tokenizerHint",
  "modelsConfig.maxContextWindow",
  "modelsConfig.maxContextWindowHint",
  "modelsConfig.maxContextWindowInvalid",
  "modelsConfig.maxContextWindowTooSmall",
  "modelsConfig.omitMaxOutputTokens",
  "modelsConfig.omitMaxOutputTokensHint",
];

/** The components this task added or rewrote, so hardcoded English elsewhere in
 *  ModelsConfig.tsx does not mask — or excuse — a regression here. */
function addedModelEditorSource() {
  const source = readFileSync(new URL("./ModelsConfig.tsx", import.meta.url), "utf8");
  const thinking = source.slice(source.indexOf("function ThinkingEditor"), source.indexOf("function ModelDetail"));
  const capabilities = source.slice(source.indexOf("function ModelCapabilitiesEditor"), source.indexOf("function ModelDetail"));
  assert.notEqual(thinking.length, 0, "ThinkingEditor not found in ModelsConfig.tsx");
  assert.notEqual(capabilities.length, 0, "ModelCapabilitiesEditor not found in ModelsConfig.tsx");
  return thinking + capabilities;
}

test("every model-editor key is translated in all three locales", () => {
  for (const locale of LOCALES) {
    const missing = MODEL_EDITOR_KEYS.filter((key) => typeof DICTIONARIES[locale][key] !== "string");
    assert.deepEqual(missing, [], `missing in ${locale}`);
  }
});

test("the model editor translates every key it looks up", () => {
  const added = addedModelEditorSource();
  const plain = [...added.matchAll(/\bt\("([^"]+)"/g)].map((match) => match[1]);
  const plural = [...added.matchAll(/\btn\("([^"]+)"/g)].flatMap((match) => [`${match[1]}.one`, `${match[1]}.other`]);
  const referenced = [...plain, ...plural];

  assert.ok(referenced.length >= 10, `expected the new controls to use i18n, saw ${referenced.length} keys`);

  for (const locale of LOCALES) {
    const missing = referenced.filter((key) => typeof DICTIONARIES[locale][key] !== "string");
    assert.deepEqual(missing, [], `missing from ${locale}.json`);
  }
});

test("the model editor hardcodes no user-facing English", () => {
  const source = addedModelEditorSource();
  const isProse = (value) =>
    /^[A-Za-z][A-Za-z'’.\-]*(\s+[A-Za-z][A-Za-z'’.\-]*)+$/.test(value.trim())
    && (value.match(/[A-Za-z]{3,}/g) ?? []).length >= 2
    && !/[\d%()]/.test(value);

  const quoted = [...source.matchAll(/"([^"\\\n]{2,})"/g)].map((match) => match[1]);
  const jsxText = [...source.matchAll(/>\s*([A-Za-z][^<>{}]*?)</g)].map((match) => match[1]);
  const prose = [...quoted, ...jsxText].filter(isProse);

  assert.deepEqual([...new Set(prose)], [], "user-facing text must go through t()/tn()");
});
