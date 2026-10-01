import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { providerInitials } = await jiti.import("./ModelsConfig.tsx");
const { API_OPTIONS, DISCOVERY_TYPES, TOKENIZER_OPTIONS } = await jiti.import("./ModelsConfig-types.ts");

test("provider glyphs derive from arbitrary runtime provider ids", () => {
  assert.equal(providerInitials("acme-provider"), "AP");
  assert.equal(providerInitials("my_custom_gateway"), "MC");
  assert.equal(providerInitials("provider"), "P");
  assert.equal(providerInitials(""), "?");
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


