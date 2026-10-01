import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  ModelsConfigParseError,
  readModelsConfigFile,
  serializeModelsConfig,
  validateModelsConfig,
  writeModelsConfig,
} = await jiti.import("./models-config.ts");

// A hand-edited models.yml: comments, blank lines and quoting that a
// parse+stringify round trip would silently throw away.
const HAND_EDITED = `# Custom providers for omp.
# Keep the local llama entry first.

providers:
  local-llama:
    baseUrl: http://127.0.0.1:8080/v1 # llama.cpp server
    apiKey: LLAMA_API_KEY
    api: openai-completions
    models:
      # 70B, quantized
      - id: llama-3.3-70b
        name: "Llama 3.3 70B"
        contextWindow: 131072
        maxTokens: 8192
      # small, fast
      - id: llama-3.2-3b
        name: Llama 3.2 3B
        contextWindow: 32768

  work-proxy:
    baseUrl: https://proxy.internal/v1
    apiKey: "!op read op://work/openai/key"
    api: openai-responses
    models:
      - id: gpt-5
        reasoning: true
`;

function withAgentDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-models-config-"));
  const previous = {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    xdg: process.env.XDG_DATA_HOME,
  };
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.XDG_DATA_HOME;
  try {
    run(dir, join(dir, "models.yml"));
  } finally {
    for (const [key, value] of [
      ["PI_CODING_AGENT_DIR", previous.agentDir],
      ["XDG_DATA_HOME", previous.xdg],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("round-trips a hand-edited models.yml without losing comments", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, HAND_EDITED, "utf8");

    const file = readModelsConfigFile();
    assert.equal(file.parseError, undefined);
    assert.deepEqual(Object.keys(file.config.providers), ["local-llama", "work-proxy"]);

    // Edit exactly what the editor would: bump a model's maxTokens.
    file.config.providers["local-llama"].models[0].maxTokens = 16384;
    writeModelsConfig(file.config);

    const written = readFileSync(path, "utf8");
    assert.match(written, /# Custom providers for omp\./);
    assert.match(written, /# Keep the local llama entry first\./);
    assert.match(written, /# llama\.cpp server/);
    assert.match(written, /# 70B, quantized/);
    assert.match(written, /maxTokens: 16384/);
    assert.match(written, /apiKey: "!op read op:\/\/work\/openai\/key"/);
    assert.equal(readModelsConfigFile().config.providers["local-llama"].models[0].maxTokens, 16384);
  });
});

test("a save with no edits leaves the file byte-identical", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, HAND_EDITED, "utf8");
    writeModelsConfig(readModelsConfigFile().config);
    assert.equal(readFileSync(path, "utf8"), HAND_EDITED);
  });
});

test("keeps a model's comments with the model when siblings are removed", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, HAND_EDITED, "utf8");

    const { config } = readModelsConfigFile();
    // Drop the first model: with positional merging the 3B entry would inherit
    // the 70B node and "# small, fast" would be dropped with it.
    config.providers["local-llama"].models.splice(0, 1);
    writeModelsConfig(config);

    const written = readFileSync(path, "utf8");
    assert.match(written, /# small, fast\n\s+- id: llama-3\.2-3b/);
    assert.doesNotMatch(written, /llama-3\.3-70b/);
    // "# 70B, quantized" preceded the first item, so YAML attaches it to the
    // sequence rather than the item — it survives the deletion by design.
  });
});

test("adds and removes providers", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, HAND_EDITED, "utf8");

    const { config } = readModelsConfigFile();
    delete config.providers["work-proxy"];
    config.providers["new-provider"] = {
      baseUrl: "https://api.example.com/v1",
      apiKey: "EXAMPLE_KEY",
      api: "openai-completions",
      models: [{ id: "example-1", contextWindow: 8000 }],
    };
    writeModelsConfig(config);

    const reread = readModelsConfigFile();
    assert.deepEqual(Object.keys(reread.config.providers), ["local-llama", "new-provider"]);
    assert.equal(reread.config.providers["new-provider"].models[0].contextWindow, 8000);
    assert.match(readFileSync(path, "utf8"), /# Custom providers for omp\./);
  });
});

