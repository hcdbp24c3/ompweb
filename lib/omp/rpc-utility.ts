import { homedir } from "os";
import { RpcProcess } from "./rpc-process";

/**
 * Shared short-lived `omp` utility process for global registry/auth queries
 * (get_available_models, get_login_providers, get_state). These commands do
 * not belong to any user session, so they run against a single lazily-started
 * RPC process that is killed after ~60s of inactivity. Access is serialized:
 * the omp RPC loop handles one command at a time anyway, and serialization
 * lets lazy start/idle-kill stay race-free.
 *
 * Real user sessions must use lib/rpc-manager.ts instead — this process runs
 * with --no-session and its agent state is throwaway.
 */

// Extensions stay ENABLED: they can register models and login providers, and
// omitting them made the web UI's model/provider lists disagree with the CLI's.
// Measured against a real install (omp/17.1.3): ready-frame latency is the same
// either way (~3.6s with vs ~4.0s without over 4 runs each).
export const UTILITY_EXTRA_ARGS = ["--no-session", "--no-skills", "--no-lsp"];

// omp exits 1 when it resolves zero models, and that check (coding-agent's
// main.ts:2425) runs BEFORE the `mode === "rpc"` branch, so the process dies
// before printing its `ready` frame and no command is ever answered — a brand
// new install could not even list providers to add its first model. `--model`
// exists purely to satisfy that guard: `get_available_models` is unaffected by
// it and /api/models already gates defaultModel behind `available.some(...)`.
//
// Only this `--no-session` utility process is forced. Real sessions must use
// lib/rpc-manager.ts and keep the model the user picked.
//
// Ordered by measurement, not guesswork: the first entry resolves on the
// installed catalog; the rest are fallbacks for a future catalog that drops it.
// Ids that do NOT exist in the catalog are deliberately left out — one of them
// (`openai-codex/gpt-5-codex`) was verified missing.
//
// The leading entries are bare provider ids because `--model` fuzzy-matches
// ("opus", "gpt-5.2", "openai/gpt-5.2" all resolve — verified on omp 18.4.6), so
// they keep working when omp renames a model. A pinned `provider/model-id`
// candidate is precise but dies with the first catalog bump that renames it,
// which is exactly how a login route silently stops working on a newer omp: the
// fallback exhausts and omp's own "No models available" surfaces verbatim.
export const BOOT_MODEL_CANDIDATES = [
  "anthropic",
  "openai",
  "anthropic/claude-sonnet-4-5",
  "openai/gpt-5",
  "openai/gpt-4o",
];

// omp's own wording when it refuses to boot without a model (stderr tail is
// folded into the exit error by RpcProcess), plus the message it prints when an
// explicit --model selector cannot be resolved. Anything else (missing binary,
// timeout, protocol error) must NOT be masked by the boot fallback.
const NO_MODEL_EXIT_RE = /No models available|Model ".*" not found/;

/** True only for omp's "I have no model to start with" refusal. */
export function isNoModelBootFailure(error: unknown): boolean {
  return NO_MODEL_EXIT_RE.test(error instanceof Error ? error.message : String(error));
}

/** Base utility args, plus `--model <selector>` only when one is supplied, so a
 *  user who already has a working model boots exactly as before.
 *
 *  `baseArgs` is a parameter because other omp processes hit the same guard and
 *  need the same treatment with a different base: the login route spawns its own
 *  dedicated process with `--no-extensions`, and reusing UTILITY_EXTRA_ARGS there
 *  would re-enable extensions and change which login providers it can see.
 *
 *  `boot` owns its own argument list, so other processes can reuse this loop
 *  with a different base: the login route passes --no-extensions and must not
 *  inherit UTILITY_EXTRA_ARGS, which keeps extensions enabled on purpose. */
export function bootExtraArgs(baseArgs: readonly string[], modelSelector?: string): string[] {
  return modelSelector ? [...baseArgs, "--model", modelSelector] : [...baseArgs];
}

export function utilityExtraArgs(modelSelector?: string): string[] {
  return bootExtraArgs(UTILITY_EXTRA_ARGS, modelSelector);
}

/** Boot attempt order: no selector first (the current happy path), then the
 *  candidates in order, stopping at the first success. Only omp's no-model
 *  refusal advances the loop — every other failure is rethrown untouched, and
 *  when all candidates are rejected the last omp error is surfaced verbatim so
 *  logs stay useful. */
