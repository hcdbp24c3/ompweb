import { checkOmpUpdate } from "./updates";
import { isUpdateDisabled } from "../update-policy";
import { prepareSelfUpdate, commitSelfUpdate, getSelfUpdateStatus } from "../self-update";

/**
 * Opt-in background updater for the omp runtime.
 *
 * Deliberately server-side rather than browser-driven: a browser timer only
 * runs while somebody is looking at the page, which would make "auto update"
 * mean "updates when someone happens to have the tab open". The server already
 * owns `register()` in `instrumentation.node.ts`, so that is where the loop
 * lives and it runs whether or not a client is connected.
 *
 * It does not update anything on its own: it reuses the same
 * `prepare -> commit` flow `app/api/omp-update` exposes, so an auto update is
 * the same audited operation as a manual one — same lease, same worker, same
 * status file a browser can read.
 */

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface OmpAutoUpdateState {
  /** True once a tick has finished a full cycle without an unhandled failure. */
  checkedAt: string | null;
  lastResult: string | null;
  lastError: string | null;
  /** Why the loop is not running, when it is not. */
  stoppedReason: string | null;
}

declare global {
  // Survives hot reload. A module-level timer would be replaced on every
  // recompile and leave the old one running, so every few minutes the server
  // would gain another updater — the same reason `rpc-manager` and the pty
  // registry keep their state on globalThis.
  var __ompWebAutoUpdate:
    | { started: boolean; timer: ReturnType<typeof setInterval> | null; state: OmpAutoUpdateState }
    | undefined;
}

function slot(): NonNullable<typeof globalThis.__ompWebAutoUpdate> {
  globalThis.__ompWebAutoUpdate ??= {
    started: false,
    timer: null,
    state: { checkedAt: null, lastResult: null, lastError: null, stoppedReason: null },
  };
  return globalThis.__ompWebAutoUpdate;
}

export function getOmpAutoUpdateState(): OmpAutoUpdateState {
  return { ...slot().state };
}

/**
 * One cycle. Exported so it can be exercised without a timer, and so the first
 * check at boot can be awaited rather than racing the interval.
 *
 * Returns what it did rather than throwing on a failed update: an unreachable
 * registry must not take the server down, and a failed update leaves the
 * existing binary in place, which is the whole point of the staged worker.
 */
export async function runOmpAutoUpdateOnce(): Promise<{ updated: boolean; reason: string }> {
  const state = slot().state;
  if (isUpdateDisabled()) {
    state.stoppedReason = "disabled_by_env";
    return { updated: false, reason: "disabled_by_env" };
  }
  try {
    const status = await checkOmpUpdate(true);
    state.checkedAt = new Date().toISOString();
    state.lastError = null;
    if (!status.updateAvailable) {
      state.lastResult = `up to date (${status.currentVersion ?? "unknown"})`;
      return { updated: false, reason: "up_to_date" };
    }
    const target = status.availableVersion ?? "unknown";
    // An attempt already in flight means a manual update, or an earlier tick,
    // owns the lease. Standing aside is correct: two updaters racing for one
    // lease is the failure the lease exists to prevent.
    if (getSelfUpdateStatus("omp")) {
      state.lastResult = `update available (${target}); an attempt is already in flight`;
      return { updated: false, reason: "update_in_progress" };
    }
    // The SAME flow `/api/omp-update` drives, so an automatic update is the same
    // audited operation a manual one is: same lease, same copied worker, same
    // status file, same stopping/installing/restarting stages.
    const { attemptId } = await prepareSelfUpdate("omp");
    commitSelfUpdate(attemptId, "omp");
    state.lastResult = `updating to ${target} (attempt ${attemptId})`;
    return { updated: true, reason: "update_started" };
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    return { updated: false, reason: "check_failed" };
  }
}

/**
 * Start the loop. Idempotent, and safe to call from `register()` on every boot.
 */
export function startOmpAutoUpdate(intervalMs = DEFAULT_INTERVAL_MS): { started: boolean; reason: string } {
  const state = slot();
  if (state.started) return { started: true, reason: "already_running" };
  if (isUpdateDisabled()) {
    state.state.stoppedReason = "disabled_by_env";
    return { started: false, reason: "disabled_by_env" };
  }
  state.started = true;
  state.state.stoppedReason = null;
  state.timer = setInterval(() => {
    void runOmpAutoUpdateOnce().catch(() => {
      // runOmpAutoUpdateOnce already records its own failure; this is the last
      // line so a timer callback can never take the process down.
    });
  }, intervalMs);
  // Never hold the event loop open on shutdown.
  state.timer.unref?.();
  return { started: true, reason: "started" };
}

export function stopOmpAutoUpdate(): void {
  const state = slot();
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.started = false;
}