test("reports a parse error instead of an empty config", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "providers:\n  broken: [unclosed\n", "utf8");

    const file = readModelsConfigFile();
    assert.ok(file.parseError, "expected a parse error");
    assert.deepEqual(file.config, { providers: {} });
  });
});

test("refuses to overwrite an unparseable models.yml", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    const broken = "providers:\n  broken: [unclosed\n";
    writeFileSync(path, broken, "utf8");

    assert.throws(
      () => writeModelsConfig({ providers: {} }),
      (error) => error instanceof ModelsConfigParseError,
    );
    assert.equal(readFileSync(path, "utf8"), broken, "the broken file must be left untouched");

    writeModelsConfig({ providers: { a: { baseUrl: "https://x/v1", apiKey: "K", api: "openai-completions" } } }, { overwriteUnparseable: true });
    assert.deepEqual(Object.keys(readModelsConfigFile().config.providers), ["a"]);
  });
});

test("treats a non-mapping models.yml as unparseable", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "- one\n- two\n", "utf8");
    assert.ok(readModelsConfigFile().parseError);
  });
});

test("writes a fresh file when none exists", () => {
  withAgentDir((dir, path) => {
    const file = readModelsConfigFile();
    assert.equal(file.exists, false);
    writeModelsConfig({ providers: { p: { baseUrl: "https://x/v1", apiKey: "K", api: "openai-completions", models: [{ id: "m" }] } } });
    assert.match(readFileSync(path, "utf8"), /id: m/);
  });
});

test("serializeModelsConfig without a source still emits plain YAML", () => {
  const text = serializeModelsConfig({ providers: { p: { api: "openai-completions" } } });
  assert.match(text, /providers:\n {2}p:\n {4}api: openai-completions/);
});

test("validation rejects partial model cost but accepts a complete one", () => {
  const base = {
    providers: {
      p: {
        baseUrl: "https://api.example.com/v1",
        api: "openai-completions",
        auth: "none",
        models: [{ id: "m", cost: { input: 1, output: 2 } }],
      },
    },
  };

  assert.throws(
    () => validateModelsConfig(base),
    /cost\.cacheRead is required/,
  );

  validateModelsConfig({
    ...base,
    providers: {
      p: {
        ...base.providers.p,
        models: [{ id: "m", cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 2 } }],
      },
    },
  });
});

// ── omp's own provider validation, ported branch by branch ─────────────────────
// Mirrors validateProviderConfiguration(mode: "models-config") in omp's
// coding-agent/src/config/models-config.ts plus the narrows on
// ProviderDiscoverySchema / ModelDefinitionSchema in models-config-schema-bundle.ts.

test("accepts a discovery-only provider that also names its api", () => {
  validateModelsConfig({
    providers: {
      lab: {
        baseUrl: "http://127.0.0.1:8000/v1",
        api: "openai-completions",
        auth: "none",
        discovery: { type: "openai-models-list", timeoutMs: 5000, injectV1: false },
      },
    },
  });
});

test("rejects discovery without a provider-level api", () => {
  assert.throws(
    () => validateModelsConfig({
      providers: {
        lab: {
          baseUrl: "http://127.0.0.1:8000/v1",
          auth: "none",
          discovery: { type: "openai-models-list" },
        },
      },
    }),
    /Provider lab: "api" is required when discovery is enabled at provider level\./,
  );
});

test("discovery type proxy is exempt from the provider-level api requirement", () => {
  validateModelsConfig({
    providers: { lab: { baseUrl: "http://127.0.0.1:8000", auth: "none", discovery: { type: "proxy" } } },
  });
});