export async function withBootModelFallback<T>(
  boot: (modelSelector: string | undefined) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  try {
    return await boot(undefined);
  } catch (error) {
    if (!isNoModelBootFailure(error)) throw error;
    lastError = error;
  }
  for (const selector of BOOT_MODEL_CANDIDATES) {
    try {
      return await boot(selector);
    } catch (error) {
      if (!isNoModelBootFailure(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

const READY_TIMEOUT_MS = 60_000;
// Longer than the 60s models-cache TTL on purpose: with idle-kill == TTL every
// pause past a minute paid a cold multi-second respawn on top of the stale
// cache. Cost of the longer window is one idle omp process.
const IDLE_KILL_MS = 300_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

/** Minimal mirror of omp's Model (packages/catalog/src/types.ts) — only the
 * fields the models/auth routes read. Everything else passes through opaque. */
export interface OmpModel {
  id: string;
  name: string;
  provider: string;
  api?: string;
  reasoning?: boolean;
  thinking?: {
    mode?: string;
    efforts?: string[];
    defaultLevel?: string;
    effortMap?: Record<string, string>;
  };
  input?: string[];
  contextWindow?: number | null;
  maxTokens?: number | null;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

/** Entry of the get_login_providers response (modes/rpc/rpc-types.ts). */
export interface OmpLoginProvider {
  id: string;
  name: string;
  available: boolean;
  authenticated: boolean;
}

interface UtilityRpcState {
  proc: RpcProcess | null;
  idleTimer: NodeJS.Timeout | null;
  queue: Promise<void>;
}

declare global {
  var __ompUtilityRpcState: UtilityRpcState | undefined;
}

function getState(): UtilityRpcState {
  if (!globalThis.__ompUtilityRpcState) {
    globalThis.__ompUtilityRpcState = { proc: null, idleTimer: null, queue: Promise.resolve() };
    // Mirror the session registry in lib/rpc-manager.ts: dispose the shared
    // utility omp process on server shutdown so it does not outlive the server.
    // Idempotent and safe to call any time (clears the idle timer + disposes).
    const cleanup = () => disposeUtilityRpc();
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__ompUtilityRpcState;
}

/**
 * Tear down the shared utility omp process immediately (skip the idle timer).
 * Registered as a server-shutdown hook in getState() above (mirroring the
 * session registry in lib/rpc-manager.ts) so the utility process does not
 * outlive the server; also safe to call any time — it just clears any pending
 * idle kill and disposes the live child.
 */
export function disposeUtilityRpc(): void {
  const state = globalThis.__ompUtilityRpcState;
  if (!state) return;
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
  const proc = state.proc;
  state.proc = null;
  if (proc) void proc.dispose();
}

function scheduleIdleKill(state: UtilityRpcState): void {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    state.idleTimer = null;
    const proc = state.proc;
    state.proc = null;
    if (proc) void proc.dispose();
  }, IDLE_KILL_MS);
  state.idleTimer.unref?.();
}

async function startProcess(state: UtilityRpcState, modelSelector?: string): Promise<RpcProcess> {
  const proc = new RpcProcess({
    cwd: homedir(),
    extraArgs: utilityExtraArgs(modelSelector),
    onExit: () => {
      if (state.proc === proc) state.proc = null;
    },
  });
  try {
    const ready = await proc.waitReady(READY_TIMEOUT_MS);
    await proc.negotiateProtocol(ready);
  } catch (error) {
    void proc.dispose();
    throw error;
  }
  return proc;
}

/** Run one RPC command on the shared utility process (lazy start, serialized,
 * idle-killed). Rejections from earlier commands never poison the queue. */
export function runUtilityCommand<T = unknown>(
  command: { type: string; [key: string]: unknown },
  timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<T> {
  const state = getState();
  const run = state.queue.then(async () => {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
    try {
      if (!state.proc || !state.proc.isAlive) {
        state.proc = await withBootModelFallback((selector) => startProcess(state, selector));
      }
      return await state.proc.sendCommand<T>(command, timeoutMs);
    } finally {
      scheduleIdleKill(state);
    }
  });
  state.queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Run one RPC command on a dedicated throwaway process. Used where the shared
 * process must not be reused — e.g. the models-config connectivity test, which
 * points PI_CODING_AGENT_DIR at a temp dir via `env`.
 *
 * `signal` (optional) aborts the whole lifecycle: a not-yet-ready child is
 * disposed immediately and a pending command is rejected. Callers with a
 * Request should pass `request.signal` so a disconnected client does not keep
 * a 60s registry spawn running. */
export async function runIsolatedUtilityCommand<T = unknown>(
  command: { type: string; [key: string]: unknown },
  options: { env?: Record<string, string>; cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const proc = new RpcProcess({
    cwd: options.cwd ?? homedir(),
    extraArgs: UTILITY_EXTRA_ARGS,
    env: options.env,
  });
  const signal = options.signal;
  const onAbort = () => { void proc.dispose(); };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const ready = await proc.waitReady(READY_TIMEOUT_MS);
    await proc.negotiateProtocol(ready);
    return await proc.sendCommand<T>(command, options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
  } catch (error) {
    if (signal?.aborted) {
      throw new Error("Request aborted");
    }
    throw error;
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    // Await the child's exit (not fire-and-forget): callers like the
    // models-config test remove their throwaway temp dir right after this
    // resolves, and on Windows a still-exiting child holding handles on that
    // dir makes rmSync fail (EBUSY, only suppressed by force: true).
    await proc.dispose();
  }
}
