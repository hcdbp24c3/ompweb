import { existsSync } from "fs";

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

export interface TerminalHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** Everything printed since the shell started, for a client that reattaches. */
  replay(): string;
  /** Subscribe to live output. Returns an unsubscribe function. */
  addListener(listener: (chunk: string) => void): () => void;
}

export interface RegistryLimits {
  idleMs: number;
  maxTerminals: number;
  scrollbackLines: number;
}

export interface PtyRegistry {
  attach(cwd: string, cols: number, rows: number): TerminalHandle;
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
  scrollbackLines: 2000,
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
  /** Built on first use and kept, so re-attaching to a live shell hands back the
   *  identical handle instead of an equal-looking copy. */
  handle: TerminalHandle | null;
}

export function createPtyRegistry(
  spawn: SpawnPty,
  limits: Partial<RegistryLimits> = {},
): PtyRegistry {
  const { idleMs, maxTerminals, scrollbackLines } = { ...DEFAULT_LIMITS, ...limits };
  const entries = new Map<string, Entry>();

  function clearIdle(entry: Entry) {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  function dispose(cwd: string, kill: boolean) {
    const entry = entries.get(cwd);
    if (!entry) return;
    clearIdle(entry);
    entries.delete(cwd);
    entry.live = false;
    if (kill) {
      try {
        entry.pty.kill();
      } catch {
        // Already gone; nothing to clean up.
      }
    }
  }

  function armIdle(cwd: string, entry: Entry) {
    clearIdle(entry);
    entry.idleTimer = setTimeout(() => dispose(cwd, true), idleMs);
    // Never hold the process open just for an idle shell.
    entry.idleTimer.unref?.();
  }

  function attach(cwd: string, cols: number, rows: number): TerminalHandle {
    const existing = entries.get(cwd);
    if (existing?.live) {
      armIdle(cwd, existing);
      return handleFor(cwd, existing);
    }

    if (entries.size >= maxTerminals) throw new TooManyTerminalsError(maxTerminals);

    const pty = spawn({
      cwd,
      cols,
      rows,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        SHELL: resolveShell(),
        // Clear an inherited CI: the child really is a TTY, and programs that
        // see CI switch off spinners, progress bars and colour — exactly the
        // feedback an interactive shell needs.
        CI: "",
      },
    });

    const entry: Entry = {
      pty,
      scrollback: [],
      idleTimer: null,
      live: true,
      listeners: new Set(),
      handle: null,
    };
    entries.set(cwd, entry);

    pty.onData((data) => {
      entry.scrollback.push(data);
      while (entry.scrollback.length > scrollbackLines) entry.scrollback.shift();
      for (const listener of entry.listeners) listener(data);
    });
    pty.onExit(() => {
      // The shell ended on its own (`exit`, Ctrl-D): drop the entry so the next
      // attach spawns a fresh one instead of writing into a corpse.
      dispose(cwd, false);
    });

    armIdle(cwd, entry);
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
            dispose(cwd, false);
          }
        },
        resize(cols, rows) {
          if (!entry.live) return;
          try {
            entry.pty.resize(cols, rows);
          } catch {
            dispose(cwd, false);
          }
        },
        kill() {
          dispose(cwd, true);
        },
        replay() {
          return entry.scrollback.join("");
        },
        addListener(listener) {
          entry.listeners.add(listener);
          return () => { entry.listeners.delete(listener); };
        },
      };
    }
    return entry.handle;
  }

  return {
    attach,
    detach(cwd) {
      // Do not kill: a tab switch is not an intent to end the shell. Idle reaping
      // decides that.
      const entry = entries.get(cwd);
      if (entry) armIdle(cwd, entry);
    },
    disposeAll() {
      for (const cwd of [...entries.keys()]) dispose(cwd, true);
    },
    count: () => entries.size,
    activeCwds: () => [...entries.keys()],
  };
}

declare global {
  var __ompWebTerminalRegistry: PtyRegistry | undefined;
}

/**
 * Bridges the async default spawner into the synchronous SpawnPty shape.
 *
 * node-pty can only be imported dynamically, so the real process does not exist
 * on the first synchronous tick. Writes that arrive in that window are queued
 * and flushed once it does — a keystroke typed the instant the panel opens must
 * not be dropped.
 */
function asyncSpawnerBridge(): SpawnPty {
  return (opts) => {
    const queue: string[] = [];
    const dataCbs: ((chunk: string) => void)[] = [];
    const exitCbs: ((code: number) => void)[] = [];
    let pty: PtyLike | null = null;
    let exited = false;

    void defaultPtySpawner(opts).then((real) => {
      pty = real;
      real.onData((data) => { for (const cb of dataCbs) cb(data); });
      real.onExit((code) => {
        exited = true;
        for (const cb of exitCbs) cb(code);
      });
      for (const data of queue.splice(0)) real.write(data);
    });

    return {
      write(data) {
        if (pty) pty.write(data);
        else if (!exited) queue.push(data);
      },
      resize(cols, rows) {
        pty?.resize(cols, rows);
      },
      kill() {
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
    globalThis.__ompWebTerminalRegistry = createPtyRegistry(
      spawn ?? injectedSpawner ?? asyncSpawnerBridge(),
    );
  }
  return globalThis.__ompWebTerminalRegistry;
}