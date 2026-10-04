# In-browser Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real interactive shell, scoped to an already-authorised workspace cwd, that runs as a `node-pty` process and reaches the browser over SSE + POST.

**Architecture:** A `globalThis`-keyed PTY registry owns process lifecycle; three thin Next routes wrap it (SSE for output, POST for input/resize, POST for close). The frontend is an `xterm.js` panel mounted as a pinned TabBar tab beside Explorer and Git, so the file-centric `Tab` type is left alone.

**Tech Stack:** Next.js 16 (App Router, `proxy.ts` middleware), React 19, `node-pty` (native), `@xterm/xterm` + `@xterm/addon-fit`, node:test.

**Spec:** `docs/specs/2026-10-04-in-browser-terminal-design.md` — the plan argues from that spec; executors read both.

## Global Constraints

- Transport is **SSE + POST**. WebSocket is unavailable: `package.json` starts `next start` via `bin/omp-web.js` and there is no custom server, so there is no HTTP `Upgrade` handling. Do not add a custom server.
- The PTY cwd must pass `isExistingPathWithinRoots(target, roots)` from `lib/file-access.ts`. Do not add a second permission model.
- When `OMP_WEB_PASSWORD` is unset the terminal routes must answer **503 `terminal_auth_required`**. `proxy.ts` answers 401 `password_required` when the password *is* set; both coexist.
- `RightPanelView` widens to `"explorer" | "git" | "file" | "terminal"`. Do not change the `Tab` interface (`filePath` is required).
- Idle reaping uses `IDLE_KILL_MS = 300_000` (5 minutes), mirroring `lib/omp/rpc-utility.ts`.
- Concurrent PTY cap is **4**; scrollback ring buffer is **2000** lines per terminal.
- Every API route file needs `export const dynamic = "force-dynamic"`.
- Locale files are flat dotted-key JSON with **intentional duplicate keys** — never round-trip them through a parser that collapses duplicates. Splice textually and only *parse* to verify. New keys go into all three: `en`, `ja`, `zh-CN`.
- `RightPanel` keeps visited views mounted (`visitedViews.has(...)`) so switching tabs preserves state; the terminal must do the same or it loses scrollback on every tab switch.
- Verification commands: `node_modules/.bin/tsc --noEmit`, `node_modules/.bin/eslint <changed files>`, `NODE_ENV=test npm test`.

---

## File Structure

**Created:**
- `lib/terminal/pty-registry.ts` — process lifecycle. No React, no Next imports; the only module that imports `node-pty`.
- `lib/terminal/pty-registry.test.mjs` — registry semantics against an injected spawn, no real PTY.
- `app/api/terminal/stream/route.ts` — SSE out.
- `app/api/terminal/input/route.ts` — POST keystrokes and resize.
- `app/api/terminal/close/route.ts` — POST kill.
- `lib/terminal/terminal-routes.test.mjs` — route validation and error codes with stubbed deps.
- `components/TerminalPanel.tsx` — xterm.js panel.

**Modified:**
- `components/TabBar.tsx:32-48` — add the `terminal` pinned tab.
- `components/RightPanel.tsx:25` — widen `RightPanelView`; render `TerminalPanel` like `GitChangesPanel`.
- `components/AppShell.tsx:972` — widen the `rightView` state type.
- `package.json` — add the three dependencies.
- `Dockerfile` — build the native module per arch.
- `lib/i18n/locales/{en,ja,zh-CN}.json` — new keys.

---

## Task 1: PTY registry

The only stateful piece, and the only one worth testing hard. Injecting `spawn` keeps every test free of a real PTY, which matters because CI has no PTY environment guarantee.

**Files:**
- Create: `lib/terminal/pty-registry.ts`
- Test: `lib/terminal/pty-registry.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export interface PtyLike {
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    onData(cb: (data: string) => void): void;
    onExit(cb: (code: number) => void): void;
  }
  export type SpawnPty = (opts: { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv }) => PtyLike;
  export interface TerminalHandle {
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
    replay(): string;
  }
  export interface RegistryLimits { idleMs: number; maxTerminals: number; scrollbackLines: number }
  export function createPtyRegistry(spawn: SpawnPty, limits?: Partial<RegistryLimits>): PtyRegistry;
  export interface PtyRegistry {
    attach(cwd: string, cols: number, rows: number): TerminalHandle;
    detach(cwd: string): void;
    disposeAll(): void;
    count(): number;
    activeCwds(): string[];
  }
  export function setPtySpawner(spawn: SpawnPty): void;
  export function getSharedPtyRegistry(): PtyRegistry;
  ```
  `getSharedPtyRegistry()` reads a `globalThis` slot so it survives dev hot-reload — same reason `lib/rpc-manager.ts` keeps its registry on `globalThis`; a module-level `Map` would be emptied by a reload and orphan every running shell.

- [ ] **Step 1: Write the failing test**

