import { existsSync } from "fs";
import { sanitizeProjectCommandEnvironment } from "../project-command-env";

/**
 * Lifecycle owner for terminal PTY processes.
 *
 * Deliberately free of React and Next imports: the three routes and the tests
 * all drive it, and a route module may not be imported by a unit test.
 *
 * node-pty is imported lazily and only inside defaultPtySpawner, so importing
 * this module on a machine without the native build (a test runner, `tsc`) does
 * not throw. setPtySpawner() replaces it in tests.
 */

/** The slice of a node-pty IPty this module uses. Lets tests inject a fake. */
export interface PtyLike {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number) => void): void;
}

export interface SpawnOptions {
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}

export type SpawnPty = (opts: SpawnOptions) => PtyLike;

/** The shape of the real spawner. Kept separate from SpawnPty because node-pty
 *  can only be imported dynamically, so the real one cannot be synchronous. */
export type AsyncSpawnPty = (opts: SpawnOptions) => Promise<PtyLike>;

export interface TerminalHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** Everything printed since the shell started, for a client that reattaches. */
  replay(): string;
  /** Subscribe to live output. Returns an unsubscribe function. */
  addListener(listener: (chunk: string) => void): () => void;
  /**
   * Subscribe to "this shell is gone", so a client can close its stream instead
   * of showing a frozen terminal whose keystrokes are silently dropped.
   * Subscribe while the shell is alive: a shell that has already been retired
   * will not call back. Returns an unsubscribe function.
   */
  onExit(cb: () => void): () => void;
}

export interface RegistryLimits {
  idleMs: number;
  maxTerminals: number;
  /** Retained onData *chunks*, not lines: node-pty's chunking is not line
   *  aligned, and replay() must reproduce the shell's byte stream exactly, so
   *  cutting at real line boundaries would need a partial-line buffer that can
   *  only approximate the cut. The xterm.js client holds its own visual
   *  scrollback; this ring only has to be a bounded tail. */
  scrollbackChunks: number;
}

/** What a caller may add to the shell's environment beyond what this module
 *  builds. It exists for the repository's resolved gh token
 *  (lib/gh-env.ts): attach() is synchronous, so the caller resolves the token
 *  for its cwd first and hands the result in — the registry never reads the
 *  credential store itself.
 *
 *  The merge happens INSIDE the sanitize call rather than on a finished env, so
 *  an override cannot put back a host variable sanitize removes. */
export interface AttachOptions {
  env?: Record<string, string>;
}

export interface PtyRegistry {
  attach(cwd: string, cols: number, rows: number, options?: AttachOptions): TerminalHandle;
  detach(cwd: string): void;
  disposeAll(): void;
  count(): number;
  activeCwds(): string[];
}

export class TooManyTerminalsError extends Error {
  constructor(limit: number) {
    super(`too many terminals open (limit ${limit})`);
    this.name = "TooManyTerminalsError";
  }
}

const DEFAULT_LIMITS: RegistryLimits = {
  // Matches IDLE_KILL_MS in lib/omp/rpc-utility.ts so shells and the utility
  // process do not have visibly different lifetimes.
  idleMs: 300_000,
  maxTerminals: 4,
  scrollbackChunks: 2000,
};

/** Login shells that exist on both Linux and macOS hosts. */
const SHELL_CANDIDATES = [
  "/bin/bash",
  "/usr/bin/bash",
  "/bin/sh",
  "/usr/bin/sh",
];

function resolveShell(): string {
  const fromEnv = process.env.SHELL;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const candidate of SHELL_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  // Practically unreachable — POSIX guarantees /bin/sh — but a concrete path is
  // still better than the empty file name node-pty would reject.
  return "/bin/sh";
}

export async function defaultPtySpawner(opts: SpawnOptions): Promise<PtyLike> {
  const { spawn } = await import("node-pty");
  const pty = spawn(resolveShell(), [], {
    name: "xterm-256color",
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: opts.env,
  });
  return pty as unknown as PtyLike;
}

interface Entry {
  pty: PtyLike;
  scrollback: string[];
  idleTimer: NodeJS.Timeout | null;
  live: boolean;
  /** Live-output subscribers. Several browser tabs may watch one shell without
   *  each spawning one. */
  listeners: Set<(chunk: string) => void>;
  /** Clients that must be told when the shell goes away. */
  exitSubscribers: Set<() => void>;
  /** Built on first use and kept, so re-attaching to a live shell hands back the
   *  identical handle instead of an equal-looking copy. */
  handle: TerminalHandle | null;
}

