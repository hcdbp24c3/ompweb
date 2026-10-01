import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { BOOT_MODEL_CANDIDATES, isNoModelBootFailure, utilityExtraArgs, withBootModelFallback } =
  await jiti.import("./rpc-utility.ts");

const source = await readFile(new URL("./rpc-utility.ts", import.meta.url), "utf8");

const noModelFailure = (message) => new Error(`omp exited (code 1, signal none): ${message}`);

test("utility RPC processes negotiate v2 before sending commands", () => {
  const negotiations = source.match(/await proc\.negotiateProtocol\(ready\)/g) ?? [];

  assert.equal(negotiations.length, 2);
});

test("boot model candidates stay a multi-entry list of provider-qualified ids", () => {
  assert.ok(
    BOOT_MODEL_CANDIDATES.length >= 2,
    `expected at least 2 boot candidates, got ${BOOT_MODEL_CANDIDATES.length}`,
  );
  // Measured as absent from omp's catalog, so it must never be a candidate.
  assert.equal(BOOT_MODEL_CANDIDATES.includes("openai-codex/gpt-5-codex"), false);
  for (const candidate of BOOT_MODEL_CANDIDATES) {
    assert.match(candidate, /^[a-z0-9._-]+\/[a-z0-9._:-]+$/, `candidate ${candidate} must be a provider-qualified model id`);
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