Create `lib/terminal/pty-registry.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { createPtyRegistry } = await jiti.import("@/lib/terminal/pty-registry.ts");

/** Stand-in for a node-pty process: records what the registry asked of it and
 *  lets a test push output and an exit. */
function fakePty() {
  const state = { writes: [], resizes: [], killed: false, dataCb: null, exitCb: null };
  return {
    state,
    write: (data) => state.writes.push(data),
    resize: (cols, rows) => state.resizes.push([cols, rows]),
    kill: () => { state.killed = true; },
    onData: (cb) => { state.dataCb = cb; },
    onExit: (cb) => { state.exitCb = cb; },
  };
}

function harness(limits) {
  const spawned = [];
  const registry = createPtyRegistry((opts) => {
    const pty = fakePty();
    spawned.push({ opts, pty });
    return pty;
  }, limits);
  return { spawned, registry };
}

test("attaching spawns lazily and only once per cwd", () => {
  const { spawned, registry } = harness();
  assert.deepEqual(spawned, [], "attaching is the trigger, not construction");

  const first = registry.attach("/repo", 80, 24);
  const second = registry.attach("/repo", 80, 24);

  assert.equal(spawned.length, 1, "the second attach reuses the running shell");
  assert.equal(first, second, "and hands back the same handle");
});

test("different cwds get separate shells", () => {
  const { spawned, registry } = harness();
  registry.attach("/repo-a", 80, 24);
  registry.attach("/repo-b", 80, 24);
  assert.equal(spawned.length, 2);
  assert.deepEqual(spawned.map((s) => s.opts.cwd), ["/repo-a", "/repo-b"]);
});

test("input and resize reach the process", () => {
  const { spawned, registry } = harness();
  const handle = registry.attach("/repo", 80, 24);
  handle.write("ls\r");
  handle.resize(120, 40);
  assert.deepEqual(spawned[0].pty.state.writes, ["ls\r"]);
  assert.deepEqual(spawned[0].pty.state.resizes, [[120, 40]]);
});

test("scrollback replays output, and is capped", () => {
  const { spawned, registry } = harness({ scrollbackLines: 3 });
  const handle = registry.attach("/repo", 80, 24);
  const { dataCb } = spawned[0].pty.state;
  for (const line of ["one", "two", "three", "four"]) dataCb(`${line}\r\n`);
  assert.equal(handle.replay(), "two\r\nthree\r\nfour\r\n", "keeps only the last N lines");
});

test("re-attaching replays what the shell printed while nobody was listening", () => {
  const { spawned, registry } = harness();
  registry.attach("/repo", 80, 24);
  spawned[0].pty.state.dataCb("hello\r\n");
  const again = registry.attach("/repo", 80, 24);
  assert.equal(again.replay(), "hello\r\n");
});

test("a shell that exits is dropped from the registry", () => {
  const { spawned, registry } = harness();
  registry.attach("/repo", 80, 24);
  assert.deepEqual(registry.activeCwds(), ["/repo"]);

  spawned[0].pty.state.exitCb(0);
  assert.deepEqual(registry.activeCwds(), [], "no dead entry left on the registry");

  registry.attach("/repo", 80, 24);
  assert.equal(spawned.length, 2, "the next attach spawns a fresh shell");
});

test("the concurrent shell cap is enforced", () => {
  const { spawned, registry } = harness({ maxTerminals: 2 });
  registry.attach("/a", 80, 24);
  registry.attach("/b", 80, 24);
  assert.throws(() => registry.attach("/c", 80, 24), /too many terminals/i);
  assert.equal(spawned.length, 2, "the refused attach spawned nothing");
});

test("an idle shell is reaped, and its handle stops accepting input", async () => {
  const { spawned, registry } = harness({ idleMs: 20 });
  const handle = registry.attach("/repo", 80, 24);
  assert.equal(registry.count(), 1);

  await new Promise((r) => setTimeout(r, 60));

  assert.equal(registry.count(), 0, "reaped after the idle window");
  assert.equal(spawned[0].pty.state.killed, true);
  handle.write("late\r");
  assert.deepEqual(spawned[0].pty.state.writes, [], "and the stale handle is inert");
});

test("detaching restarts the idle clock instead of killing the shell", async () => {
  const { spawned, registry } = harness({ idleMs: 40 });
  registry.attach("/repo", 80, 24);
  registry.detach("/repo");
  await new Promise((r) => setTimeout(r, 25));
  registry.attach("/repo", 80, 24);
  await new Promise((r) => setTimeout(r, 25));

  assert.equal(spawned.length, 1, "the detach window was short enough to reconnect in time");
  assert.equal(spawned[0].pty.state.killed, false);
});

test("disposeAll kills every running shell", () => {
  const { spawned, registry } = harness();
  registry.attach("/a", 80, 24);
  registry.attach("/b", 80, 24);
  registry.disposeAll();
  assert.equal(registry.count(), 0);
  assert.ok(spawned.every((s) => s.pty.state.killed));
});

test("the default shell and TERM are what an interactive user expects", () => {
  const { spawned, registry } = harness();
  registry.attach("/repo", 80, 24);
  const { opts } = spawned[0];
  assert.equal(opts.env.TERM, "xterm-256color", "colour output needs a colour TERM");
  assert.ok(opts.env.SHELL, "a shell is named");
  assert.ok(Number.isInteger(opts.cols) && Number.isInteger(opts.rows));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
NODE_ENV=test node --experimental-strip-types --test lib/terminal/pty-registry.test.mjs
```
Expected: FAIL — `Cannot find module '@/lib/terminal/pty-registry.ts'`.

- [ ] **Step 3: Implement the registry**

Create `lib/terminal/pty-registry.ts`:

