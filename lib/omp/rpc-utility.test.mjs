import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  BOOT_MODEL_CANDIDATES,
  UTILITY_EXTRA_ARGS,
  bootExtraArgs,
  isNoModelBootFailure,
  utilityExtraArgs,
  withBootModelFallback,
} = await jiti.import("./rpc-utility.ts");

const source = await readFile(new URL("./rpc-utility.ts", import.meta.url), "utf8");

const noModelFailure = (message) => new Error(`omp exited (code 1, signal none): ${message}`);

test("utility RPC processes negotiate v2 before sending commands", () => {
  const negotiations = source.match(/await proc\.negotiateProtocol\(ready\)/g) ?? [];

  assert.equal(negotiations.length, 2);
});

test("boot model candidates lead with selectors that survive a catalog change", () => {
  assert.ok(
    BOOT_MODEL_CANDIDATES.length >= 2,
    `expected at least 2 boot candidates, got ${BOOT_MODEL_CANDIDATES.length}`,
  );
  // Measured as absent from omp's catalog, so it must never be a candidate.
  assert.equal(BOOT_MODEL_CANDIDATES.includes("openai-codex/gpt-5-codex"), false);

  // `--model` fuzzy-matches ("opus", "gpt-5.2", "openai/gpt-5.2"), so a bare
  // provider id resolves on any omp whose catalog still has that provider —
  // unlike a pinned provider/model id, which dies the day omp renames that
  // model. The pinned ids stay behind as precise later fallbacks.
  const firstQualified = BOOT_MODEL_CANDIDATES.findIndex((c) => c.includes("/"));
  const bareProviders = firstQualified === -1
    ? BOOT_MODEL_CANDIDATES
    : BOOT_MODEL_CANDIDATES.slice(0, firstQualified);
  assert.ok(bareProviders.length >= 1, "at least one provider-level candidate comes first");
  for (const candidate of bareProviders) {
    assert.doesNotMatch(candidate, /\//, `leading candidate ${candidate} must be provider-level, not pinned to a model id`);
    assert.match(candidate, /^[a-z0-9._-]+$/, `candidate ${candidate} must be a bare provider or model-family name`);
  }
  for (const candidate of BOOT_MODEL_CANDIDATES) {
    assert.match(candidate, /^[a-z0-9._-]+(\/[a-z0-9._:-]+)?$/, `candidate ${candidate} is not a usable --model selector`);
  }
});

test("--model is appended only when a boot selector is supplied", () => {
  const base = ["--no-session", "--no-skills", "--no-lsp"];

  assert.deepEqual(utilityExtraArgs(), base);
  assert.deepEqual(utilityExtraArgs("anthropic/claude-sonnet-4-5"), [
    ...base,
    "--model",
    "anthropic/claude-sonnet-4-5",
  ]);
  // A selector-aware call must not leak back into the shared argument list.
  assert.deepEqual(utilityExtraArgs(), base);
});

test("only omp refusing to start without a usable model is a recoverable boot failure", () => {
  assert.equal(
    isNoModelBootFailure(noModelFailure("No models available. Use /login or set an API key environment variable.")),
    true,
  );
  assert.equal(isNoModelBootFailure(noModelFailure('Model "anthropic/nope" not found')), true);

  assert.equal(isNoModelBootFailure(new Error("omp binary not found. Install oh-my-pi or set OMP_WEB_OMP_BIN.")), false);
  assert.equal(isNoModelBootFailure(new Error("omp RPC ready timeout after 60000ms")), false);
  assert.equal(isNoModelBootFailure("RPC protocol error: bad frame"), false);
  assert.equal(isNoModelBootFailure(undefined), false);
});

test("a utility boot that works without a selector never receives --model", async () => {
  const attempts = [];

  const result = await withBootModelFallback(async (selector) => {
    attempts.push(selector);
    return "proc";
  });

  assert.equal(result, "proc");
  assert.deepEqual(attempts, [undefined]);
});

test("a no-model boot failure retries the candidate selectors in order", async () => {
  const attempts = [];

  const result = await withBootModelFallback(async (selector) => {
    attempts.push(selector);
    if (attempts.length <= 2) throw noModelFailure("No models available.");
    return "proc";
  });

  assert.equal(result, "proc");
  assert.deepEqual(attempts, [undefined, BOOT_MODEL_CANDIDATES[0], BOOT_MODEL_CANDIDATES[1]]);
});

test("a boot failure unrelated to missing models is rethrown untouched", async () => {
  const boom = new Error("omp RPC ready timeout after 60000ms");
  const attempts = [];

  await assert.rejects(
    withBootModelFallback(async (selector) => {
      attempts.push(selector);
      throw boom;
    }),
    (error) => {
      assert.equal(error, boom);
      return true;
    },
  );
  assert.deepEqual(attempts, [undefined]);
});

test("the last no-model failure surfaces when every candidate is rejected", async () => {
  const attempts = [];
  const expectedCalls = BOOT_MODEL_CANDIDATES.length + 1;

  await assert.rejects(
    withBootModelFallback(async (selector) => {
      attempts.push(selector);
      throw noModelFailure(`Model "candidate-${attempts.length}" not found`);
    }),
    new RegExp(`candidate-${expectedCalls}`),
  );
  assert.equal(attempts.length, expectedCalls);
});

test("the shared utility process start routes through the boot fallback", () => {
  assert.match(source, /withBootModelFallback\(\(selector\) => startProcess\(state,\s*selector\)\)/);
});

// The login route spawns its own dedicated process and hit the same zero-model
// guard: on a blank install omp exited 1 before the login flow started, so every
// "Sign in" card was dead. It must get the same fallback — but it cannot reuse
// utilityExtraArgs, because login deliberately passes --no-extensions while the
// utility process keeps extensions enabled (they register models and login
// providers, and omitting them made the web UI disagree with the CLI).
test("boot args accept a caller-supplied base, so login can keep --no-extensions", () => {
  const loginBase = ["--no-session", "--no-extensions", "--no-skills", "--no-lsp"];
  assert.deepEqual(bootExtraArgs(loginBase), loginBase, "no selector means no --model");
  assert.deepEqual(bootExtraArgs(loginBase, "anthropic/claude-sonnet-4-5"), [
    ...loginBase,
    "--model",
    "anthropic/claude-sonnet-4-5",
  ]);
  // The utility process must be unaffected by the generalisation.
  assert.deepEqual(utilityExtraArgs(), UTILITY_EXTRA_ARGS.slice());
});

test("the fallback loop retries a caller that owns its own base args", async () => {
  const attempts = [];
  const loginBase = ["--no-session", "--no-extensions", "--no-skills", "--no-lsp"];

  const result = await withBootModelFallback(async (selector) => {
    attempts.push(selector);
    if (selector === undefined) throw noModelFailure("No models available");
    return bootExtraArgs(loginBase, selector);
  });

  assert.deepEqual(attempts, [undefined, BOOT_MODEL_CANDIDATES[0]]);
  assert.deepEqual(result, [...loginBase, "--model", BOOT_MODEL_CANDIDATES[0]]);
});

test("a non-boot failure is not retried", async () => {
  const attempts = [];
  await assert.rejects(
    withBootModelFallback(async (selector) => {
      attempts.push(selector);
      throw new Error("omp binary not found");
    }),
    /omp binary not found/,
  );
  assert.deepEqual(attempts, [undefined], "only omp's no-model refusal advances the loop");
});
