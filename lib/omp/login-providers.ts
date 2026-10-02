/**
 * Providers that omp cannot log in to from a browser.
 *
 * omp's RPC `login` command drives the flow itself: it forwards an
 * `extension_ui_request` / open_url frame when the provider is OAuth, and an
 * `input` frame when it needs the user to paste a code back. But its `onPrompt`
 * hook refuses two cases outright (coding-agent src/modes/rpc/rpc-mode.ts):
 *
 *   - a secret prompt, always; and
 *   - any prompt that arrives BEFORE an authorization URL was emitted.
 *
 * A provider that must ask something first therefore cannot be logged in to
 * over RPC at all, and omp answers "Provider '<id>' requires interactive
 * prompts which are not supported in RPC mode. Use the terminal UI to log in."
 * There is no flag or command that changes that — the refusal is in the prompt
 * hook, so it is a property of the provider's flow, not of the transport.
 *
 * The list below is measured, not guessed. Every provider omp reports from
 * get_login_providers (80 on omp 18.4.6) was probed on a blank install by
 * spawning the login flow and watching for an open_url frame: 75 emit one and
 * work, these 5 refuse. All five use omp's `login "custom"` hook and prompt
 * before authorizing — github-copilot asks whether the account is github.com or
 * a GHE enterprise domain before it makes its device-code request.
 *
 * A different omp version may change the set. That is why
 * isInteractivePromptRejection also exists: the login route translates omp's
 * refusal at runtime, so a provider that is not listed here but starts refusing
 * still gets the same explanation instead of omp's raw wording.
 */
export const TERMINAL_ONLY_LOGIN_PROVIDERS: ReadonlySet<string> = new Set([
  "alibaba-coding-plan",
  "alibaba-token-plan",
  "github-copilot",
  "lm-studio",
  "perplexity",
]);

/** True when `provider` is one of the measured terminal-only providers. */
export function isTerminalOnlyProvider(provider: string | null | undefined): boolean {
  return typeof provider === "string" && TERMINAL_ONLY_LOGIN_PROVIDERS.has(provider);
}

/**
 * Recognise omp's headless-login refusal.
 *
 * The provider id is required rather than matched loosely on purpose: omp
 * embeds the id in the message, and matching the phrase alone would make one
 * provider's failure mark every other provider as terminal-only.
 */
export function isInteractivePromptRejection(message: string, provider: string): boolean {
  if (typeof message !== "string" || !message) return false;
  if (!/not supported in RPC mode/i.test(message)) return false;
  if (!/requires (interactive prompts|secret input)/i.test(message)) return false;
  // The id must actually appear, so a different provider's refusal is ignored.
  return message.includes(provider);
}