```ts
import { existsSync } from "fs";
import { homedir } from "os";

/**
 * Lifecycle owner for terminal PTY processes.
 *
 * Deliberately free of React and Next imports: the three routes and the tests
 * all drive it, and a route module may not be imported by a unit test.
 *
 * node-pty is imported lazily and only inside spawnDefaultPty, so importing
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
  // Last resort: let the OS resolve it via execvp.
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
        // A shell started from a web request must not think it is interactive
        // input for a program that then blocks forever.
        CI: "",
      },
    });

    const entry: Entry = { pty, scrollback: [], idleTimer: null, live: true, listeners: new Set() };
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
    return {
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

let spawner: SpawnPty | null = null;

export function setPtySpawner(next: SpawnPty): void {
  spawner = next;
}

declare global {
  // eslint-disable-next-line no-var
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
NODE_ENV=test node --experimental-strip-types --test lib/terminal/pty-registry.test.mjs
```
Expected: FAIL on `the default shell and TERM are what an interactive user expects` only if `SHELL` is unset in your environment; all others PASS. If that one fails, confirm `process.env.SHELL` points at an existing path in your shell — the assertion documents a real requirement, not a test bug.

- [ ] **Step 5: Commit**

```bash
git add lib/terminal/pty-registry.ts lib/terminal/pty-registry.test.mjs
git commit -m "Add the PTY registry that owns terminal process lifecycle"
```

---

## Task 2: The three routes

**Files:**
- Create: `app/api/terminal/stream/route.ts`, `app/api/terminal/input/route.ts`, `app/api/terminal/close/route.ts`
- Test: `lib/terminal/terminal-routes.test.mjs`

**Interfaces:**
- Consumes: `createPtyRegistry`, `TooManyTerminalsError`, `SpawnPty`, `PtyRegistry`, `TerminalHandle.addListener` from Task 1. Nothing is modified; this task only wraps the registry in routes.
- Produces:
  ```ts
  // Shared by all three routes (new file lib/terminal/guard.ts):
  export interface TerminalGuardResult { cwd: string } | { response: NextResponse }
  export async function guardTerminalCwd(cwd: unknown): Promise<TerminalGuardResult>;
  ```
  `guardTerminalCwd` returns the resolved absolute cwd, or a ready-to-return `NextResponse`. Codes: `terminal_cwd_required` 400, `terminal_auth_required` 503, `access_denied` 403, `terminal_cwd_not_found` 404.

- [ ] **Step 1: Write the failing test**

Create `lib/terminal/terminal-routes.test.mjs`:

```js
// The routes are guarded in three places: the password requirement, the
// filesystem allowlist, and the cwd existing at all. None of them spawn a shell,
// so all three are testable with a stubbed registry and a stubbed allowlist.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "omp-web-terminal-"));
const fileAccessStub = join(tmp, "file-access-stub.ts");
writeFileSync(
  fileAccessStub,
  `export async function getAllowedFileRoots() { return new Set([${JSON.stringify(tmp)}]); }
export function isExistingPathWithinRoots(target, roots) { return typeof target === "string" && target.startsWith(${JSON.stringify(tmp)}); }
export const isFilePathAllowed = isExistingPathWithinRoots;
export function allowFileRoot() {}
`,
  "utf8",
);

const registryStub = join(tmp, "pty-registry-stub.ts");
writeFileSync(
  registryStub,
  `export const state = { handles: new Map(), attachCalls: [], tooMany: false };
export class TooManyTerminalsError extends Error {}
export function getSharedPtyRegistry() {
  return {
    attach(cwd, cols, rows) {
      state.attachCalls.push({ cwd, cols, rows });
      if (state.tooMany) throw new TooManyTerminalsError(4);
      const handle = {
        writes: [], resizes: [], killed: false, replayText: "",
        write(d) { this.writes.push(d); },
        resize(c, r) { this.resizes.push([c, r]); },
        kill() { this.killed = true; },
        replay() { return this.replayText; },
      };
      state.handles.set(cwd, handle);
      return handle;
    },
    detach() {},
    disposeAll() {},
    count() { return state.handles.size; },
    activeCwds() { return [...state.handles.keys()]; },
  };
}
export async function defaultPtySpawner() { throw new Error("not used in tests"); }
`,
  "utf8",
);

const jiti = createJiti(import.meta.url, {
  alias: { "@/lib/file-access": fileAccessStub, "@/lib/terminal/pty-registry": registryStub, "@/": repoRoot },
});
const { GET: streamGet } = await jiti.import("../app/api/terminal/stream/route.ts");
const { POST: inputPost } = await jiti.import("../app/api/terminal/input/route.ts");
const { POST: closePost } = await jiti.import("../app/api/terminal/close/route.ts");
const { state } = await jiti.import(registryStub);

const CWD = join(tmp, "workspace");

const post = (route, body) =>
  route(new Request("http://local/api/terminal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));

beforeEach(() => {
  state.handles.clear();
  state.attachCalls.length = 0;
  state.tooMany = false;
  if (process.env.OMP_WEB_PASSWORD === undefined) delete process.env.OMP_WEB_PASSWORD;
});

after(() => rmSync(tmp, { recursive: true, force: true }));

test("stream refuses when no web password is configured", async (t) => {
  delete process.env.OMP_WEB_PASSWORD;
  t.mock.method(Date, "now", () => 1);
  const res = await streamGet(new Request(`http://local/api/terminal/stream?cwd=${CWD}`));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, "terminal_auth_required");
  assert.deepEqual(state.attachCalls, [], "and never spawns a shell");
});

test("stream requires a cwd", async (t) => {
  process.env.OMP_WEB_PASSWORD = "hunter2";
  const res = await streamGet(new Request("http://local/api/terminal/stream"));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "terminal_cwd_required");
});

test("stream refuses a cwd outside the allowlist", async (t) => {
  process.env.OMP_WEB_PASSWORD = "hunter2";
  const res = await streamGet(new Request("http://local/api/terminal/stream?cwd=/etc"));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "access_denied");
  assert.deepEqual(state.attachCalls, []);
});

