// The routes are guarded in three places: the password requirement, the
// filesystem allowlist, and the cwd existing at all. None of them spawn a shell,
// so all three are testable with a stubbed registry and a stubbed allowlist.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
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

// The stub mirrors the whole TerminalHandle surface, not just the four methods
// the happy path touches: the stream route's contract is that it *subscribes*,
// and only a stub with addListener/onExit can hold it to that.
const registryStub = join(tmp, "pty-registry-stub.ts");
writeFileSync(
  registryStub,
  `export const state = { handles: new Map(), attachCalls: [], detaches: [], tooMany: false, replayText: "" };
export class TooManyTerminalsError extends Error {}
export function getSharedPtyRegistry() {
  return {
    attach(cwd, cols, rows) {
      state.attachCalls.push({ cwd, cols, rows });
      if (state.tooMany) throw new TooManyTerminalsError(4);
      const handle = {
        writes: [], resizes: [], killed: false, listeners: new Set(), exitSubscribers: new Set(),
        write(d) { this.writes.push(d); },
        resize(c, r) { this.resizes.push([c, r]); },
        kill() {
          this.killed = true;
          for (const notify of [...this.exitSubscribers]) notify();
        },
        replay() { return state.replayText; },
        addListener(listener) {
          this.listeners.add(listener);
          return () => { this.listeners.delete(listener); };
        },
        onExit(cb) {
          this.exitSubscribers.add(cb);
          return () => { this.exitSubscribers.delete(cb); };
        },
      };
      state.handles.set(cwd, handle);
      return handle;
    },
    detach(cwd) { state.detaches.push(cwd); },
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
const { GET: streamGet } = await jiti.import("../../app/api/terminal/stream/route.ts");
const { POST: inputPost } = await jiti.import("../../app/api/terminal/input/route.ts");
const { POST: closePost } = await jiti.import("../../app/api/terminal/close/route.ts");
const { state } = await jiti.import(registryStub);

const CWD = join(tmp, "workspace");
// The guard refuses a cwd that does not exist, so the success paths need one.
mkdirSync(CWD, { recursive: true });

const post = (route, body) =>
  route(new Request("http://local/api/terminal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));

// Bounded on purpose: a stream that never sends — or never closes — must fail
// this test rather than hang the whole suite.
const READ_TIMEOUT_MS = 2000;

const nextRead = (reader) => {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("the terminal stream produced no frame")), READ_TIMEOUT_MS);
  });
  return Promise.race([reader.read(), expiry]).finally(() => clearTimeout(timer));
};

const nextFrame = async (reader) => {
  const { value } = await nextRead(reader);
  const text = new TextDecoder().decode(value);
  return JSON.parse(text.replace(/^data: /, ""));
};

beforeEach(() => {
  state.handles.clear();
  state.attachCalls.length = 0;
  state.detaches.length = 0;
  state.tooMany = false;
  state.replayText = "";
  if (process.env.OMP_WEB_PASSWORD === undefined) delete process.env.OMP_WEB_PASSWORD;
});

after(() => rmSync(tmp, { recursive: true, force: true }));

test("stream refuses when no web password is configured", async () => {
  delete process.env.OMP_WEB_PASSWORD;
  const res = await streamGet(new Request(`http://local/api/terminal/stream?cwd=${CWD}`));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, "terminal_auth_required");
  assert.deepEqual(state.attachCalls, [], "and never spawns a shell");
});

test("stream requires a cwd", async () => {
  process.env.OMP_WEB_PASSWORD = "hunter2";
  const res = await streamGet(new Request("http://local/api/terminal/stream"));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "terminal_cwd_required");
});

test("stream refuses a cwd outside the allowlist", async () => {
  process.env.OMP_WEB_PASSWORD = "hunter2";
  const res = await streamGet(new Request("http://local/api/terminal/stream?cwd=/etc"));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "access_denied");
  assert.deepEqual(state.attachCalls, []);
});

test("stream reports a missing cwd rather than spawning into nothing", async () => {
  process.env.OMP_WEB_PASSWORD = "hunter2";
  const res = await streamGet(new Request(`http://local/api/terminal/stream?cwd=${join(tmp, "nope")}`));
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "terminal_cwd_not_found");
});

// The load-bearing one. A route that polls replay() leaves the shell in
// entry.listeners.size === 0, which is exactly the state the idle reaper acts
// on: the browser keeps showing a terminal that no longer exists.
test("the stream subscribes to live output instead of polling replay()", async () => {
  process.env.OMP_WEB_PASSWORD = "hunter2";
  state.replayText = "boot prompt\r\n";
  const res = await streamGet(new Request(`http://local/api/terminal/stream?cwd=${CWD}&cols=100&rows=30`));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type") ?? "", /text\/event-stream/);

  const handle = state.handles.get(CWD);
  assert.equal(handle.listeners.size, 1, "a watched shell is never treated as idle");
  assert.equal(handle.exitSubscribers.size, 1, "and is told when the shell goes away");

  const reader = res.body.getReader();
  const replayFrame = await nextFrame(reader);
  assert.equal(replayFrame.type, "replay");
  assert.equal(replayFrame.data, "boot prompt\r\n");
  assert.equal(replayFrame.cols, 100);
  assert.equal(replayFrame.rows, 30);

  for (const listener of [...handle.listeners]) listener("live chunk");
  assert.deepEqual(await nextFrame(reader), { type: "output", data: "live chunk" });

  await reader.cancel();
  assert.equal(handle.listeners.size, 0, "a client that goes away releases its subscription");
  assert.ok(state.detaches.includes(CWD), "and lets idle reaping take the shell again");
});

