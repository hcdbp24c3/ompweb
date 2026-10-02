import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  TERMINAL_ONLY_LOGIN_PROVIDERS,
  isInteractivePromptRejection,
  isTerminalOnlyProvider,
} = await jiti.import("@/lib/omp/login-providers.ts");

// omp's RPC `login` cannot drive a provider whose flow prompts before it emits
// an authorization URL: rpc-mode.ts rejects that with "requires interactive
// prompts which are not supported in RPC mode", and it also rejects secret
// prompts outright. There is no flag, command or option that changes this, so
// these providers cannot be connected from the browser at all.
//
// The list is measured, not guessed: every provider in omp's get_login_providers
// list (80 on omp 18.4.6) was probed and classified. 75 emit an open_url flow
// and work; these 5 do not. They all use omp's `login "custom"` hook, and they
// prompt for something first — github-copilot asks whether the account is
// github.com or a GHE enterprise domain before making its device request.
//
// A different omp version may change the set, so isInteractivePromptRejection
// still translates omp's refusal at runtime: an unlisted provider that starts
// failing degrades to the same clear explanation, never to omp's raw wording.
test("the measured list is the five providers that refuse a headless login", () => {
  assert.deepEqual(
    [...TERMINAL_ONLY_LOGIN_PROVIDERS].sort(),
    ["alibaba-coding-plan", "alibaba-token-plan", "github-copilot", "lm-studio", "perplexity"],
  );
});

test("terminal-only lookup is by provider id and defaults to false", () => {
  assert.equal(isTerminalOnlyProvider("github-copilot"), true);
  assert.equal(isTerminalOnlyProvider("lm-studio"), true);
  assert.equal(isTerminalOnlyProvider("anthropic"), false);
  assert.equal(isTerminalOnlyProvider("openrouter"), false);
  assert.equal(isTerminalOnlyProvider(undefined), false);
  assert.equal(isTerminalOnlyProvider(""), false);
});

test("omp's interactive-prompt refusal is recognised for the same providers", () => {
  const message = "Provider 'github-copilot' requires interactive prompts which are not supported in RPC mode. Use the terminal UI to log in.";
  assert.equal(isInteractivePromptRejection(message, "github-copilot"), true);
});

test("a secret-prompt refusal is the same dead end and is recognised too", () => {
  const message = "Provider 'perplexity' requires secret input, which is not supported in RPC mode. Use the terminal UI to log in.";
  assert.equal(isInteractivePromptRejection(message, "perplexity"), true);
});

test("a refusal that survives a trimmed stderr tail is still recognised", () => {
  // runOmp keeps only the last 600 chars of stderr, so the match cannot rely on
  // the message starting at the beginning.
  const padded = `${"x".repeat(700)}Provider 'lm-studio' requires interactive prompts which are not supported in RPC mode.`;
  assert.equal(isInteractivePromptRejection(padded.slice(-600), "lm-studio"), true);
});

test("an unrelated login error is not mistaken for the prompt refusal", () => {
  assert.equal(isInteractivePromptRejection("Unknown OAuth provider: nope", "nope"), false);
  assert.equal(isInteractivePromptRejection("omp exited (code 1): boom", "anthropic"), false);
  assert.equal(isInteractivePromptRejection("", "anthropic"), false);
});

test("another provider's refusal does not get attributed to this one", () => {
  // The wording embeds the provider id; matching the phrase alone would label
  // every provider as terminal-only the moment any one of them fails.
  const message = "Provider 'perplexity' requires interactive prompts which are not supported in RPC mode.";
  assert.equal(isInteractivePromptRejection(message, "anthropic"), false);
});