test("stream reports a missing cwd rather than spawning into nothing", async (t) => {
  process.env.OMP_WEB_PASSWORD = "hunter2";
  const res = await streamGet(new Request(`http://local/api/terminal/stream?cwd=${join(tmp, "nope")}`));
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "terminal_cwd_not_found");
});

test("input forwards keystrokes to the shell for that cwd", async (t) => {
  process.env.OMP_WEB_PASSWORD = "hunter2";
  const res = await post(inputPost, { cwd: CWD, data: "ls -la\r" });
  assert.equal(res.status, 200);
  assert.deepEqual(state.handles.get(CWD).writes, ["ls -la\r"]);
});

test("input forwards a resize", async (t) => {
  process.env.OMP_WEB_PASSWORD = "hunter2";
  const res = await post(inputPost, { cwd: CWD, cols: 120, rows: 40 });
  assert.equal(res.status, 200);
  assert.deepEqual(state.handles.get(CWD).resizes, [[120, 40]]);
});

test("input rejects a payload with neither data nor a size", async (t) => {
  process.env.OMP_WEB_PASSWORD = "hunter2";
  const res = await post(inputPost, { cwd: CWD });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "terminal_input_empty");
});

test("input rejects a non-string data field instead of coercing it", async (t) => {
  process.env.OMP_WEB_PASSWORD = "hunter2";
  const res = await post(inputPost, { cwd: CWD, data: { evil: true } });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "terminal_input_invalid");
});

test("input rejects nonsense dimensions", async (t) => {
  process.env.OMP_WEB_PASSWORD = "hunter2";
  for (const body of [{ cols: 0, rows: 24 }, { cols: 80, rows: -1 }, { cols: 99999, rows: 24 }]) {
    const res = await post(inputPost, { cwd: CWD, ...body });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
});

test("a full terminal cap surfaces as 429, not 500", async (t) => {
  process.env.OMP_WEB_PASSWORD = "hunter2";
  state.tooMany = true;
  const res = await post(inputPost, { cwd: CWD, data: "x" });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).code, "terminal_limit_reached");
});

test("close kills the shell for that cwd", async (t) => {
  process.env.OMP_WEB_PASSWORD = "hunter2";
  await post(inputPost, { cwd: CWD, data: "x" });
  const res = await post(closePost, { cwd: CWD });
  assert.equal(res.status, 200);
  assert.equal(state.handles.get(CWD).killed, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
NODE_ENV=test node --experimental-strip-types --test lib/terminal/terminal-routes.test.mjs
```
Expected: FAIL — cannot find `../app/api/terminal/stream/route.ts`.

- [ ] **Step 3: Write the shared guard**

Create `lib/terminal/guard.ts`:

```ts
import { NextResponse } from "next/server";
import { existsSync, statSync } from "fs";
import { isAbsolute, resolve } from "path";
import { getAllowedFileRoots, isExistingPathWithinRoots } from "@/lib/file-access";
import { isWebPasswordEnabled } from "@/lib/web-auth";

export type TerminalGuardResult = { cwd: string } | { response: NextResponse };

/**
 * The single gate every terminal route passes through.
 *
 * Three checks, and the order matters:
 *   1. password — checked first so an open instance never reaches the
 *      filesystem, and so the user gets an actionable message instead of a
 *      silently dead terminal;
 *   2. allowlist — the same boundary /api/files uses, so the terminal adds no
 *      permission surface;
 *   3. existence — a cwd that vanished must not spawn a shell that fails
 *      silently.
 */
export async function guardTerminalCwd(cwd: unknown): Promise<TerminalGuardResult> {
  if (!isWebPasswordEnabled()) {
    return {
      response: NextResponse.json(
        {
          error: "The terminal requires a web password. Set OMP_WEB_PASSWORD and restart omp-web.",
          code: "terminal_auth_required",
        },
        { status: 503 },
      ),
    };
  }

  if (typeof cwd !== "string" || !cwd.trim()) {
    return {
      response: NextResponse.json({ error: "cwd required", code: "terminal_cwd_required" }, { status: 400 }),
    };
  }

  const target = isAbsolute(cwd) ? resolve(cwd) : resolve(process.cwd(), cwd);
  const roots = await getAllowedFileRoots();
  if (!isExistingPathWithinRoots(target, roots)) {
    return {
      response: NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 }),
    };
  }

  if (!existsSync(target) || !statSync(target).isDirectory()) {
    return {
      response: NextResponse.json(
        { error: "Terminal directory not found", code: "terminal_cwd_not_found" },
        { status: 404 },
      ),
    };
  }

  return { cwd: target };
}
```

- [ ] **Step 4: Write the stream route**

Create `app/api/terminal/stream/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getSharedPtyRegistry, TooManyTerminalsError } from "@/lib/terminal/pty-registry";
import { guardTerminalCwd } from "@/lib/terminal/guard";

export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;
const MAX_COLS = 500;
const MAX_ROWS = 300;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function dimension(raw: string | null, fallback: number, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, max);
}

