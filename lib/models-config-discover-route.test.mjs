import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

// Discovery spawns a real omp child against a throwaway agent dir, so the RPC
// helper is replaced with a stub. jiti aliases the route's `@/lib/omp/rpc-utility`
// specifier to this file; the test mutates the stub's shared state to script the
// reply and to inspect what the route sent.
const stubDir = mkdtempSync(join(tmpdir(), "omp-web-discover-stub-"));
const stubPath = join(stubDir, "rpc-utility-stub.mjs");
writeFileSync(
  stubPath,
  `export const state = { calls: [], impl: null };
export async function runIsolatedUtilityCommand(command, options) {
  state.calls.push({ command, options });
  return state.impl(command, options);
}
`,
  "utf8",
);

const jiti = createJiti(import.meta.url, {
  alias: {
    "@/lib/omp/rpc-utility": stubPath,
    "@/": repoRoot,
  },
});
const { POST } = await jiti.import("../app/api/models-config/discover/route.ts");
const stub = await jiti.import(stubPath);

test.after(() => rmSync(stubDir, { recursive: true, force: true }));

/** A discovery-only provider: omp resolves its models from the server itself, so
 *  no `models` list and no credentials are needed to ask what exists. */
const DISCOVERY_PROVIDER = {
  baseUrl: "http://127.0.0.1:8000/v1",
  api: "openai-completions",
  auth: "none",
  discovery: { type: "openai-models-list" },
};

