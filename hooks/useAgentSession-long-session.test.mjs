import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { act, cleanup, renderHook } from "@testing-library/react/pure.js";

// A transcript longer than one history page arrives from
// `GET /api/sessions/<id>` with NO `context` key at all — only filePath, info,
// leafId, sessionId and tree. The client is required to notice that and seed a
// window from `/context?sync=1&tail=1` before publishing.
//
// That requirement is what produced the reported crash. The route omitting the
// body is deliberate (a 200-entry page cap), but a reader that assumed `context`
// always existed blew up with
//
//   TypeError: Cannot read properties of undefined (reading 'entryIds')
//
// The message is untraceable from the outside: it names a field of a view-model,
// not the endpoint whose contract was broken. So this test asserts the BEHAVIOUR
// instead — a long session opened cold must render — because behaviour is what
// regressed, and it is the only statement of the contract that survives a
// refactor of the seed path.

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
  }
  open() {
    if (this.closedByCaller) return;
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.({});
    this.onmessage?.({ data: JSON.stringify({ type: "connected", web: {} }) });
  }
  close() {
    this.closedByCaller = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}

function jsonResponse(status, value) {
  return { ok: status >= 200 && status < 300, status, json: async () => value };
}

const LONG_SESSION = "01a105a3-77ef-7419-9023-b85619edbefa";

/** A 243-entry transcript: well past the route's one-page cap. */
function longContext() {
  const messages = [];
  const entryIds = [];
  for (let i = 0; i < 120; i += 1) {
    entryIds.push(`e${String(i * 2).padStart(4, "0")}`);
    messages.push({ role: "user", content: `question ${i}` });
    entryIds.push(`e${String(i * 2 + 1).padStart(4, "0")}`);
    messages.push({ role: "assistant", content: [{ type: "text", text: `answer ${i}` }] });
  }
  return { messages, entryIds, thinkingLevel: "off", model: null, todoPhases: [] };
}

const world = { context: longContext(), tailFetches: 0 };

async function fetchStub(url) {
  const u = String(url);
  let m;

  if ((m = u.match(/\/api\/sessions\/([^/?#]+)\/state/))) {
    return jsonResponse(200, { running: false, state: {} });
  }
  if ((m = u.match(/\/api\/sessions\/([^/?#]+)\/context/))) {
    const params = new URL(u, "http://localhost").searchParams;
    if (!params.has("sync")) return jsonResponse(200, { context: { ...world.context } });
    world.tailFetches += 1;
    return jsonResponse(200, {
      ...selectSessionHistory(world.context, params.has("cursor") ? JSON.parse(params.get("cursor")) : null),
      sessionId: decodeURIComponent(m[1]),
      leafId: null,
      live: null,
    });
  }
  if ((m = u.match(/\/api\/sessions\/([^/?#]+)/))) {
    // The contract under test: NO `context` key on a long transcript.
    return jsonResponse(200, {
      sessionId: decodeURIComponent(m[1]),
      filePath: "/fixture/long.jsonl",
      tree: [],
      leafId: null,
    });
  }
  if (/^\/api\/models/.test(u)) return jsonResponse(200, { models: {}, modelList: [], defaultModel: null });
  if ((m = u.match(/\/api\/agent\/([^/?#]+)/))) {
    return jsonResponse(200, { running: false, state: {} });
  }
  if (/subagents/.test(u)) return jsonResponse(200, { subagents: [] });
  return jsonResponse(404, {});
}

const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: {
    "@/components/ui/toast": fileURLToPath(new URL("./__fixtures__/toast-stub.mjs", import.meta.url)),
    "@/": fileURLToPath(new URL("../", import.meta.url)),
  },
});
const { useAgentSession } = await jiti.import("../hooks/useAgentSession.ts");
const { selectSessionHistory } = await jiti.import("@/lib/session-sync");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function settle(ms = 150) {
  await act(async () => { await sleep(ms); });
}

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
  world.context = longContext();
  world.tailFetches = 0;
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

test("a session longer than one page, opened cold, renders instead of throwing", async () => {
  const { result, unmount } = renderHook(() => useAgentSession({
    session: {
      id: LONG_SESSION,
      path: "",
      cwd: "/workspace",
      name: "long session",
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:00:00.000Z",
      messageCount: 240,
      firstMessage: "question 0",
    },
    newSessionCwd: null,
  }));
  await settle();

  assert.equal(result.current.error, null, "a long session must not surface a load error");
  assert.ok(result.current.messages.length > 0, "the seeded tail must actually reach the view");
  // A window, not the whole thing: entryIds and messages stay aligned even though
  // the seed came from a bounded page.
  assert.equal(result.current.messages.length, result.current.entryIds.length);
  unmount();
});

test("the seed is asked for the tail explicitly, not the whole transcript", async () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return original(url);
  };
  try {
    renderHook(() => useAgentSession({
      session: {
        id: LONG_SESSION, path: "", cwd: "/workspace", name: "long session",
        created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z",
        messageCount: 240, firstMessage: "question 0",
      },
      newSessionCwd: null,
    }));
    await settle();
  } finally {
    globalThis.fetch = original;
  }
  const seed = seen.find((u) => u.includes("/context") && u.includes("sync=1"));
  assert.ok(seed, "a bodyless session must be seeded from /context?sync=1");
  assert.match(seed, /tail=1/, "the seed must ask for the tail, so a long transcript loads in one page");
});