export function createPtyRegistry(
  spawn: SpawnPty,
  limits: Partial<RegistryLimits> = {},
): PtyRegistry {
  const { idleMs, maxTerminals, scrollbackChunks } = { ...DEFAULT_LIMITS, ...limits };
  const entries = new Map<string, Entry>();

  function clearIdle(entry: Entry) {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  /**
   * Retires `entry`, killing its shell only when asked.
   *
   * Identity-aware on purpose: a handle outlives the shell it was minted for, and
   * a shell's onExit can fire after its replacement has already taken the cwd.
   * Keying disposal on the cwd alone would let a stale handle kill — or a dead
   * shell's late exit evict — the replacement the user never asked to lose.
   */
  function dispose(cwd: string, entry: Entry, kill: boolean) {
    clearIdle(entry);
    const wasLive = entry.live;
    if (entries.get(cwd) === entry) entries.delete(cwd);
    entry.live = false;
    if (kill) {
      try {
        entry.pty.kill();
      } catch {
        // Already gone; nothing to clean up.
      }
    }
    if (!wasLive) return;
    // A shell that disappears under a watching client has to say so. Silence
    // leaves a frozen terminal on screen whose every later keystroke is dropped
    // by the liveness check on the handle, with nothing to explain why. Firing
    // per subscriber keeps one broken listener from stranding the others.
    const subscribers = [...entry.exitSubscribers];
    entry.exitSubscribers.clear();
    for (const notify of subscribers) {
      try {
        notify();
      } catch {
        // Nothing to clean up.
      }
    }
  }

  /**
   * Re-arms the reap timer, but only while nobody is reading.
   *
   * "Idle" has to mean unwatched, not quiet. A shell somebody is typing into in
   * vim prints nothing for minutes at a time, and reaping it would discard their
   * buffer mid-edit while the browser still shows a live terminal. The clock
   * therefore restarts every time the last listener leaves, not on a timer that
   * attach arms once and nothing else ever touches.
   */
  function syncIdle(cwd: string, entry: Entry) {
    clearIdle(entry);
    if (!entry.live || entry.listeners.size > 0) return;
    entry.idleTimer = setTimeout(() => dispose(cwd, entry, true), idleMs);
    // Never hold the process open just for an idle shell.
    entry.idleTimer.unref?.();
  }

  function attach(cwd: string, cols: number, rows: number, options: AttachOptions = {}): TerminalHandle {
    const existing = entries.get(cwd);
    if (existing?.live) {
      syncIdle(cwd, existing);
      return handleFor(cwd, existing);
    }
    // `!existing?.live` is defence, not a live path: dispose() clears `live` and
    // deletes the map entry together, so a stored entry is always live. Were that
    // ever untrue, the spawn below replaces it rather than writing into a corpse.

    if (entries.size >= maxTerminals) throw new TooManyTerminalsError(maxTerminals);

    // Drop the host's own runtime variables (PORT, NODE_ENV, NEXT_*) so the
    // shell does not behave as if it were running inside the web app, then the
    // guard password: OMP_WEB_PASSWORD is what protects this very terminal, and
    // a shell that can echo it hands the guard to anyone who gets a keystroke
    // through. sanitizeProjectCommandEnvironment knows nothing about it, so it is
    // removed here rather than widened there.
    //
    // The caller's override is merged here, not applied afterwards, so it goes
    // through the same sanitize: a resolved gh token arrives exactly like every
    // other inherited variable, and nothing can smuggle a host secret back in
    // through the new parameter.
    const env = sanitizeProjectCommandEnvironment({
      ...process.env,
      TERM: "xterm-256color",
      SHELL: resolveShell(),
      // Clear an inherited CI: the child really is a TTY, and programs that
      // see CI switch off spinners, progress bars and colour — exactly the
      // feedback an interactive shell needs.
      CI: "",
      ...options.env,
    });
    delete env.OMP_WEB_PASSWORD;

    const pty = spawn({ cwd, cols, rows, env });

    const entry: Entry = {
      pty,
      scrollback: [],
      idleTimer: null,
      live: true,
      listeners: new Set(),
      exitSubscribers: new Set(),
      handle: null,
    };
    entries.set(cwd, entry);

    pty.onData((data) => {
      entry.scrollback.push(data);
      while (entry.scrollback.length > scrollbackChunks) entry.scrollback.shift();
      for (const listener of entry.listeners) listener(data);
    });
    pty.onExit(() => {
      // The shell ended on its own (`exit`, Ctrl-D): drop the entry so the next
      // attach spawns a fresh one instead of writing into a corpse.
      dispose(cwd, entry, false);
    });

    syncIdle(cwd, entry);
    return handleFor(cwd, entry);
  }

  function handleFor(cwd: string, entry: Entry): TerminalHandle {
    if (!entry.handle) {
      entry.handle = {
        write(data) {
          if (!entry.live) return;
          try {
            entry.pty.write(data);
          } catch {
            // The shell died between the liveness check and the write.
            dispose(cwd, entry, false);
          }
        },
        resize(cols, rows) {
          if (!entry.live) return;
          try {
            entry.pty.resize(cols, rows);
          } catch {
            dispose(cwd, entry, false);
          }
        },
        kill() {
          dispose(cwd, entry, true);
        },
        replay() {
          return entry.scrollback.join("");
        },
        addListener(listener) {
          entry.listeners.add(listener);
          syncIdle(cwd, entry);
          return () => {
            entry.listeners.delete(listener);
            syncIdle(cwd, entry);
          };
        },
        onExit(cb) {
          entry.exitSubscribers.add(cb);
          return () => { entry.exitSubscribers.delete(cb); };
        },
      };
    }
    return entry.handle;
  }

  return {
    attach,
    detach(cwd) {
      // Do not kill: a tab switch is not an intent to end the shell. Reaping
      // decides that, and only once nobody is reading.
      const entry = entries.get(cwd);
      if (entry) syncIdle(cwd, entry);
    },
    disposeAll() {
      for (const [cwd, entry] of [...entries]) dispose(cwd, entry, true);
    },
    count: () => entries.size,
    activeCwds: () => [...entries.keys()],
  };
}

declare global {
  var __ompWebTerminalRegistry: PtyRegistry | undefined;
}

/**
 * Bridges the async real spawner into the synchronous SpawnPty shape.
 *
 * node-pty can only be imported dynamically, so the real process does not exist
 * on the first synchronous tick. Two things must survive that window, and both
 * are easy to drop because the handle exists before the process does:
 *
 *  - a keystroke typed the instant the panel opens (queued and flushed on arrival),
 *  - a kill issued in the same window (remembered, and applied on arrival — an
 *    unreaped kill here leaves a shell nobody holds a reference to, alive until
 *    the container restarts).
 *
 * The spawner is a parameter so a test can drive the window without the native
 * build; production passes nothing and gets defaultPtySpawner.
 */
export function asyncSpawnerBridge(spawnReal: AsyncSpawnPty = defaultPtySpawner): SpawnPty {
  return (opts) => {
    const queue: string[] = [];
    const dataCbs: ((chunk: string) => void)[] = [];
    const exitCbs: ((code: number) => void)[] = [];
    let pty: PtyLike | null = null;
    let exited = false;
    let killRequested = false;

    const finish = (code: number) => {
      exited = true;
      for (const cb of exitCbs) cb(code);
    };

    void spawnReal(opts).then(
      (real) => {
        pty = real;
        real.onData((data) => { for (const cb of dataCbs) cb(data); });
        real.onExit(finish);
        if (killRequested) {
          real.kill();
        } else {
          for (const data of queue.splice(0)) real.write(data);
        }
      },
      () => {
        // A spawn that cannot happen (missing native build, bad cwd) must look
        // like a shell that exited, so the registry drops the entry the same way.
        // Letting the rejection go unhandled would be worse: Node >=15 exits the
        // process on it, losing every other session over one broken terminal.
        finish(1);
      },
    );

    return {
      write(data) {
        if (pty) pty.write(data);
        else if (!exited) queue.push(data);
      },
      resize(cols, rows) {
        pty?.resize(cols, rows);
      },
      kill() {
        // A shell that already exited has no process left to signal, and
        // killRequested is only read when the spawn resolves — which it has.
        if (exited) return;
        killRequested = true;
        pty?.kill();
      },
      onData(cb) {
        dataCbs.push(cb);
      },
      onExit(cb) {
        exitCbs.push(cb);
      },
    };
  };
}

let injectedSpawner: SpawnPty | null = null;

/** Replaces the default spawner. Tests use this to avoid a real PTY. */
export function setPtySpawner(next: SpawnPty): void {
  injectedSpawner = next;
}

/**
 * The process-wide registry, on `globalThis` for the same reason
 * lib/rpc-manager.ts keeps its sessions there: a module-level Map is emptied by
 * a dev hot-reload, which would orphan every running shell.
 *
 * The spawner is fixed on first creation. Callers that need a different one pass
 * it here before anything else has asked for the registry.
 */
export function getSharedPtyRegistry(spawn?: SpawnPty): PtyRegistry {
  if (!globalThis.__ompWebTerminalRegistry) {
    const registry = createPtyRegistry(spawn ?? injectedSpawner ?? asyncSpawnerBridge());
    globalThis.__ompWebTerminalRegistry = registry;
    // Mirror the session registry in lib/rpc-manager.ts and the utility process in
    // lib/omp/rpc-utility.ts: kill every shell on shutdown so none outlives the
    // server. Without this a shell depends on the kernel SIGHUP-ing the
    // foreground group when the pty master closes, which is half the orphan
    // problem the globalThis slot above exists to prevent.
    const cleanup = () => registry.disposeAll();
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__ompWebTerminalRegistry;
}