function post(body) {
  return POST(new Request("http://localhost/api/models-config/discover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

/** Reset the stub and script the RPC reply. The stub impl runs while the route's
 *  temp agent dir still exists, so it can record the models.yml the route wrote. */
function scriptRun(impl) {
  stub.state.calls.length = 0;
  stub.state.calls.yaml = null;
  stub.state.impl = async (command, options) => {
    try {
      stub.state.calls.yaml = readFileSync(join(options.env.PI_CODING_AGENT_DIR, "models.yml"), "utf8");
    } catch (error) {
      stub.state.calls.yaml = `<<unreadable: ${String(error)}>>`;
    }
    return impl(command, options);
  };
  return stub.state;
}

test("discover requires a provider name and a provider object", async () => {
  scriptRun(async () => ({ models: [] }));

  for (const [body, code] of [
    [{}, "provider_name_required"],
    [{ providerName: "   ", provider: DISCOVERY_PROVIDER }, "provider_name_required"],
    [{ providerName: 7, provider: DISCOVERY_PROVIDER }, "provider_name_required"],
    [{ providerName: "lab" }, "provider_required"],
    [{ providerName: "lab", provider: "nope" }, "provider_required"],
    [{ providerName: "lab", provider: [] }, "provider_required"],
  ]) {
    const response = await post(body);
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.equal((await response.json()).code, code);
  }

  assert.equal(stub.state.calls.length, 0, "a rejected request must not spawn omp");
});

test("discover reports a config omp itself would refuse, without spawning", async () => {
  scriptRun(async () => ({ models: [] }));

  const response = await post({
    providerName: "lab",
    // Custom models with neither apiKey nor auth: none — omp rejects this file.
    provider: { baseUrl: "http://127.0.0.1:8000/v1", api: "openai-completions", models: [{ id: "m" }] },
  });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, "invalid_provider");
  assert.match(body.error, /apiKey/);
  assert.equal(stub.state.calls.length, 0, "validation must happen before any spawn");
});

test("discover queries get_available_models in a throwaway agent dir and keeps only the form fields", async () => {
  const seen = scriptRun(async () => ({
    models: [
      {
        id: "qwen3-coder-30b",
        name: "Qwen3 Coder 30B",
        provider: "lab",
        api: "openai-completions",
        reasoning: true,
        thinking: { mode: "effort", efforts: ["low", "high"], defaultLevel: "high" },
        input: ["text", "image"],
        contextWindow: 262144,
        maxTokens: 65536,
        cost: { input: 0.2, output: 0.6, cacheRead: 0.05, cacheWrite: 0.7 },
        // Fields that must never leave the server.
        identity: { internal: true },
        compat: { weird: 1 },
        baseUrl: "http://127.0.0.1:8000/internal/v1",
      },
      { id: "llama-3.3-70b-instruct", name: "Llama 3.3 70B", provider: "lab", contextWindow: 131072, maxTokens: 8192 },
      // Another provider in the same registry: not part of this provider's list.
      { id: "gpt-4o", name: "GPT-4o", provider: "other", contextWindow: 128000 },
    ],
  }));

  const response = await post({ providerName: "lab", provider: DISCOVERY_PROVIDER });
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.ok, true);
  assert.ok(Number.isInteger(body.latencyMs) && body.latencyMs >= 0, "latencyMs must be reported");
  assert.deepEqual(body.models.map((model) => model.id), ["qwen3-coder-30b", "llama-3.3-70b-instruct"]);
  assert.deepEqual(Object.keys(body.models[0]).sort(), [
    "contextWindow", "cost", "id", "input", "maxTokens", "name", "reasoning", "thinking",
  ]);
  assert.equal(body.models[0].provider, undefined, "the provider is implied by the request");
  assert.equal(body.models[0].compat, undefined, "the raw registry blob must not be returned");
  assert.equal(body.models[0].identity, undefined);
  assert.equal(body.models[0].baseUrl, undefined);
  assert.deepEqual(body.models[0].thinking, { mode: "effort", efforts: ["low", "high"], defaultLevel: "high" });
  assert.deepEqual(body.models[0].cost, { input: 0.2, output: 0.6, cacheRead: 0.05, cacheWrite: 0.7 });

  assert.equal(seen.calls.length, 1);
  const { command, options } = seen.calls[0];
  assert.deepEqual(command, { type: "get_available_models" });
  assert.equal(options.timeoutMs, 60_000);
  assert.ok(options.signal, "the request signal must abort the spawn on client disconnect");
  // The real ~/.omp must never be touched: the child sees only this temp dir.
  assert.ok(
    options.env.PI_CODING_AGENT_DIR.startsWith(tmpdir()),
    `the agent dir must be a throwaway under tmpdir, got ${options.env.PI_CODING_AGENT_DIR}`,
  );
  assert.notEqual(options.env.PI_CODING_AGENT_DIR, process.env.PI_CODING_AGENT_DIR);
  assert.equal(options.env.OMP_PROFILE, "");
  assert.equal(options.env.PI_PROFILE, "");
  assert.equal(options.env.XDG_DATA_HOME, "");
});

test("discover writes the provider under a temp models.yml and cleans the dir up", async () => {
  const seen = scriptRun(async () => ({ models: [{ id: "m1", provider: "lab" }] }));

  const response = await post({
    providerName: "lab",
    provider: DISCOVERY_PROVIDER,
    // Discovery is provider-level: a model in the body must not be written.
    model: { id: "should-not-appear" },
  });
  assert.equal(response.status, 200);

  assert.match(seen.calls.yaml, /lab:/);
  assert.match(seen.calls.yaml, /openai-models-list/);
  assert.doesNotMatch(seen.calls.yaml, /should-not-appear/);
  assert.equal(
    existsSync(seen.calls[0].options.env.PI_CODING_AGENT_DIR),
    false,
    "the throwaway agent dir must be removed",
  );
});

test("a server that answers with nothing is a success, not an error", async () => {
  scriptRun(async () => ({ models: [] }));

  const response = await post({ providerName: "lab", provider: DISCOVERY_PROVIDER });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.models, []);
  assert.ok(Number.isInteger(body.latencyMs) && body.latencyMs >= 0);
});

test("a failed discovery surfaces as discover_failed", async () => {
  scriptRun(async () => {
    throw new Error("omp exited (code 1, signal none): No models available");
  });

  const response = await post({ providerName: "lab", provider: DISCOVERY_PROVIDER });

  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, "discover_failed");
  assert.match(body.error, /No models available/);
});

test("a malformed get_available_models reply yields no models rather than throwing", async () => {
  scriptRun(async () => ({}));

  const response = await post({ providerName: "lab", provider: DISCOVERY_PROVIDER });

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).models, []);
});
