import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tryNative: false, alias: { "@/": new URL("../", import.meta.url).pathname } });
const {
  WEB_SEARCH_BACKENDS, webSearchEnv, webSearchFieldsFor, webSearchBackend,
  isWebSearchBackendId, validateWebSearchValues,
} = await jiti.import("../lib/web-search-backends.ts");

test("every env var name is one omp actually reads", () => {
  // Measured from the omp binary. A name here that omp does not read would be a
  // key stored, encrypted, and never used.
  const allowed = new Set([
    "BRAVE_API_KEY", "EXA_API_KEY", "JINA_API_KEY", "TAVILY_API_KEY",
    "PERPLEXITY_API_KEY", "SEARXNG_ENDPOINT", "SEARXNG_BASIC_USERNAME", "SEARXNG_BASIC_PASSWORD",
  ]);
  for (const backend of WEB_SEARCH_BACKENDS) {
    for (const field of backend.fields) {
      assert.ok(allowed.has(field.env), `${field.env} is not a variable omp reads`);
    }
  }
});

test("DuckDuckGo carries no field, because it needs no credential", () => {
  // Giving it an apiKey field would store a secret omp never reads.
  assert.deepEqual(webSearchFieldsFor("duckduckgo"), []);
  assert.equal(webSearchBackend("duckduckgo").fields.length, 0);
});

test("SearXNG is an endpoint plus optional auth, not a single key", () => {
  const fields = webSearchFieldsFor("searxng");
  const envs = fields.map((f) => f.env);
  assert.ok(envs.includes("SEARXNG_ENDPOINT"));
  assert.ok(envs.includes("SEARXNG_BASIC_USERNAME"));
  assert.ok(!envs.includes("SEARXNG_API_KEY"), "SearXNG has no API key variable");
});

test("a one-key-per-backend editor would be unable to express SearXNG", () => {
  // The reason this module exists rather than a `Record<id, apiKey>`.
  assert.ok(webSearchFieldsFor("searxng").length > 1);
  assert.equal(webSearchFieldsFor("exa").length, 1);
});

test("stored values become the environment omp reads", () => {
  const env = webSearchEnv({
    exa: { EXA_API_KEY: "exa-secret" },
    brave: { BRAVE_API_KEY: "brave-secret" },
  });
  assert.deepEqual(env, { EXA_API_KEY: "exa-secret", BRAVE_API_KEY: "brave-secret" });
});

test("an empty value is skipped, not emitted as an empty string", () => {
  // A program that tests "is this variable set" reads "" as configured-and-wrong,
  // which fails as an opaque 401 rather than "not configured".
  const env = webSearchEnv({ exa: { EXA_API_KEY: "   " }, tavily: { TAVILY_API_KEY: "t" } });
  assert.deepEqual(env, { TAVILY_API_KEY: "t" });
  assert.ok(!("EXA_API_KEY" in env));
});

test("a value is trimmed on the way out", () => {
  assert.deepEqual(webSearchEnv({ exa: { EXA_API_KEY: "  padded \n" } }), { EXA_API_KEY: "padded" });
});

test("a field the backend does not declare never reaches the environment", () => {
  // A hand-edited store must not be able to inject an arbitrary variable into
  // every child process.
  const env = webSearchEnv({ exa: { EXA_API_KEY: "k", PATH: "/evil", LD_PRELOAD: "x.so" } });
  assert.deepEqual(env, { EXA_API_KEY: "k" });
});

test("nothing stored means an empty environment, not empty strings", () => {
  assert.deepEqual(webSearchEnv({}), {});
  assert.deepEqual(webSearchEnv({ duckduckgo: {} }), {});
});

test("a required field left blank is refused at save time, not at 401 later", () => {
  assert.equal(validateWebSearchValues("exa", { EXA_API_KEY: "k" }).ok, true);
  assert.equal(validateWebSearchValues("exa", { EXA_API_KEY: "" }).ok, false);
  assert.equal(validateWebSearchValues("exa", {}).ok, false);
  // Optional auth may be blank; the endpoint may not.
  assert.equal(validateWebSearchValues("searxng", { SEARXNG_ENDPOINT: "https://s.example" }).ok, true);
  assert.equal(validateWebSearchValues("searxng", { SEARXNG_ENDPOINT: "" }).ok, false);
});

test("an unknown backend is refused rather than accepted as a typo", () => {
  assert.equal(validateWebSearchValues("exaa", { EXA_API_KEY: "k" }).ok, false);
  assert.equal(isWebSearchBackendId("exaa"), false);
  assert.equal(isWebSearchBackendId("exa"), true);
  assert.equal(isWebSearchBackendId(null), false);
});
test("no env var name uses the prefix hostChildEnv strips", () => {
  // hostChildEnv() deletes every OMP_WEB_* variable before the child sees it, so
  // a key carried in one would be silently dropped on the way to omp — stored,
  // encrypted, delivered, and never used.
  for (const backend of WEB_SEARCH_BACKENDS) {
    for (const field of backend.fields) {
      assert.ok(!field.env.startsWith("OMP_WEB_"), `${field.env} would be stripped before the child`);
      assert.match(field.env, /^[A-Z][A-Z0-9_]*$/, `${field.env} is not a conventional env name`);
    }
  }
});
