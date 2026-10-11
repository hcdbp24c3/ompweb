import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

// The whole point of encrypting at rest is that the plaintext never lands on
// disk and never leaves for the browser. Both are asserted here directly,
// because a store that is encrypted-but-then-logged is not encrypted.

const agentDir = mkdtempSync(join(tmpdir(), "omp-websearch-store-"));
process.env.OMP_PROFILE = agentDir;

const jiti = createJiti(import.meta.url, { tryNative: false, alias: { "@/": new URL("../", import.meta.url).pathname } });
const paths = await jiti.import("../lib/omp/paths.ts");
paths.getAgentDir = () => agentDir;

const store = await jiti.import("../lib/api-key-store.ts");

test.after(() => rmSync(agentDir, { recursive: true, force: true }));

test("a stored secret is encrypted on disk", () => {
  store.saveWebSearchBackend("exa", { EXA_API_KEY: "super-secret-value" });
  const raw = readFileSync(store.webSearchKeysPath(), "utf8");
  assert.ok(!raw.includes("super-secret-value"), "the plaintext must not be on disk");
  assert.match(raw, /"EXA_API_KEY": "v1\./, "it is stored as a v1 envelope");
});

test("the browser-facing listing never contains a secret", () => {
  const listed = store.listWebSearchKeys();
  const serialised = JSON.stringify(listed);
  assert.ok(!serialised.includes("super-secret-value"));
  const exa = listed.backends.find((b) => b.id === "exa");
  assert.equal(exa.configured, true);
  assert.equal(exa.fields[0].hasValue, true, "it reports presence, not content");
});

test("the secret comes back only on the server, and only as an env var", () => {
  const env = store.loadWebSearchEnv();
  assert.equal(env.EXA_API_KEY, "super-secret-value");
});

test("SearXNG needs an endpoint plus optional auth", () => {
  const validation = store.saveWebSearchBackend("searxng", { SEARXNG_ENDPOINT: "https://s.example", SEARXNG_BASIC_USERNAME: "u" });
  assert.equal(validation.configured, true);
  const env = store.loadWebSearchEnv();
  assert.equal(env.SEARXNG_ENDPOINT, "https://s.example");
  assert.equal(env.SEARXNG_BASIC_USERNAME, "u");
  assert.ok(!("SEARXNG_BASIC_PASSWORD" in env), "an optional field left blank contributes nothing");
});

test("a rejected save writes nothing at all", () => {
  const before = readFileSync(store.webSearchKeysPath(), "utf8");
  assert.throws(() => store.saveWebSearchBackend("brave", {}), /required/);
  assert.equal(readFileSync(store.webSearchKeysPath(), "utf8"), before,
    "validation runs before the write, so a rejection cannot leave half a backend");
});

test("a field the backend does not declare is never persisted", () => {
  // Otherwise a crafted request could plant a variable that gets exported into
  // every child process.
  store.saveWebSearchBackend("exa", { EXA_API_KEY: "k", LD_PRELOAD: "/evil.so" });
  const raw = readFileSync(store.webSearchKeysPath(), "utf8");
  assert.ok(!raw.includes("LD_PRELOAD"));
  assert.ok(!("LD_PRELOAD" in store.loadWebSearchEnv()));
});

test("DuckDuckGo has no field, so saving it clears rather than inventing a key", () => {
  store.saveWebSearchBackend("duckduckgo", {});
  const duck = store.listWebSearchKeys().backends.find((b) => b.id === "duckduckgo");
  assert.equal(duck.fields.length, 0);
  assert.equal(duck.configured, true, "a backend needing nothing is configured by definition");
});

test("deleting a backend removes it", () => {
  store.saveWebSearchBackend("tavily", { TAVILY_API_KEY: "t-secret" });
  assert.ok("TAVILY_API_KEY" in store.loadWebSearchEnv());
  store.deleteWebSearchBackend("tavily");
  assert.ok(!("TAVILY_API_KEY" in store.loadWebSearchEnv()));
});

test("an unknown backend is refused", () => {
  assert.throws(() => store.saveWebSearchBackend("exaa", { EXA_API_KEY: "k" }), /Unknown/);
  assert.throws(() => store.deleteWebSearchBackend("exaa"), /Unknown/);
});

test("a damaged store degrades to nothing rather than throwing", () => {
  const path = store.webSearchKeysPath();
  const good = readFileSync(path, "utf8");
  try {
    writeFileSync(path, "{ not json", "utf8");
    assert.deepEqual(store.loadWebSearchEnv(), {});
    assert.equal(store.listWebSearchKeys().backends.length > 0, true, "the backend list is schema, not data");
  } finally {
    writeFileSync(path, good, "utf8");
  }
});

test("a record whose key file is gone keeps its place but loses its secret", () => {
  // Better than dropping the row: the user sees it unconfigured and can
  // re-enter the value, instead of it vanishing with no explanation.
  store.saveWebSearchBackend("jina", { JINA_API_KEY: "j-secret" });
  const keyPath = join(agentDir, "git-credentials.key");
  const savedKey = readFileSync(keyPath, "utf8");
  try {
    // Wrong-length key: `readKey` treats that as "cannot decrypt" rather than
    // minting a new key, which would orphan every stored secret at once.
    writeFileSync(keyPath, "dGFjaC1ub3QtMzItYnl0ZXMtbG9uZw==", "utf8");
    const env = store.loadWebSearchEnv();
    assert.ok(!("JINA_API_KEY" in env), "an unreadable secret contributes nothing");
    const jina = store.listWebSearchKeys().backends.find((b) => b.id === "jina");
    assert.equal(jina.fields.length, 1, "the row is still listed");
  } finally {
    writeFileSync(keyPath, savedKey, "utf8");
    chmodSync(keyPath, 0o600);
  }
  assert.equal(store.loadWebSearchEnv().JINA_API_KEY, "j-secret", "and it recovers when the key does");
});

// ---------------------------------------------------------------------------
// Model-provider credentials
// ---------------------------------------------------------------------------

test("a provider key is encrypted on disk and comes back only as an env var", () => {
  store.saveProviderKey("myprov", "MYPROV_API_KEY", "sk-provider-secret");
  const raw = readFileSync(store.webSearchKeysPath(), "utf8");
  assert.ok(!raw.includes("sk-provider-secret"), "the plaintext must not reach models.yml or the store");
  assert.equal(store.loadOmpSecretEnv().MYPROV_API_KEY, "sk-provider-secret");
});

test("the browser-facing listing reports presence, never the secret", () => {
  const listed = JSON.stringify(store.listProviderKeys());
  assert.ok(!listed.includes("sk-provider-secret"));
  assert.ok(!listed.includes("sk-" + "provider-secret"));
  const entry = store.listProviderKeys().providers.find((p) => p.providerId === "myprov");
  assert.equal(entry.hasValue, true);
});

test("an env var name that hostChildEnv would strip, or that is not a name at all, is refused", () => {
  // OMP_WEB_* is deleted before the child sees it, so such a key would be
  // stored, delivered, and never used. Lower-case and punctuation are not env
  // names either.
  assert.throws(() => store.saveProviderKey("p", "OMP_WEB_API_KEY", "k"), /Invalid environment variable/);
  assert.throws(() => store.saveProviderKey("p", "path", "/evil"), /Invalid environment variable/);
  assert.throws(() => store.saveProviderKey("p", "LD_PRELOAD=/evil.so", "k"), /Invalid environment variable/);
});

test("an empty provider or value is refused", () => {
  assert.throws(() => store.saveProviderKey("  ", "X_API_KEY", "k"), /providerId is required/);
  assert.throws(() => store.saveProviderKey("p", "X_API_KEY", "   "), /value is required/);
});

test("provider secrets and web-search secrets share one environment", () => {
  store.saveWebSearchBackend("exa", { EXA_API_KEY: "exa-secret" });
  store.saveProviderKey("myprov", "MYPROV_API_KEY", "sk-provider-secret");
  const env = store.loadOmpSecretEnv();
  assert.equal(env.EXA_API_KEY, "exa-secret");
  assert.equal(env.MYPROV_API_KEY, "sk-provider-secret");
});

test("deleting one provider key leaves the other alone", () => {
  store.saveProviderKey("myprov", "MYPROV_API_KEY", "a");
  store.saveProviderKey("myprov", "MYPROV_ORG_KEY", "b");
  store.deleteProviderKey("myprov", "MYPROV_API_KEY");
  const env = store.loadOmpSecretEnv();
  assert.ok(!("MYPROV_API_KEY" in env));
  assert.equal(env.MYPROV_ORG_KEY, "b", "a second credential on the same provider is not collateral damage");
  store.deleteProviderKey("myprov");
});

test("a provider key written by hand under a name omp would not pass through is not exported", () => {
  store.saveProviderKey("seed", "SEED_API_KEY", "s");
  const path = store.webSearchKeysPath();
  const good = readFileSync(path, "utf8");
  try {
    const parsed = JSON.parse(good);
    parsed.providers.evil = { PATH: parsed.providers.seed.SEED_API_KEY, OMP_WEB_X: "x" };
    writeFileSync(path, JSON.stringify(parsed), "utf8");
    const env = store.loadOmpSecretEnv();
    assert.ok(!("PATH" in env), "a hand-edited store must not be able to shadow PATH");
    assert.ok(!("OMP_WEB_X" in env), "nor smuggle a variable hostChildEnv would strip anyway");
  } finally {
    writeFileSync(path, good, "utf8");
  }
});

test("reserved names are refused even though they look like valid env names", () => {
  // PATH matches the naming rule exactly; without the denylist a store entry
  // named PATH would shadow the real PATH of every child process.
  for (const name of ["PATH", "LD_PRELOAD", "NODE_OPTIONS", "BASH_ENV", "SHELL"]) {
    assert.throws(() => store.saveProviderKey("p", name, "x"), /Invalid environment variable/, name);
  }
});
