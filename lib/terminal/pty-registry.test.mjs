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