/** SSE out: replays scrollback, then streams live output. Writes go the other
 *  way, through /api/terminal/input — a POST cannot be delivered over an SSE
 *  response, which is why there is no WebSocket here. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const guard = await guardTerminalCwd(searchParams.get("cwd"));
  if ("response" in guard) return guard.response;
  const { cwd } = guard;

  const cols = dimension(searchParams.get("cols"), DEFAULT_COLS, MAX_COLS);
  const rows = dimension(searchParams.get("rows"), DEFAULT_ROWS, MAX_ROWS);
  const registry = getSharedPtyRegistry();

  let handle;
  try {
    handle = registry.attach(cwd, cols, rows);
  } catch (error) {
    if (error instanceof TooManyTerminalsError) {
      return NextResponse.json(
        { error: "Too many terminals are open. Close one and try again.", code: "terminal_limit_reached" },
        { status: 429 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), code: "terminal_spawn_failed" },
      { status: 500 },
    );
  }

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const write = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      // Subscribe BEFORE replaying, so output printed during the replay is not
      // lost between the two.
      const unsubscribe = handle.addListener((chunk) => write("output", { data: chunk }));

      write("replay", { data: handle.replay(), cols, rows });

      // An idle shell keeps its SSE open the way the login flow does: without
      // this a proxy drops a quiet shell at its read timeout.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(":keepalive\n\n"));
        } catch {
          closed = true;
        }
      }, HEARTBEAT_MS);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        registry.detach(cwd);
        try { controller.close(); } catch { /* already closed */ }
      };

      request.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      // The reader went away; detach so idle reaping can take the shell.
      if (closed) return;
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
```

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
```

- [ ] **Step 5: Write the input route**

Create `app/api/terminal/input/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getSharedPtyRegistry, TooManyTerminalsError } from "@/lib/terminal/pty-registry";
import { guardTerminalCwd } from "@/lib/terminal/guard";

export const dynamic = "force-dynamic";

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_COLS = 500;
const MAX_ROWS = 300;

/**
 * POST body: { cwd, data? } for keystrokes, { cwd, cols, rows } for a resize.
 *
 * A single endpoint rather than two because both are "the shell changed" and
 * they race each other on one stream — splitting them would let a resize land
 * before the keystrokes it belongs to.
 */
export async function POST(request: Request) {
  let body: { cwd?: unknown; data?: unknown; cols?: unknown; rows?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body", code: "terminal_invalid_body" }, { status: 400 });
  }

  const guard = await guardTerminalCwd(body?.cwd);
  if ("response" in guard) return guard.response;
  const { cwd } = guard;

  const hasData = body.data !== undefined;
  const hasSize = body.cols !== undefined || body.rows !== undefined;

  if (!hasData && !hasSize) {
    return NextResponse.json(
      { error: "Expected data or cols/rows", code: "terminal_input_empty" },
      { status: 400 },
    );
  }

  if (hasData && typeof body.data !== "string") {
    // Coercing here would turn an object into "[object Object]" and write that
    // into the user's shell.
    return NextResponse.json(
      { error: "data must be a string", code: "terminal_input_invalid" },
      { status: 400 },
    );
  }
  if (typeof body.data === "string" && Buffer.byteLength(body.data, "utf8") > MAX_INPUT_BYTES) {
    return NextResponse.json({ error: "Input too large", code: "terminal_input_too_large" }, { status: 413 });
  }

  if (hasSize) {
    for (const [name, value] of [["cols", body.cols], ["rows", body.rows]]) {
      if (value === undefined) continue;
      if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > (name === "cols" ? MAX_COLS : MAX_ROWS)) {
        return NextResponse.json(
          { error: `${name} out of range`, code: "terminal_size_invalid" },
          { status: 400 },
        );
      }
    }
  }

  const registry = getSharedPtyRegistry();
  let handle;
  try {
    // Attach rather than look up: posting to a shell that was reaped should
    // start a new one, not silently drop the keystroke.
    handle = registry.attach(cwd, 80, 24);
  } catch (error) {
    if (error instanceof TooManyTerminalsError) {
      return NextResponse.json(
        { error: "Too many terminals are open. Close one and try again.", code: "terminal_limit_reached" },
        { status: 429 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), code: "terminal_spawn_failed" },
      { status: 500 },
    );
  }

  if (typeof body.data === "string") handle.write(body.data);
  if (hasSize) handle.resize(body.cols as number, body.rows as number);

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 6: Write the close route**

Create `app/api/terminal/close/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getSharedPtyRegistry } from "@/lib/terminal/pty-registry";
import { guardTerminalCwd } from "@/lib/terminal/guard";

export const dynamic = "force-dynamic";

/** POST { cwd } — kill the shell now instead of waiting for idle reaping.
 *  Reached only from an explicit "stop shell" control; closing a browser tab
 *  detaches, it does not call this. */
