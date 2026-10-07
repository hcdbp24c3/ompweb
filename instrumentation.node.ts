import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "fs";
import { join } from "path";
import { getConfigRoot } from "@/lib/omp/paths";

export async function register(): Promise<void> {
  // Honor HTTP(S)_PROXY/NO_PROXY for server-side fetch (update checks, skill
  // search, model connection tests). Node's built-in fetch ignores proxy env
  // vars (NODE_USE_ENV_PROXY is Node 24+ only; engines floor is 22).
  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  // Startup diagnostics: agent dir. Kept to one line so it greps cleanly;
  // failures here must never block boot.
  try {
    const { getAgentDir } = await import("@/lib/session-reader");
    console.log(
      `[omp-web] starting (agent-dir ${getAgentDir()})`,
    );
    warnIfSessionsLookLost(getAgentDir());
  } catch {
    // Diagnostics are best-effort.
  }

  // Warm the shared utility omp process so the first models/auth request does
  // not pay the multi-second cold spawn (measured 1.2-4s on a real install).
  // Fire-and-forget: register() must not block boot, and a missing omp binary
  // is reported per-request by the routes — log once here and move on.
  // The shared process registers its own SIGINT/SIGTERM/exit disposal hook on
  // first use (lib/omp/rpc-utility.ts), as the session registry does.
  void (async () => {
    try {
      const { runUtilityCommand } = await import("@/lib/omp/rpc-utility");
      await runUtilityCommand({ type: "get_state" });
      const { getOmpVersion } = await import("@/lib/omp/omp-cli");
      const version = await getOmpVersion();
      console.log(`[omp-web] omp utility ready (${version ?? "version unknown"})`);
    } catch (error) {
      const { resolveOmpBin } = await import("@/lib/omp/omp-cli");
      const bin = resolveOmpBin();
      const detail = error instanceof Error ? error.message : String(error);
      const hint = bin
        ? `resolved ${bin}; repair with: omp update (or: bun install -g @oh-my-pi/pi-coding-agent@latest)`
        : "omp binary not found; install oh-my-pi or set OMP_WEB_OMP_BIN";
      console.warn(`[omp-web] omp utility warm-up failed (routes will retry on demand): ${detail} — ${hint}`);
    }
  })();

  // Opt-in omp runtime updater. Started here, not from the browser, so it runs
  // whether or not a client is connected — a page timer would make "auto
  // update" mean "updates when the tab happens to be open". Fire-and-forget,
  // and gated on the setting so the default boot path is unchanged.
  void (async () => {
    try {
      const { loadWebServerSettings } = await import("@/lib/web-settings");
      if (!loadWebServerSettings().autoUpdateOmp) return;
      const { startOmpAutoUpdate } = await import("@/lib/omp/auto-update");
      const started = startOmpAutoUpdate();
      if (started.started) console.log("[omp-web] omp auto-update enabled");
    } catch (error) {
      console.warn(`[omp-web] omp auto-update could not start: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();

  // Resume sessions that were mid-run when omp-web last stopped (opt-in
  // setting). Fire-and-forget: resuming must not block boot.
  void (async () => {
    try {
      const { resumeInterruptedSessions } = await import("@/lib/rpc-manager");
      await resumeInterruptedSessions();
    } catch (error) {
      console.warn(`[omp-web] session auto-resume failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();

  // Crash/stall journal: a long-running server that dies or wedges while the
  // user is away leaves no trace in a terminal that no longer exists (CLI runs
  // are killed with their terminal; pages then show endless loading until the
  // process is restarted). Append fatal errors and event-loop stalls to a file
  // so the next incident explains itself. Node's default crash semantics are
  // preserved — this only adds the record before exiting.
  const logDir = join(getConfigRoot(), "omp-web");
  const logPath = join(logDir, "diagnostics.log");
  const appendDiag = (kind: string, detail: string) => {
    try {
      mkdirSync(logDir, { recursive: true });
      try {
        if (statSync(logPath).size > 1_000_000) renameSync(logPath, `${logPath}.old`);
      } catch { /* first write or unreadable — append anyway */ }
      appendFileSync(logPath, `${new Date().toISOString()} [${kind}] ${detail}\n`, { encoding: "utf8" });
    } catch { /* diagnostics must never crash the server */ }
  };
  const describe = (value: unknown) => (value instanceof Error ? `${value.name}: ${value.message}\n${value.stack ?? ""}` : String(value));
  process.on("uncaughtException", (error) => {
    appendDiag("crash", `uncaughtException ${describe(error)}`);
    // An uncaughtException listener suppresses Node's default exit; keep the
    // crash-visible semantics by exiting explicitly.
    process.exit(2);
  });
  process.on("unhandledRejection", (reason) => {
    appendDiag("crash", `unhandledRejection ${describe(reason)}`);
    // Same as above: preserve Node's crash-on-unhandled-rejection default.
    process.exit(2);
  });
  let lastTick = Date.now();
  let lastCpu = process.cpuUsage();
  const watchdog = setInterval(() => {
    const now = Date.now();
    const cpu = process.cpuUsage();
    const drift = now - lastTick;
    const cpuMs = (cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000;
    lastTick = now;
    lastCpu = cpu;
    if (drift > 45_000) {
      // Wall-clock drift alone cannot tell a blocked loop from a sleeping
      // machine: an hour with the lid closed looks like an hour-long stall
      // but burns no CPU. Label accordingly so the journal does not mislead the
      // next long-idle investigation.
      const seconds = Math.round(drift / 1000);
      if (cpuMs < Math.min(5_000, drift / 2)) {
        appendDiag("sleep", `event loop gap of ~${seconds}s with negligible CPU time — machine was asleep/suspended or CPU-starved, not a synchronous block`);
      } else {
        appendDiag("stall", `event loop unresponsive for ~${seconds}s — a synchronous operation is blocking every request`);
      }
    }
  }, 15_000);
  watchdog.unref?.();
}

/**
 * A fresh install and a lost volume mount look identical from inside: an
 * agent dir with no sessions. What makes them distinguishable is the mount
 * table — a `VOLUME /root/.omp` in the image plus a volume mounted at `/root`
 * leaves `/root/.omp` as its own anonymous volume on top of the real one, so
 * `omp update` (which recreates the container) silently mounts an empty
 * directory over the host's. Repositories under `/root` survive; every
 * session, credential and models.yml vanishes, with no error anywhere.
 *
 * That is silent data loss, so say it at boot rather than letting the user
 * discover it by finding an empty session list.
 */
function warnIfSessionsLookLost(agentDir: string): void {
  const sessionsDir = join(agentDir, "sessions");
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return; // No sessions dir at all is a brand-new install; nothing to say.
  }
  if (entries.some((name) => name.endsWith(".jsonl") || !name.startsWith("."))) return;

  // A volume mounted on the agent dir is the expected, correct setup — it just
  // has no sessions yet. The dangerous shape is the agent dir sitting INSIDE a
  // different mount, which is what an anonymous volume over /root/.omp looks
  // like from inside the container.
  let mounts: string;
  try {
    mounts = readFileSync("/proc/mounts", "utf8");
  } catch {
    return; // Not Linux; /proc/mounts is the only portable-enough source here.
  }
  const mounted = mounts
    .split("\n")
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts.length > 2)
    .some(([, point]) => point === agentDir);
  if (!mounted) return;

  console.warn(
    [
      "",
      `[omp-web] WARNING: ${agentDir} is a mount point and contains no sessions.`,
      "  This is what a lost volume mount looks like from inside the container:",
      "  a repository under /root surviving while every session disappears means",
      "  /root/.omp was replaced by a fresh empty volume on the last recreate.",
      "  If you expected sessions here, stop the container and check the host's",
      "  /root/.omp before starting it again, then mount that path explicitly",
      "  (volumes: [\"./omp-data:/root/.omp\"]). See the note in the Dockerfile.",
      "",
    ].join("\n"),
  );
}