test("a model-level api does not satisfy the discovery requirement", () => {
  assert.throws(
    () => validateModelsConfig({
      providers: {
        lab: {
          baseUrl: "http://127.0.0.1:8000/v1",
          auth: "none",
          discovery: { type: "ollama" },
          models: [{ id: "m", api: "openai-completions" }],
        },
      },
    }),
    /"api" is required when discovery is enabled at provider level/,
  );
});

test("rejects a model-less provider that declares no connection field", () => {
  assert.throws(
    () => validateModelsConfig({ providers: { empty: {} } }),
    /Provider empty: must specify "baseUrl", "headers", "apiKey", "auth: none", "compat", "disableStrictTools", "guardrailIdentifier", "requestMetadata", "remoteCompaction", "modelOverrides", "discovery", or "models"/,
  );
});

test("any single connection field satisfies a model-less provider", () => {
  const sufficient = {
    baseUrl: "https://api.example.com/v1",
    headers: { "X-Team": "core" },
    apiKey: "EXAMPLE_KEY",
    auth: "none",
    compat: { supportsDeveloperRole: true },
    disableStrictTools: true,
    guardrailIdentifier: "arn:aws:bedrock:guardrail",
    requestMetadata: { env: "prod" },
    remoteCompaction: { enabled: true },
    modelOverrides: { "my-model": { name: "My Model" } },
    discovery: { type: "ollama" },
  };
  for (const [key, value] of Object.entries(sufficient)) {
    // api is always present so the discovery branch cannot be what fails here.
    validateModelsConfig({ providers: { p: { api: "openai-completions", [key]: value } } });
  }
  // omp checks truthiness: false / empty are not enough, and an empty
  // modelOverrides map has no keys to count.
  for (const key of ["disableStrictTools", "modelOverrides", "baseUrl", "headers", "apiKey", "compat"]) {
    const empty = key === "modelOverrides" ? {} : key === "disableStrictTools" ? false : "";
    assert.throws(
      () => validateModelsConfig({ providers: { p: { api: "openai-completions", [key]: empty } } }),
      /must specify/,
      `${key}: ${JSON.stringify(empty)} must not count as a connection field`,
    );
  }
});

test("discovery injectV1 is only valid on openai-models-list", () => {
  assert.throws(
    () => validateModelsConfig({
      providers: {
        lab: { baseUrl: "http://127.0.0.1:11434", api: "openai-completions", auth: "none", discovery: { type: "ollama", injectV1: false } },
      },
    }),
    /injectV1/,
  );

  validateModelsConfig({
    providers: {
      lab: { baseUrl: "http://127.0.0.1:11434", api: "openai-completions", auth: "none", discovery: { type: "ollama" } },
    },
  });
});

test("discovery timeoutMs must be a positive finite number", () => {
  const withTimeout = (timeoutMs) => ({
    providers: {
      lab: { baseUrl: "http://127.0.0.1:11434", api: "openai-completions", auth: "none", discovery: { type: "ollama", timeoutMs } },
    },
  });

  for (const timeoutMs of [0, -1, Infinity, NaN, "5000"]) {
    assert.throws(
      () => validateModelsConfig(withTimeout(timeoutMs)),
      /timeoutMs/,
      `timeoutMs: ${String(timeoutMs)} must be rejected`,
    );
  }
  validateModelsConfig(withTimeout(1));
  validateModelsConfig(withTimeout(30_000));
});

