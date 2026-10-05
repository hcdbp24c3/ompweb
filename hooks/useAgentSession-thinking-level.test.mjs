import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { act, cleanup, renderHook } from "@testing-library/react/pure.js";

// "Auto" is a client-only fiction unless it is actually put on the wire: omp's
// ThinkingLevel enum carries Inherit ("inherit") as its FIRST member, and
// setThinkingLevel("inherit") stores `isAutoThinking`, resolves a concrete
// level for the run, and reports the RESOLVED level everywhere else —
// get_state.thinkingLevel, config_update.thinkingLevel, and the
// thinking_level_change entry written to the session file.
//
// So "Auto sticks" needs all of: the sentinel on the wire, `configured` read
// off the event that reports it, and a sync that does not roll the resolved
// value back over the user's choice.

// ---------------------------------------------------------------------------
// Fake EventSource + fetch router
// ---------------------------------------------------------------------------
class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  constructor(url) {
    this.url = String(url);
    this.readyState = FakeEventSource.CONNECTING;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.closedByCaller = false;
    this.sequence = 0;
    world.esInstances.push(this);
  }
  open() {
    if (this.closedByCaller) return;
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.({});
    this.onmessage?.({ data: JSON.stringify({ type: "connected", web: this.web() }) });
  }
  web() {
    return { streamId: `stream-${this.sessionId()}`, sequence: this.sequence };
  }
  sessionId() {
    return decodeURIComponent(this.url.match(/\/api\/agent\/([^/?#]+)/)?.[1] ?? "");
  }
  emit(event) {
    if (this.closedByCaller) return;
    this.sequence += 1;
    this.onmessage?.({ data: JSON.stringify({ ...event, web: event.web ?? this.web() }) });
  }
  close() {
    this.closedByCaller = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function jsonResponse(status, value) {
  return { ok: status >= 200 && status < 300, status, json: async () => value };
}

// The session file + live omp state the router serves. Tests mutate these.
const world = {
  esInstances: [],
  commands: [],
  context: { messages: [], entryIds: [], thinkingLevel: "off", model: null, todoPhases: [] },
  live: { running: false, state: {} },
  /** Fired while a command is received, so a frame provably lands before the
   *  post-command refresh (which captures its token after the command). */
  onAgentCommand: null,
};

async function fetchStub(url, init = {}) {
  const method = (init.method ?? "GET").toUpperCase();
  const u = String(url);
  let m;

  if ((m = u.match(/\/api\/sessions\/([^/?#]+)\/state/))) {
    return jsonResponse(200, { running: world.live.running, state: world.live.state });
  }
  if ((m = u.match(/\/api\/sessions\/([^/?#]+)\/context/))) {
    const params = new URL(u, "http://localhost").searchParams;
    const context = { ...world.context };
    if (!params.has("sync")) return jsonResponse(200, { context });
    return jsonResponse(200, {
      ...selectSessionHistory(context, params.has("cursor") ? JSON.parse(params.get("cursor")) : null),
      sessionId: decodeURIComponent(m[1]),
      leafId: null,
      live: null,
    });
  }
  if ((m = u.match(/\/api\/sessions\/([^/?#]+)/))) {
    return jsonResponse(200, {
      sessionId: decodeURIComponent(m[1]),
      filePath: "/fixture/session.jsonl",
      tree: [],
      leafId: null,
      context: { ...world.context },
    });
  }
  if (/^\/api\/models/.test(u)) {
    return jsonResponse(200, { models: {}, modelList: [], defaultModel: null });
  }
  if ((m = u.match(/\/api\/agent\/([^/?#]+)/))) {
    if (method === "GET") return jsonResponse(200, { running: world.live.running, state: world.live.state });
    if (method === "POST") {
      const command = safeParse(init.body);
      world.commands.push(command);
      if (world.onAgentCommand) world.onAgentCommand(command);
      return jsonResponse(200, { success: true, data: {} });
    }
  }
  if (/subagents/.test(u)) return jsonResponse(200, { subagents: [] });
  return jsonResponse(404, {});
}

// jsdom (v29) has no matchMedia; lib/composer-prefs.ts calls it unguarded.
const overrides = [
  [globalThis, "EventSource", { value: FakeEventSource }],
  [globalThis, "fetch", { value: fetchStub }],
  [window, "matchMedia", {
    value: (media) => Object.assign(new window.EventTarget(), { matches: false, media }),
  }],
].map(([target, key, replacement]) => ({
  target, key, replacement, original: Object.getOwnPropertyDescriptor(target, key),
}));

beforeEach(() => {
  for (const { target, key, replacement } of overrides) {
    Object.defineProperty(target, key, { configurable: true, ...replacement });
  }
  resetWorld();
});

afterEach(() => {
  try {
    cleanup();
  } finally {
    for (const { target, key, original } of overrides) {
      if (original) Object.defineProperty(target, key, original);
      else delete target[key];
    }
  }
});

// The hook chain includes components/ui/toast.tsx, whose JSX jiti cannot parse
// in this environment and whose DOM toasts must never fire inside Node tests.
const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: {
    "@/components/ui/toast": fileURLToPath(new URL("./__fixtures__/toast-stub.mjs", import.meta.url)),
    "@/": fileURLToPath(new URL("../", import.meta.url)),
  },
});
const { useAgentSession } = await jiti.import("../hooks/useAgentSession.ts");
const { selectSessionHistory } = await jiti.import("@/lib/session-sync");

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function settle(ms = 120) {
  await act(async () => {
    await sleep(ms);
  });
}

function resetWorld() {
  world.esInstances.length = 0;
  world.commands.length = 0;
  world.context = { messages: [], entryIds: [], thinkingLevel: "off", model: null, todoPhases: [] };
  world.live = { running: false, state: {} };
  world.onAgentCommand = null;
}

function sessionInfo(sid) {
  return {
    id: sid,
    path: "",
    cwd: "/workspace",
    name: `session ${sid}`,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 0,
    firstMessage: "q",
  };
}

/** Mount + hydrate. A running wrapper makes the hook open its event stream. */
async function mount(sid) {
  const { result, unmount } = renderHook(() => useAgentSession({ session: sessionInfo(sid), newSessionCwd: null }));
  await settle();
  return { unmount, get latest() { return result.current; } };
}

function lastEs() {
  return world.esInstances[world.esInstances.length - 1];
}

function thinkingCommands() {
  return world.commands.filter((c) => c?.type === "set_thinking_level");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("choosing Auto puts the inherit sentinel on the wire", async () => {
  world.live = { running: true, state: { thinkingLevel: "off" } };
  const w = await mount("s1");

  await act(async () => { await w.latest.handleThinkingLevelChange("auto"); });

  const sent = thinkingCommands();
  assert.equal(sent.length, 1, "Auto must reach omp as set_thinking_level");
  assert.equal(sent[0].level, "inherit", "Auto is omp's Inherit sentinel, not a no-op");
});

test("Auto survives the concrete level the refresh after the command reports back", async () => {
  world.live = { running: true, state: { thinkingLevel: "off" } };
  const w = await mount("s1");

  // omp resolved the auto sentinel against this model's ladder. Every surface
  // but thinking_level_changed.configured reports that concrete level, and
  // refreshLiveModelState runs immediately after the command is acked — so a
  // selection made a moment ago must not be rolled back by it.
  world.live = { running: true, state: { thinkingLevel: "high" } };
  await act(async () => { await w.latest.handleThinkingLevelChange("auto"); });

  assert.equal(w.latest.thinkingLevel, "auto", "the resolved level must not overwrite an in-flight selection");
});

test("cycling onto Auto keeps Auto: the refresh reports the level it resolved to", async () => {
  // omp's cycle walks [off, inherit, ...efforts], so Auto is reachable by
  // keyboard too, and the same resolved-level read-back would undo it.
  world.live = { running: true, state: { thinkingLevel: "off" } };
  const w = await mount("s1");
  await act(async () => { lastEs().open(); });

  world.live = { running: true, state: { thinkingLevel: "high" } };
  // omp echoes the change as the command is processed, so the frame beats the
  // post-command refresh — the refresh then reads back the resolved "high" and
  // must not overwrite what the frame just said.
  world.onAgentCommand = (command) => {
    if (command?.type === "cycle_thinking_level") {
      lastEs().emit({ type: "thinking_level_changed", thinkingLevel: "high", configured: "inherit" });
    }
  };
  await act(async () => { await w.latest.handleCycleThinkingLevel(); });
  world.onAgentCommand = null;

  assert.equal(w.latest.thinkingLevel, "auto");
});

test("thinking_level_changed reads the selection off configured, not the resolved level", async () => {
  world.live = { running: true, state: { thinkingLevel: "high" } };
  const w = await mount("s1");
  await act(async () => { lastEs().open(); });

  // omp's auto branch emits both fields (setThinkingLevel("inherit")): the
  // resolved level plus configured: "inherit". Reading thinkingLevel here is
  // what made Auto snap to a concrete effort the moment it was chosen.
  await act(async () => {
    lastEs().emit({ type: "thinking_level_changed", thinkingLevel: "high", configured: "inherit" });
    await Promise.resolve();
  });

  assert.equal(w.latest.thinkingLevel, "auto");
});

test("thinking_level_changed without configured still reads the reported level", async () => {
  world.live = { running: true, state: { thinkingLevel: "high" } };
  const w = await mount("s1");
  await act(async () => { lastEs().open(); });

  // omp's explicit-level branch omits `configured` entirely (verified in the
  // 18.4.6 bundle), so a missing field must fall back to thinkingLevel — and
  // "off" is a real choice, never Auto.
  for (const [thinkingLevel, expected] of [["high", "high"], ["off", "off"], ["minimal", "minimal"]]) {
    await act(async () => {
      lastEs().emit({ type: "thinking_level_changed", thinkingLevel });
      await Promise.resolve();
    });
    assert.equal(w.latest.thinkingLevel, expected, `thinkingLevel ${thinkingLevel} with no configured`);
  }
});

test("a thinking_level_changed frame with no level at all leaves the selection alone", async () => {
  // "no information" must not be read as Auto: normalizeThinkingLevel maps a
  // missing value to Auto, which would invent a selection the user never made.
  world.live = { running: true, state: { thinkingLevel: "high" } };
  const w = await mount("s1");
  await act(async () => { lastEs().open(); });

  const before = w.latest.thinkingLevel;
  assert.notEqual(before, "auto", "the baseline must not already be Auto, or this proves nothing");
  await act(async () => {
    lastEs().emit({ type: "thinking_level_changed" });
    await Promise.resolve();
  });

  assert.equal(w.latest.thinkingLevel, before);
});

test("a persisted selection rehydrates as the selector it was, never blanket-Auto", async () => {
  // lib/session-reader reads the configured selector off the entry and hands the
  // raw wire value over; the composer is what turns omp's "inherit" back into
  // Auto. A legacy entry with no `configured` reaches the same boundary as a
  // concrete level and must stay one.
  world.context = { messages: [], entryIds: [], thinkingLevel: "inherit", model: null, todoPhases: [] };
  const auto = await mount("s1");
  assert.equal(auto.latest.thinkingLevel, "auto", "a persisted Auto must rehydrate as Auto");
  auto.unmount();

  world.context = { messages: [], entryIds: [], thinkingLevel: "high", model: null, todoPhases: [] };
  const explicit = await mount("s2");
  assert.equal(explicit.latest.thinkingLevel, "high", "a persisted explicit level must not become Auto");
});