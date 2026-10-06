import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const {
  asyncSpawnerBridge,
  createPtyRegistry,
  getSharedPtyRegistry,
} = await jiti.import("@/lib/terminal/pty-registry.ts");

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

/** A spawner that hands out fakes and remembers what it was asked for. */
function recordingSpawner() {
  const spawned = [];
  return {
    spawned,
    spawn: (opts) => {
      const pty = fakePty();
      spawned.push({ opts, pty });
      return pty;
    },
  };
}

function harness(limits) {
  const { spawned, spawn } = recordingSpawner();
  return { spawned, registry: createPtyRegistry(spawn, limits) };
}

/** A spawner whose completion the test decides, standing in for the window while
 *  node-pty is still being imported. */
function deferredSpawner() {
  let settle;
  const spawn = () => new Promise((resolve) => { settle = resolve; });
  return { spawn, resolve: (pty) => settle(pty) };
}

/** Node runs macrotasks after every pending microtask, so one turn is enough for
 *  a resolved spawn promise and the bridge's own callbacks to have run. */
function settleMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

const spawnOpts = { cwd: "/repo", cols: 80, rows: 24, env: {} };

/** Run `t` with GH_TOKEN / GITHUB_TOKEN set exactly to `overrides`, restoring
 *  whatever the host had afterwards. This host exports a real pair of its own,
 *  so every assertion about what a shell does or does not receive has to control
 *  them rather than assume they are absent. */
function withGhEnv(t, overrides) {
  const names = ["GH_TOKEN", "GITHUB_TOKEN"];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  for (const [name, value] of Object.entries(overrides)) process.env[name] = value;
  t.after(() => {
    for (const name of names) {
      const original = previous.get(name);
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
  });
}

/**
 * Read a variable out of a child environment the way the child reads it.
 *
 * A Windows environment block is case-insensitive and the host spells the search
 * path `Path`, so a plain property read of a sanitized copy finds nothing there
 * while the shell still resolves PATH from the same object. The registry builds
 * that copy with an object spread, which keeps the host's spelling rather than
 * Node's case-insensitive `process.env` lookup, so the assertion has to do the
 * lookup the shell does.
 */
function envValue(env, name) {
  if (name in env) return env[name];
  const wanted = name.toUpperCase();
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === wanted) return env[key];
  }
  return undefined;
}

/**
 * Call before touching the shared registry, hand the result to `finally`.
 *
 * Creating that registry claims two things outside the module: the globalThis
 * slot and one exit/SIGINT/SIGTERM shutdown listener per event. Clearing only the
 * slot leaves three listeners behind per test, and Node starts warning about it
 * once the file passes ten. Both go back together, so no test here is quieter
 * than the next.
 */