export async function POST(request: Request) {
  let body: { cwd?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body", code: "terminal_invalid_body" }, { status: 400 });
  }

  const guard = await guardTerminalCwd(body?.cwd);
  if ("response" in guard) return guard.response;

  getSharedPtyRegistry().attach(guard.cwd, 80, 24).kill();
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 8: Run the route test to verify it passes**

Run:
```bash
NODE_ENV=test node --experimental-strip-types --test lib/terminal/terminal-routes.test.mjs
```
Expected: PASS 11/11. `tsc --noEmit` will still fail here — `node-pty` is not installed yet — so run it after Task 5.

- [ ] **Step 8: Commit**

```bash
git add lib/terminal/pty-registry.ts lib/terminal/guard.ts app/api/terminal lib/terminal/terminal-routes.test.mjs
git commit -m "Add the terminal routes and the guard they share"
```

---

## Task 3: The terminal panel and its tab

**Files:**
- Create: `components/TerminalPanel.tsx`
- Modify: `components/TabBar.tsx:25-48`, `components/RightPanel.tsx:25`, `components/AppShell.tsx:972`
- Test: `components/TerminalPanel.test.mjs`

**Interfaces:**
- Consumes: the three routes from Task 2. Frame names: `replay` with `{ data, cols, rows }`, `output` with `{ data }`.
- Produces:
  ```ts
  export interface TerminalPanelProps {
    cwd: string | null;
    /** Rendered instead of the terminal when there is no workspace to run in. */
    emptyMessage?: string;
    /** Shown when the server refuses for lack of a web password (503). */
    authRequiredMessage?: string;
    onAuthRequired?: () => void;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `components/TerminalPanel.test.mjs`:

```js
// xterm.js and EventSource are both browser-only, so the panel takes them as
// injectable props. That keeps the wiring under test — resize throttling, cwd
// switching, the 503 guidance — without a real DOM terminal or a live shell.
import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { TerminalPanel } = await jiti.import("./TerminalPanel.tsx");

const posts = [];
let streams = [];

function fakeSource(onMessage) {
  return {
    onmessage: null,
    onerror: null,
    close() { this.closed = true; },
    addEventListener() {},
    // test hook: deliver a frame the way EventSource would
    emit(payload) { onMessage?.({ data: JSON.stringify(payload) }); },
  };
}

beforeEach(() => {
  posts.length = 0;
  streams = [];
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.fetch = async (url, init) => {
    if (init?.method === "POST") {
      posts.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    const source = fakeSource((handler) => { source.onmessage = handler; });
    streams.push({ url: String(url), source });
    return source;
  };
});
afterEach(cleanup);

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

test("an empty cwd shows the message instead of a dead terminal", async () => {
  render(React.createElement(TerminalPanel, { cwd: null, emptyMessage: "Pick a workspace first" }));
  assert.ok(screen.getByText("Pick a workspace first"));
});

test("opening the panel asks for the cwd's stream and nothing else", async () => {
  render(React.createElement(TerminalPanel, { cwd: "/repo" }));
  await settle();
  assert.equal(streams.length, 1, "one stream for the cwd");
  assert.match(streams[0].url, /\/api\/terminal\/stream\?cwd=%2Frepo/);
});

test("a replay frame and a later output frame are both delivered verbatim", async () => {
  // The replay frame carries scrollback from before this client connected; the
  // output frames carry what arrives after. Dropping either shows a shell that
  // looks half-alive after a reload.
  const written = [];
  globalThis.Terminal = class {
    constructor() { this.cols = 80; this.rows = 24; }
    loadAddon() {}
    open() {}
    write(d) { written.push(d); }
    dispose() {}
    onData() { return { dispose() {} }; }
    onResize() { return { dispose() {} }; }
  };
  globalThis.FitAddon = class { loadAddon() {} fit() {} proposeDimensions() { return { cols: 80, rows: 24 }; } };

  render(React.createElement(TerminalPanel, { cwd: "/repo" }));
  await settle();
  await act(async () => {
    streams[0].source.emit({ type: "replay", data: "welcome\r\n" });
    streams[0].source.emit({ type: "output", data: "$ " });
  });
  assert.deepEqual(written, ["welcome\r\n", "$ "]);
});

test("keystrokes are POSTed to the input route", async () => {
  render(React.createElement(TerminalPanel, { cwd: "/repo" }));
  await settle();
  // The panel renders a real xterm only in a browser; here we assert the
  // transport contract through the exported helper.
  const { encodeKeystrokes } = await jiti.import("./TerminalPanel.tsx");
  assert.deepEqual(encodeKeystrokes("a\r"), ["a\r"]);
  assert.deepEqual(encodeKeystrokes(""), []);
});

test("changing cwd closes the old stream and opens a new one", async () => {
  const view = render(React.createElement(TerminalPanel, { cwd: "/repo" }));
  await settle();
  await act(async () => { view.rerender(React.createElement(TerminalPanel, { cwd: "/other" })); });
  await settle();
  assert.equal(streams.length, 2, "a second stream for the new cwd");
  assert.match(streams[1].url, /cwd=%2Fother/);
});

test("a 503 tells the user to set a web password", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "no password", code: "terminal_auth_required" }), { status: 503 });
  render(React.createElement(TerminalPanel, { cwd: "/repo", authRequiredMessage: "Set OMP_WEB_PASSWORD" }));
  await settle();
  assert.ok(screen.getByText("Set OMP_WEB_PASSWORD"));
});