test("maxContextWindow must be a positive integer no smaller than contextWindow", () => {
  const withModel = (model) => ({
    providers: {
      p: { baseUrl: "https://api.example.com/v1", api: "openai-completions", auth: "none", models: [model] },
    },
  });

  assert.throws(
    () => validateModelsConfig(withModel({ id: "m", contextWindow: 131072, maxContextWindow: 32768 })),
    /Provider p, model m: maxContextWindow/,
  );
  assert.throws(() => validateModelsConfig(withModel({ id: "m", maxContextWindow: 0 })), /maxContextWindow/);
  assert.throws(() => validateModelsConfig(withModel({ id: "m", maxContextWindow: -1 })), /maxContextWindow/);
  assert.throws(() => validateModelsConfig(withModel({ id: "m", maxContextWindow: 1.5 })), /maxContextWindow/);

  // Equal is allowed, and maxContextWindow stands alone.
  validateModelsConfig(withModel({ id: "m", contextWindow: 131072, maxContextWindow: 131072 }));
  validateModelsConfig(withModel({ id: "m", maxContextWindow: 262144 }));
});

test("validation still accepts the plain models + baseUrl + apiKey provider shape", () => {
  validateModelsConfig({
    providers: {
      p: {
        baseUrl: "https://api.example.com/v1",
        apiKey: "EXAMPLE_KEY",
        api: "openai-completions",
        models: [{ id: "m", contextWindow: 8000, maxTokens: 4096 }],
      },
    },
  });
});

// omp's validateProviderConfiguration(mode: "models-config") computes
// `!apiKey && (auth ?? "apiKey") !== "none" && (auth ?? "apiKey") !== "oauth"`
// (coding-agent/src/config/models-config.ts, confirmed in the 18.4.6 bundle).
// omp-web accepted only "none", so it refused to save a file omp loads clean:
// hand-written `auth: oauth` + Settings → Save returned 400 and wrote nothing.

test("auth: oauth satisfies the apiKey requirement, as it does in omp", () => {
  validateModelsConfig({
    providers: {
      p: {
        baseUrl: "https://chat.example.com/v1",
        auth: "oauth",
        api: "openai-completions",
        models: [{ id: "big", contextWindow: 128000, maxTokens: 16000 }],
      },
    },
  });
});

test("only none and oauth excuse a missing apiKey", () => {
  const provider = {
    baseUrl: "https://api.example.com/v1",
    api: "openai-completions",
    models: [{ id: "m" }],
  };
  const required = /"apiKey" is required when defining custom models/;

  assert.throws(() => validateModelsConfig({ providers: { p: provider } }), required, "an unset auth means apiKey");
  assert.throws(
    () => validateModelsConfig({ providers: { p: { ...provider, auth: "apiKey" } } }),
    required,
    "an explicit apiKey auth is the same requirement",
  );
  // The accepted set is the two named modes, not "anything that is not none":
  // an unrecognised value must not become a way past the check.
  assert.throws(() => validateModelsConfig({ providers: { p: { ...provider, auth: "bearer" } } }), required);

  validateModelsConfig({ providers: { p: { ...provider, auth: "none" } } });
});

test("the apiKey error quotes omp's own wording, oauth included", () => {
  assert.throws(
    () => validateModelsConfig({ providers: { p: { baseUrl: "https://x/v1", api: "openai-completions", models: [{ id: "m" }] } } }),
    /unless auth is "none" or "oauth"\./,
    "a message that drops oauth would send the user hunting for a key they do not need",
  );
});

test("auth: oauth alone still does not make a model-less provider reachable", () => {
  // omp's connection-field branch tests `auth !== "none"`, so oauth is not
  // listed there either. Mirrored on purpose.
  assert.throws(
    () => validateModelsConfig({ providers: { p: { auth: "oauth" } } }),
    /must specify "baseUrl", "headers", "apiKey", "auth: none"/,
  );
});

test("ignores blank model rows while preserving non-empty rows", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "providers:\n  p:\n    models:\n      - id: \"\"\n      - id: \"   \"\n      - id: valid\n", "utf8");

    const file = readModelsConfigFile();
    assert.deepEqual(file.config.providers.p.models.map((model) => model.id), ["valid"]);
    writeModelsConfig(file.config);
    assert.deepEqual(readModelsConfigFile().config.providers.p.models.map((model) => model.id), ["valid"]);
  });
});