function claimProcessState() {
  const events = ["exit", "SIGINT", "SIGTERM"];
  const before = new Map(events.map((event) => [event, new Set(process.listeners(event))]));
  return () => {
    for (const event of events) {
      for (const listener of process.listeners(event)) {
        if (!before.get(event).has(listener)) process.off(event, listener);
      }
    }
    delete globalThis.__ompWebTerminalRegistry;
  };
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

test("scrollback replays output, and the retained chunk count is capped", () => {
  const { spawned, registry } = harness({ scrollbackChunks: 3 });
  const handle = registry.attach("/repo", 80, 24);
  const { dataCb } = spawned[0].pty.state;
  for (const line of ["one", "two", "three", "four"]) dataCb(`${line}\r\n`);
  assert.equal(handle.replay(), "two\r\nthree\r\nfour\r\n", "keeps only the last N chunks");
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

test("a stale handle cannot kill the shell that replaced it", () => {
  const { spawned, registry } = harness();
  const stale = registry.attach("/repo", 80, 24);
  stale.kill();

  registry.attach("/repo", 80, 24);
  stale.kill();

  assert.equal(spawned.length, 2);
  assert.equal(spawned[1].pty.state.killed, false, "the replacement is still running");
  assert.deepEqual(registry.activeCwds(), ["/repo"], "and still registered");
});

test("a shell that exits late cannot evict its replacement", () => {
  const { spawned, registry } = harness();
  const stale = registry.attach("/repo", 80, 24);
  stale.kill();
  registry.attach("/repo", 80, 24);

  spawned[0].pty.state.exitCb(0);

  assert.deepEqual(registry.activeCwds(), ["/repo"], "the live shell is still registered");
});

test("the npm test glob includes lib/terminal", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const globs = pkg.scripts.test.split(/\s+/).filter((arg) => arg.endsWith(".test.mjs"));
  assert.ok(
    globs.includes("lib/terminal/*.test.mjs"),
    `npm test must run the terminal tests, or the suite reports green without them; got: ${pkg.scripts.test}`,
  );
});

test("a shell killed before it finishes spawning does not survive", async () => {
  const deferred = deferredSpawner();
  const spawner = asyncSpawnerBridge(deferred.spawn);

  const pty = fakePty();
  spawner(spawnOpts).kill();
  deferred.resolve(pty);
  await settleMicrotasks();

  assert.equal(pty.state.killed, true, "the shell that arrived after the kill is killed");
});

test("input typed before the shell exists is delivered once it does", async () => {
  const deferred = deferredSpawner();
  const spawner = asyncSpawnerBridge(deferred.spawn);

  const handle = spawner(spawnOpts);
  handle.write("ls\r");
  const pty = fakePty();
  deferred.resolve(pty);
  await settleMicrotasks();

  assert.deepEqual(pty.state.writes, ["ls\r"]);
  assert.equal(pty.state.killed, false);
});

test("a spawn failure surfaces as an exit instead of crashing the server", async () => {
  const escaped = [];
  const onStrayRejection = (reason) => escaped.push(reason);
  process.on("unhandledRejection", onStrayRejection);

  try {
    const spawner = asyncSpawnerBridge(() => Promise.reject(new Error("Cannot find module 'node-pty'")));
    const handle = spawner(spawnOpts);
    const exits = [];
    handle.onExit((code) => exits.push(code));

    await settleMicrotasks();

    assert.deepEqual(exits, [1], "the failure arrives as the exit the registry drops an entry on");
    assert.deepEqual(escaped, [], "and no rejection escapes into the process");
  } finally {
    process.off("unhandledRejection", onStrayRejection);
  }
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

test("a caller can add a per-cwd override to the shell's environment", (t) => {
  // This host exports GH_TOKEN/GITHUB_TOKEN of its own (which is a fact worth
  // testing against, see below), so the ambient values are removed here rather
  // than assumed absent.
  withGhEnv(t, {});
  const { spawned, registry } = harness();
  // This is how the repository's resolved gh token reaches the shell: attach()
  // is synchronous, so the caller resolves first and hands the result in.
  registry.attach("/repo", 80, 24, { env: { GH_TOKEN: "ghp_one", GITHUB_TOKEN: "ghp_one" } });
  const { env } = spawned[0].opts;

  assert.equal(env.GH_TOKEN, "ghp_one");
  assert.equal(env.GITHUB_TOKEN, "ghp_one");
  assert.equal(env.TERM, "xterm-256color", "the terminal's own settings are not displaced by the override");
  assert.ok(env.SHELL);
  assert.ok(envValue(env, "PATH"), "and the shell still inherits the host environment");
});

test("an override cannot put a stripped host variable back", (t) => {
  withGhEnv(t, {});
  const { spawned, registry } = harness();
  // sanitizeProjectCommandEnvironment runs over the merged object, not before
  // it — so this is a property of where the merge happens, and it is the reason
  // the override is passed rather than applied to a finished env.
  registry.attach("/repo", 80, 24, { env: { OMP_WEB_PASSWORD: "secret", PORT: "30178" } });
  const { env } = spawned[0].opts;

  assert.equal(env.OMP_WEB_PASSWORD, undefined);
  assert.equal(env.PORT, undefined);
});

test("two cwds get two shells with two different overrides", (t) => {
  withGhEnv(t, {});
  const { spawned, registry } = harness();
  registry.attach("/repo-a", 80, 24, { env: { GH_TOKEN: "ghp_one" } });
  registry.attach("/repo-b", 80, 24, { env: { GH_TOKEN: "ghp_two" } });

  assert.equal(spawned[0].opts.env.GH_TOKEN, "ghp_one");
  assert.equal(spawned[1].opts.env.GH_TOKEN, "ghp_two");
});

test("the resolved commit identity reaches the shell and beats an inherited one", (t) => {
  // Same seam as the gh token: the terminal routes resolve per cwd and hand the
  // result to attach(). git reads an ident from the environment, so this is the
  // only channel a `git commit` typed here has — omp-web must not write
  // ~/.gitconfig instead.
  //
  // An ambient value is set first because that is the case that matters: a
  // container that already exports GIT_AUTHOR_NAME (CI, a base image) must not
  // silently out-rank the repository's own configured identity, and the
  // repository's must not disappear because the base image had one.
  const names = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = "inherited";
  t.after(() => {
    for (const name of names) {
      const original = previous.get(name);
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
  });

  const { spawned, registry } = harness();
  registry.attach("/repo", 80, 24, {
    env: { GIT_AUTHOR_NAME: "Octo Cat", GIT_AUTHOR_EMAIL: "octocat@example.com", GIT_COMMITTER_NAME: "Octo Cat", GIT_COMMITTER_EMAIL: "octocat@example.com" },
  });
  const { env } = spawned[0].opts;

  assert.equal(env.GIT_AUTHOR_NAME, "Octo Cat");
  assert.equal(env.GIT_COMMITTER_EMAIL, "octocat@example.com");

  // A shell for a cwd that resolved no identity keeps the operator's own value —
  // the same rule lib/gh-env.ts follows for an inherited GH_TOKEN.
  registry.attach("/other", 80, 24, { env: {} });
  assert.equal(spawned[1].opts.env.GIT_AUTHOR_NAME, "inherited");
});

test("a resolved token replaces the operator's own, and is left alone when there is none", (t) => {
  // A host may export GH_TOKEN for its own use — that is a credential the user
  // set for their own work, in the same category as OPENAI_API_KEY, and
  // hostChildEnv() deliberately does not strip those. What must hold is that the
  // repository's resolved token WINS, so a child never authenticates as somebody
  // the repository does not belong to just because the host happened to export
  // something. This host really does export one, which is how the case was found.
  withGhEnv(t, { GH_TOKEN: "ghp_from_the_host", GITHUB_TOKEN: "ghp_from_the_host" });

  const first = harness();
  first.registry.attach("/repo", 80, 24, { env: { GH_TOKEN: "ghp_resolved" } });
  assert.equal(first.spawned[0].opts.env.GH_TOKEN, "ghp_resolved", "the resolved token wins over an inherited one");

  const second = harness();
  second.registry.attach("/repo", 80, 24);
  assert.equal(
    second.spawned[0].opts.env.GH_TOKEN,
    "ghp_from_the_host",
    "with no resolution the user's own token is left as they set it, rather than deleted",
  );
});

test("a shell with a live listener survives past the idle window", async () => {
  const { spawned, registry } = harness({ idleMs: 20 });
  registry.attach("/repo", 80, 24).addListener(() => {});

  await new Promise((r) => setTimeout(r, 60));

  assert.equal(registry.count(), 1, "somebody is reading, so the shell is not idle");
  assert.equal(spawned[0].pty.state.killed, false);
});

test("unsubscribing re-arms the reaping clock", async () => {
  const { spawned, registry } = harness({ idleMs: 20 });
  const unsubscribe = registry.attach("/repo", 80, 24).addListener(() => {});

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(registry.count(), 1, "watched the whole time");

  unsubscribe();
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(registry.count(), 0, "the last reader leaving starts the clock");
  assert.equal(spawned[0].pty.state.killed, true);
});

test("a reaped shell notifies its exit subscriber", async () => {
  const { registry } = harness({ idleMs: 20 });
  const handle = registry.attach("/repo", 80, 24);
  let exits = 0;
  handle.onExit(() => { exits += 1; });

  handle.kill();

  assert.equal(exits, 1, "a reaped shell must reach the browser, not freeze it");
});

test("a shell that exits on its own notifies its exit subscriber", () => {
  const { spawned, registry } = harness();
  let exits = 0;
  registry.attach("/repo", 80, 24).onExit(() => { exits += 1; });

  spawned[0].pty.state.exitCb(0);

  assert.equal(exits, 1, "the browser learns the shell ended rather than waiting forever");
});

test("the exit signal fires once even when the shell is disposed twice", () => {
  const { spawned, registry } = harness();
  const handle = registry.attach("/repo", 80, 24);
  let exits = 0;
  handle.onExit(() => { exits += 1; });

  handle.kill();
  handle.kill();
  spawned[0].pty.state.exitCb(0);

  assert.equal(exits, 1, "only the first disposal is a live shell losing its process");
});

test("the shell does not inherit the web password or the host runtime variables", () => {
  const before = { ...process.env };
  process.env.OMP_WEB_PASSWORD = "correct horse battery staple";
  process.env.NEXT_PUBLIC_MARKER = "next-public";
  process.env.NEXT_RUNTIME_MARKER = "next-runtime";
  process.env.PORT = "30178";

  try {
    const { spawned, registry } = harness();
    registry.attach("/repo", 80, 24);
    const { env } = spawned[0].opts;

    assert.equal(env.OMP_WEB_PASSWORD, undefined, "a shell must not be able to read the guard password");
    assert.equal(env.NEXT_PUBLIC_MARKER, undefined);
    assert.equal(env.NEXT_RUNTIME_MARKER, undefined);
    assert.equal(env.PORT, undefined);
    assert.equal(env.TERM, "xterm-256color", "the terminal settings still come through");
    assert.ok(env.SHELL);
  } finally {
    for (const name of ["OMP_WEB_PASSWORD", "NEXT_PUBLIC_MARKER", "NEXT_RUNTIME_MARKER", "PORT"]) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  }
});

test("a listener receives the shell's output", () => {
  const { spawned, registry } = harness();
  const chunks = [];
  registry.attach("/repo", 80, 24).addListener((chunk) => chunks.push(chunk));

  spawned[0].pty.state.dataCb("hello\r\n");

  assert.deepEqual(chunks, ["hello\r\n"]);
});

test("unsubscribing stops delivery", () => {
  const { spawned, registry } = harness();
  const chunks = [];
  const unsubscribe = registry.attach("/repo", 80, 24).addListener((c) => chunks.push(c));

  spawned[0].pty.state.dataCb("before\r\n");
  unsubscribe();
  spawned[0].pty.state.dataCb("after\r\n");

  assert.deepEqual(chunks, ["before\r\n"]);
});

test("two listeners each receive the output", () => {
  const { spawned, registry } = harness();
  const first = [];
  const second = [];
  const handle = registry.attach("/repo", 80, 24);
  handle.addListener((c) => first.push(c));
  handle.addListener((c) => second.push(c));

  spawned[0].pty.state.dataCb("shared\r\n");

  assert.deepEqual(first, ["shared\r\n"]);
  assert.deepEqual(second, ["shared\r\n"], "two tabs can watch one shell without spawning two");
});

test("the shared registry is one instance however many callers ask for it", () => {
  const first = recordingSpawner();
  const second = recordingSpawner();
  const releaseProcessState = claimProcessState();
  try {
    const registry = getSharedPtyRegistry(first.spawn);

    assert.equal(getSharedPtyRegistry(second.spawn), registry, "a later caller must not build a second registry");

    registry.attach("/repo", 80, 24);
    assert.equal(first.spawned.length, 1, "the spawner fixed at creation is the one in use");
    assert.equal(second.spawned.length, 0, "and the later spawner is ignored");
  } finally {
    releaseProcessState();
  }
});

test("the shared registry disposes its shells when the server exits", () => {
  const { spawned, spawn } = recordingSpawner();
  const releaseProcessState = claimProcessState();
  try {
    const before = process.listeners("exit");
    const registry = getSharedPtyRegistry(spawn);
    registry.attach("/repo", 80, 24);

    const hook = process.listeners("exit").find((fn) => !before.includes(fn));
    assert.ok(hook, "creating the shared registry installs a shutdown hook");

    hook();
    assert.equal(registry.count(), 0, "which disposes the running shells");
    assert.equal(spawned[0].pty.state.killed, true, "so none outlives the server");
  } finally {
    releaseProcessState();
  }
});

test("killing a shell that has already exited does not signal a live process", async () => {
  const deferred = deferredSpawner();
  const handle = asyncSpawnerBridge(deferred.spawn)(spawnOpts);
  const pty = fakePty();
  deferred.resolve(pty);
  await settleMicrotasks();

  pty.state.exitCb(0);
  handle.kill();

  assert.equal(pty.state.killed, false, "the shell was already gone");
});

test("the registry is held on globalThis, not in module scope", () => {
  const { spawn } = recordingSpawner();
  const releaseProcessState = claimProcessState();
  try {
    const registry = getSharedPtyRegistry(spawn);

    // Module scope is empty again after a dev hot-reload, so a registry held
    // there would be a fresh one and every running shell would be orphaned. A
    // second jiti instance cannot prove that — it reuses the same module — so
    // the invariant is asserted directly: the slot is global, and it holds the
    // very registry callers get back.
    assert.equal(globalThis.__ompWebTerminalRegistry, registry);
  } finally {
    releaseProcessState();
  }
});

test("a subscriber that arrives after the shell was retired never fires", () => {
  const { spawned, registry } = harness();
  const handle = registry.attach("/repo", 80, 24);
  handle.kill();

  // The distinguishing case for the wasLive guard: the exit-subscriber set is
  // still empty when the first disposal clears it, so only the guard that reads
  // the entry's own liveness keeps this late subscriber from being told about a
  // death it missed. Without it the second disposal fires it.
  let exits = 0;
  handle.onExit(() => { exits += 1; });

  handle.kill();
  spawned[0].pty.state.exitCb(0);

  assert.equal(exits, 0, "the shell was already gone when this subscriber showed up");
});