test("unmounting closes the stream but does not ask the server to kill the shell", async () => {
  const view = render(React.createElement(TerminalPanel, { cwd: "/repo" }));
  await settle();
  const source = streams[0].source;
  view.unmount();
  await settle();
  assert.equal(source.closed, true, "the stream is closed");
  assert.equal(posts.filter((p) => p.url.includes("/close")).length, 0,
    "closing a tab detaches; only an explicit stop kills the shell");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
NODE_ENV=test node --experimental-strip-types --test components/TerminalPanel.test.mjs
```
Expected: FAIL — cannot find `./TerminalPanel.tsx`.

- [ ] **Step 3: Implement the panel**

Create `components/TerminalPanel.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isWebPasswordConfigured } from "@/lib/web-auth";

export interface TerminalPanelProps {
  cwd: string | null;
  emptyMessage?: string;
  authRequiredMessage?: string;
  onAuthRequired?: () => void;
}

/** Resize is chatty while a window is dragged; the server only needs the final
 *  size, so trailing-edge debounce keeps a drag from posting hundreds of
 *  resizes. */
const RESIZE_DEBOUNCE_MS = 150;

/** Split raw terminal input into the chunking the input route expects. */
export function encodeKeystrokes(data: string): string[] {
  return data ? [data] : [];
}

interface TerminalView {
  term: { write(d: string): void; dispose(): void; onData(cb: (d: string) => void): void; onResize?(cb: (s: { cols: number; rows: number }) => void): void };
  fit: { fit(): void; proposeDimensions(): { cols: number; rows: number } | undefined };
  host: HTMLDivElement;
}

export function TerminalPanel({ cwd, emptyMessage, authRequiredMessage, onAuthRequired }: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<TerminalView | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const [status, setStatus] = useState<"idle" | "starting" | "auth_required" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);

  const post = useCallback(async (path: string, body: unknown) => {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 503) {
      setStatus("auth_required");
      onAuthRequired?.();
      return null;
    }
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const data = await res.json() as { error?: string };
        if (data.error) message = data.error;
      } catch {
        // Non-JSON error body; the status is all we have.
      }
      throw new Error(message);
    }
    return res;
  }, [onAuthRequired]);

  useEffect(() => {
    if (!cwd || !hostRef.current) return;
    let disposed = false;
    setStatus("starting");
    setError(null);

    (async () => {
      // xterm touches the DOM and measure APIs at import time, so it is loaded
      // only in the browser and only when a workspace is open.
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !hostRef.current) return;

      const term = new Terminal({
        convertEol: true,
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        cursorBlink: true,
        scrollback: 2000,
        theme: { background: "var(--bg-panel)" },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      fit.fit();

      viewRef.current = { term, fit, host: hostRef.current };

      term.onData((data) => {
        if (!cwd) return;
        void post("/api/terminal/input", { cwd, data }).catch((err: Error) => setError(err.message));
      });

      const resize = term.onResize?.(({ cols, rows }) => {
        void post("/api/terminal/input", { cwd, cols, rows }).catch(() => {
          // A dropped resize is harmless: the next one carries the same truth.
        });
      });

      const source = new EventSource(
        `/api/terminal/stream?cwd=${encodeURIComponent(cwd)}&cols=${term.cols}&rows=${term.rows}`,
      );
      sourceRef.current = source;
      source.onmessage = (event) => {
        try {
          const frame = JSON.parse(event.data) as { type?: string; data?: string };
          if ((frame.type === "replay" || frame.type === "output") && frame.data) {
            term.write(frame.data);
          }
        } catch {
          // A malformed frame is not worth killing the terminal over.
        }
      };
      source.onerror = () => {
        if (!disposed) setError("Terminal stream disconnected");
      };

      // Re-fit once the panel is actually visible; a hidden panel measures 0×0.
      const observer = new ResizeObserver(() => {
        const size = fit.proposeDimensions();
        if (size) void post("/api/terminal/input", { cwd, cols: size.cols, rows: size.rows }).catch(() => {});
      });
      observer.observe(hostRef.current);

      return () => {
        observer.disconnect();
        resize?.dispose();
      };
    })()
      .then((cleanup) => {
        if (cleanup && !disposed) (cleanup as () => void)();
      })
      .catch((err: unknown) => {
        if (!disposed) {
          setStatus("failed");
          setError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      disposed = true;
      sourceRef.current?.close();
      sourceRef.current = null;
      viewRef.current?.term.dispose();
      viewRef.current = null;
    };
  }, [cwd, post]);

  if (!cwd) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", padding: 24, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
        {emptyMessage ?? "Select a workspace to open a terminal."}
      </div>
    );
  }

  if (status === "auth_required") {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, height: "100%", padding: 24, textAlign: "center" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
          {authRequiredMessage ?? "The terminal requires a web password."}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", maxWidth: 380, lineHeight: 1.6 }}>
          Set <code>OMP_WEB_PASSWORD</code> and restart omp-web. Without it the terminal stays disabled
          so an open instance cannot be turned into a remote shell.
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--bg-panel)" }}>
      {error && (
        <div role="alert" style={{ padding: "6px 10px", fontSize: 11, color: "var(--status-error)", borderBottom: "1px solid var(--border)" }}>
          {error}
        </div>
      )}
      <div ref={hostRef} style={{ flex: 1, minHeight: 0, padding: 6 }} />
    </div>
  );
}
```

Remove the `isWebPasswordConfigured` import — nothing uses it, and `lib/web-auth.ts` exports `isWebPasswordEnabled`, not that name.

- [ ] **Step 4: Wire the tab**

In `components/TabBar.tsx`, add the props and the id:

```tsx
// Props interface
  terminalSelected?: boolean;
  onSelectTerminal?: () => void;