test("the stream closes when the shell exits rather than hanging", async () => {
  process.env.OMP_WEB_PASSWORD = "hunter2";
  const res = await streamGet(new Request(`http://local/api/terminal/stream?cwd=${CWD}`));
  const handle = state.handles.get(CWD);
  const reader = res.body.getReader();
  assert.equal((await nextFrame(reader)).type, "replay");

  for (const notify of [...handle.exitSubscribers]) notify();

  assert.equal((await nextFrame(reader)).type, "exit");
  assert.deepEqual(await nextRead(reader), { done: true, value: undefined });
  assert.equal(handle.listeners.size, 0);
  assert.equal(handle.exitSubscribers.size, 0);
});

// A disconnect that lands while the guard is still awaiting fires the signal
// before the listener is attached, so `addEventListener("abort", ...)` would
// never run and the subscription would outlive the browser forever.
test("a client that was already gone releases its subscription", async () => {
  process.env.OMP_WEB_PASSWORD = "hunter2";
  const alreadyGone = new AbortController();
  alreadyGone.abort();
  const res = await streamGet(new Request(`http://local/api/terminal/stream?cwd=${CWD}`, { signal: alreadyGone.signal }));
  const reader = res.body.getReader();
  assert.deepEqual(await nextRead(reader), { done: true, value: undefined });
  assert.equal(state.handles.get(CWD).listeners.size, 0, "no listener is left holding the shell open");
  assert.equal(state.handles.get(CWD).exitSubscribers.size, 0);
});

test("input forwards keystrokes to the shell for that cwd", async () => {
  process.env.OMP_WEB_PASSWORD = "hunter2";
  const res = await post(inputPost, { cwd: CWD, data: "ls -la\r" });
  assert.equal(res.status, 200);
  assert.deepEqual(state.handles.get(CWD).writes, ["ls -la\r"]);
});

test("input forwards a resize", async () => {
  process.env.OMP_WEB_PASSWORD = "hunter2";
  const res = await post(inputPost, { cwd: CWD, cols: 120, rows: 40 });
  assert.equal(res.status, 200);
  assert.deepEqual(state.handles.get(CWD).resizes, [[120, 40]]);
});

test("input rejects a payload with neither data nor a size", async () => {
  process.env.OMP_WEB_PASSWORD = "hunter2";
  const res = await post(inputPost, { cwd: CWD });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "terminal_input_empty");
});

test("input rejects a non-string data field instead of coercing it", async () => {
  process.env.OMP_WEB_PASSWORD = "hunter2";
  const res = await post(inputPost, { cwd: CWD, data: { evil: true } });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "terminal_input_invalid");
});

test("input rejects nonsense dimensions", async () => {
  process.env.OMP_WEB_PASSWORD = "hunter2";
  for (const body of [{ cols: 0, rows: 24 }, { cols: 80, rows: -1 }, { cols: 99999, rows: 24 }]) {
    const res = await post(inputPost, { cwd: CWD, ...body });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
});

// A resize with one dimension cannot be applied: node-pty would take the
// undefined straight into the pty resize call.
test("input rejects a resize carrying only one dimension", async () => {
  process.env.OMP_WEB_PASSWORD = "hunter2";
  for (const body of [{ cols: 120 }, { rows: 40 }]) {
    const res = await post(inputPost, { cwd: CWD, ...body });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.equal((await res.json()).code, "terminal_size_invalid");
  }
  assert.deepEqual(state.attachCalls, [], "and no shell is spawned for a rejected resize");
});

test("a full terminal cap surfaces as 429, not 500", async () => {
  process.env.OMP_WEB_PASSWORD = "hunter2";
  state.tooMany = true;
  const res = await post(inputPost, { cwd: CWD, data: "x" });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).code, "terminal_limit_reached");
});

test("close kills the shell for that cwd", async () => {
  process.env.OMP_WEB_PASSWORD = "hunter2";
  await post(inputPost, { cwd: CWD, data: "x" });
  const res = await post(closePost, { cwd: CWD });
  assert.equal(res.status, 200);
  assert.equal(state.handles.get(CWD).killed, true);
});

test("close does not spawn a shell only to kill it", async () => {
  process.env.OMP_WEB_PASSWORD = "hunter2";
  const res = await post(closePost, { cwd: CWD });
  assert.equal(res.status, 200);
  assert.deepEqual(state.attachCalls, []);
});