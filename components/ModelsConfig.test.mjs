import assert from "node:assert/strict";
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