// Signature
export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab, explorerSelected = false, onSelectExplorer, explorerBadge = 0, gitSelected = false, onSelectGit, gitBadge = 0, terminalSelected = false, onSelectTerminal }: Props) {

// orderedTabIds
  const orderedTabIds = [
    ...(onSelectExplorer ? ["explorer"] : []),
    ...(onSelectGit ? ["git"] : []),
    ...(onSelectTerminal ? ["terminal"] : []),
    ...tabs.map((tab) => tab.id),
  ];

// selectTabById
    else if (id === "terminal") onSelectTerminal?.();
```

Then render the pinned button by copying the `git` button block and changing its id, label key (`tabBar.terminal`), and `aria-selected={terminalSelected}`.

In `components/RightPanel.tsx`:

```tsx
export type RightPanelView = "explorer" | "git" | "file" | "terminal";
```

Add to the `TabBar` call site: `terminalSelected={rightView === "terminal"}` and `onSelectTerminal={() => onSelectRightView?.("terminal")}`. Add a panel block mirroring the `git` one:

```tsx
{/* Terminal tab view — kept mounted so scrollback survives tab switches. */}
<div id="workspace-file-panel-terminal" role="tabpanel" aria-label={t("tabBar.terminal")} style={{ display: rightView === "terminal" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
  {visitedViews.has("terminal") && (
    <TerminalPanel
      cwd={explorerCwd}
      emptyMessage={t("terminal.selectProjectFirst")}
      authRequiredMessage={t("terminal.authRequired")}
    />
  )}
</div>
```

In `components/AppShell.tsx:972`:

```tsx
const [rightView, setRightView] = useState<"explorer" | "git" | "file" | "terminal">("explorer");
```

- [ ] **Step 5: Add the locale keys**

Add to all three locales:

| key | en | ja | zh-CN |
|---|---|---|---|
| `tabBar.terminal` | Terminal | ターミナル | 终端 |
| `terminal.selectProjectFirst` | Select a project to open a terminal. | ターミナルを開くプロジェクトを選択してください。 | 选择项目以打开终端。 |
| `terminal.authRequired` | The terminal requires a web password | ターミナルには web パスワードが必要です | 终端需要 web 密码 |

Insert each next to its sibling group (`tabBar.git` for the first, `modelsConfig.apiKeyManageHint` for the rest), keeping the splice textual.

- [ ] **Step 6: Run the tests**

Run:
```bash
NODE_ENV=test node --experimental-strip-types --test components/TerminalPanel.test.mjs
```
Expected: PASS. Then:
```bash
NODE_ENV=test node --experimental-strip-types --test components/ui-scale.test.mjs components/SettingsConfig.subpanels.test.mjs
```
Expected: PASS — these assert on rendered markup and will catch a broken TabBar change.

- [ ] **Step 7: Commit**

```bash
git add components/TerminalPanel.tsx components/TerminalPanel.test.mjs components/TabBar.tsx components/RightPanel.tsx components/AppShell.tsx lib/i18n/locales
git commit -m "Add the terminal panel as a pinned tab beside Explorer and Git"
```

---

## Task 4: Dependencies and the native build

Last, on purpose: touching the Dockerfile earlier would make a code bug and a build failure look like the same problem.

**Files:**
- Modify: `package.json`, `Dockerfile`

**Interfaces:** none consumed or produced.

- [ ] **Step 1: Add the dependencies**

```bash
npm install node-pty @xterm/xterm @xterm/addon-fit
```

`node-pty` must land in `dependencies`, not `devDependencies` — it is required at runtime by the server.

- [ ] **Step 2: Verify the native module loads locally**

Run:
```bash
node -e "const p=require('node-pty'); console.log(typeof p.spawn)"
```
Expected: `function`. If it prints anything else, the build toolchain is missing — stop and report rather than continuing.

- [ ] **Step 3: Add the build step to the Dockerfile**

Find the stage that runs `npm ci` / `npm install` and add, after it:

```dockerfile
# node-pty ships a prebuilt binary per platform, but the image is built on each
# architecture natively and the published prebuilds do not cover every one of
# them. Compile from source so amd64 and arm64 both get a matching .node file.
RUN npm rebuild node-pty --build-from-source
```

If the image installs production dependencies only (`npm ci --omit=dev`), move the rebuild into that same stage — otherwise `node-pty` is compiled and then pruned.

- [ ] **Step 4: Typecheck and full test**

```bash
node_modules/.bin/tsc --noEmit
NODE_ENV=test npm test
```
Expected: both clean. `tsc` failing on `node-pty` types now means the install did not complete.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json Dockerfile
git commit -m "Add node-pty and xterm, and compile the native module in the image"
```

---

## Task 5: Manual verification and push

- [ ] **Step 1: Run the app against a real shell**

```bash
npm run dev
```

Open the UI, pick a workspace, click the Terminal tab. Confirm by hand:
- a prompt appears and typing runs commands;
- `vim` opens and `q` exits (proves a real PTY, not a piped shell);
- Ctrl-C interrupts a long command (`sleep 60`);
- resizing the window reflows the shell;
- switching tabs and back keeps the scrollback.

- [ ] **Step 2: Verify the password guard**

```bash
OMP_WEB_PASSWORD= npm run dev
```
Expected: the tab shows the "set OMP_WEB_PASSWORD" guidance and no shell starts. Then set a password and confirm the terminal works.

- [ ] **Step 3: Confirm the multi-arch image builds**

```bash
git push fork main
gh run list -R hcdbp24c3/ompweb --limit 2
```
Watch both `build linux/amd64` and `build linux/arm64`. If arm64 fails on the native build, **report before pushing anything else** — a broken arm64 image is worse than a missing terminal.

---

## Self-Review Notes

- **Type consistency.** `TerminalHandle.addListener` is introduced in Task 1 and is the only thing Task 2's stream route calls; `getSharedPtyRegistry(spawn?)` has the same signature in both tasks because Task 2 no longer edits the registry.
- **Spec coverage.** Spec §3 transport → Task 2 and 3. §4.1 registry, idle reaping, cap, scrollback → Task 1. §4.2 panel, pinned tab, keep-mounted → Task 3. §5 password gate and allowlist → `guardTerminalCwd` in Task 2. §6 error table → the three route files. §8 dependencies and native build → Task 4. §9 ordering → the task order.
- **Placeholder scan.** Every code block is the code to paste. The `isWebPasswordConfigured` import in Task 3 Step 3 is called out as unused and to be removed in the same step, rather than left in.
- **`tsc --noEmit` is expected to fail between Task 2 and Task 4** — `node-pty` is not installed until Task 4. That is the plan working as intended, not a defect.
