import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tryNative: false, alias: { "@/": new URL("../", import.meta.url).pathname } });
const { isWebSearchProvider, partitionByWebSearch } = await jiti.import("../lib/web-search-providers.ts");

test("the search backends are recognised", () => {
  for (const id of ["exa", "tavily", "brave", "jina", "searxng", "perplexity", "duckduckgo"]) {
    assert.equal(isWebSearchProvider(id), true, id);
  }
});

test("an ordinary model provider is not", () => {
  for (const id of ["openai", "anthropic", "google", "gemini", "openrouter", "new-api", "ollama"]) {
    assert.equal(isWebSearchProvider(id), false, id);
  }
});

test("gemini and google stay model providers even though the binary lists them beside the search backends", () => {
  // Moving a real chat provider into a "web search" section is the worse failure.
  assert.equal(isWebSearchProvider("gemini"), false);
  assert.equal(isWebSearchProvider("google"), false);
});

test("matching ignores case and surrounding space, because omp ids are not normalised", () => {
  assert.equal(isWebSearchProvider("  Exa "), true);
  assert.equal(isWebSearchProvider("TAVILY"), true);
});

test("an id that is only a substring is not a search backend", () => {
  // "brave-search-engine" is someone's custom provider, not Brave's backend.
  assert.equal(isWebSearchProvider("brave-search-engine"), false);
  assert.equal(isWebSearchProvider("my-exa-proxy"), false);
});

test("the split keeps both halves in the order they arrived", () => {
  const providers = [
    { id: "openai" }, { id: "exa" }, { id: "anthropic" }, { id: "tavily" },
  ];
  const { ai, webSearch } = partitionByWebSearch(providers);
  assert.deepEqual(ai.map((p) => p.id), ["openai", "anthropic"]);
  assert.deepEqual(webSearch.map((p) => p.id), ["exa", "tavily"]);
});

test("nothing is ever dropped: the halves add up to the input", () => {
  const providers = [{ id: "openai" }, { id: "exa" }, { id: "jina" }, { id: "ollama" }];
  const { ai, webSearch } = partitionByWebSearch(providers);
  assert.equal(ai.length + webSearch.length, providers.length);
});

test("an all-AI or all-search list does not produce an empty phantom section", () => {
  assert.deepEqual(partitionByWebSearch([{ id: "openai" }]).webSearch, []);
  assert.deepEqual(partitionByWebSearch([{ id: "exa" }]).ai, []);
  assert.deepEqual(partitionByWebSearch([]), { ai: [], webSearch: [] });
});