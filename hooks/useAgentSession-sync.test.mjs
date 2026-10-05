import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, { alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) } });
const { createSessionCatchUp } = await jiti.import("./useAgentSession-sync.ts");

const windowContext = (ids) => ({
  messages: ids.map((id) => ({ role: "user", content: id })),
  entryIds: ids,
  thinkingLevel: "off",
  model: null,
  todoPhases: [],
});

/** Minimal stand-in for the paged read the client issues on a scroll-up. */
function pageResponder(responses, seen) {
  return (url) => {
    const params = new URL(url, "http://localhost").searchParams;
    const raw = params.get("cursor");
    seen.push({ tail: params.get("tail"), cursor: raw ? JSON.parse(raw) : null });
    const next = responses.shift();
    if (!next) return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
    if (next.reject) return Promise.resolve({ ok: false, status: next.reject, json: async () => ({}) });
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        sessionId: "s1", leafId: null, live: null,
        mode: "prepend", baseEntryId: null, hasMore: false, hasMoreBefore: false, total: 0,
        ...next,
        context: windowContext(next.ids),
      }),
    });
  };
}

test("a newer user delivery cannot block recovery of an unrelated assistant partial", async (t) => {
  const context = { messages: [], entryIds: [], thinkingLevel: "off", model: null, todoPhases: [] };
  let displayed = "visible before the gap";
  let release;
  let started;
  const requested = new Promise((resolve) => { started = resolve; });
  t.mock.method(globalThis, "fetch", () => new Promise((resolve) => {
    release = () => resolve({ ok: true, json: async () => ({
      sessionId: "s1", mode: "append", baseEntryId: null, context,
      cursor: { firstEntryId: null, lastEntryId: null }, hasMore: false, leafId: null,
      live: {
        cursor: { streamId: "stream", sequence: 2 }, isStreaming: true, isPromptRunning: true, isCompacting: false,
        streamingMessage: { role: "assistant", content: [{ type: "text", text: "recovered partial" }] }, toolEvents: [],
      },
    }) });
    started();
  }));
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "same-run", history() {}, subscribe: () => false,
    live(snapshot, fields) { if (fields.message) displayed = snapshot.streamingMessage.content[0].text; },
  });
  catchUp.seed(context);
  catchUp.observe({ type: "connected", web: { streamId: "stream", sequence: 1 } });
  const pending = catchUp.request();
  await requested;
  catchUp.observe({ type: "message_end", message: { role: "user", content: "steering" }, web: { streamId: "stream", sequence: 3 } });
  release();
  await pending;
  assert.equal(displayed, "recovered partial");
});

test("a held full response cannot resurrect truncated entries and fresh catch-up recovers later appends", async (t) => {
  let displayed;
  let requests = 0;
  let release;
  let started;
  const following = new Promise((resolve) => { started = resolve; });
  const context = (ids) => ({
    messages: ids.map((id) => ({ role: "user", content: id })),
    entryIds: ids, thinkingLevel: "off", model: null, todoPhases: [],
  });
  t.mock.method(globalThis, "fetch", (url) => {
    requests += 1;
    const page = (ids, mode, baseEntryId) => ({ ok: true, json: async () => ({
      sessionId: "s1", mode, baseEntryId, context: context(ids),
      cursor: { firstEntryId: "a", lastEntryId: ids.at(-1) },
      hasMore: false, leafId: ids.at(-1), live: null,
    }) });
    if (requests === 1) return Promise.resolve(page(["a", "b"], "replace", null));
    assert.equal(JSON.parse(new URL(url, "http://localhost").searchParams.get("cursor")).lastEntryId, "b");
    return new Promise((resolve) => {
      release = () => resolve(page(["d"], "append", "b"));
      started();
    });
  });
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "same-view",
    history(next) { displayed = next; }, live() {}, subscribe: () => false,
  });
  catchUp.seed(context(["a", "b", "c"]));
  const fullReadPosition = catchUp.position();
  await catchUp.request();
  assert.deepEqual(displayed.entryIds, ["a", "b"]);
  catchUp.seed(context(["a", "b", "c"]), fullReadPosition);
  assert.deepEqual(displayed.entryIds, ["a", "b"]);
  await following;
  release();
  await new Promise(setImmediate);
  assert.deepEqual(displayed.entryIds, ["a", "b", "d"]);
  assert.equal(requests, 2);
});

test("a tail-first seed records the server's window so a scroll-up knows to page", () => {
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "view", history() {}, live() {}, subscribe: () => false,
  });
  catchUp.seed(windowContext(["e800", "e999"]), null, { hasMoreBefore: true, total: 1000 });

  assert.deepEqual(catchUp.window(), { older: true, total: 1000 });
  assert.equal(catchUp.partial(), true, "entries outside the window must be visible to the reconciler");
  assert.equal(catchUp.historySession(), "s1");
});

test("a whole-transcript seed has no older page and is not partial", () => {
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "view", history() {}, live() {}, subscribe: () => false,
  });
  catchUp.seed(windowContext(["a", "b"]));

  assert.deepEqual(catchUp.window(), { older: false, total: 2 });
  assert.equal(catchUp.partial(), false);
});

test("a backwards page prepends and leaves the cursor on the oldest loaded entry", async (t) => {
  // A 6-entry path paged 2 at a time: the window is the newest page, so every
  // assertion below is about real totals rather than a 1000-entry fiction.
  const ids = ["e0", "e1", "e2", "e3", "e4", "e5"];
  const seen = [];
  t.mock.method(globalThis, "fetch", pageResponder([
    { ids: ["e2", "e3"], hasMoreBefore: true, total: 6, cursor: { firstEntryId: "e0", lastEntryId: "e3" } },
  ], seen));
  let displayed;
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "view", history(next) { displayed = next; }, live() {}, subscribe: () => false,
  });
  catchUp.seed(windowContext(["e4", "e5"]), null, { hasMoreBefore: true, total: 6 });

  assert.deepEqual(catchUp.window(), { older: true, total: 6 });
  assert.equal(await catchUp.pageBackwards(), true);
  assert.deepEqual(displayed.entryIds, ["e2", "e3", "e4", "e5"]);
  assert.equal(displayed.messages.length, 4, "the parallel array stays in lockstep");
  // The trap this task is named for: the cursor is the oldest LOADED entry, so
  // the next backwards page anchors there instead of at the whole path's head.
  assert.deepEqual(catchUp.position(), { firstEntryId: "e2", lastEntryId: "e5" });
  assert.deepEqual(seen, [{
    tail: null,
    cursor: { firstEntryId: "e4", lastEntryId: "e5", anchorEntryId: "e4", direction: "backward" },
  }], "the anchor is the window's own head, not the server cursor it was seeded from");
  assert.deepEqual(catchUp.window(), { older: true, total: 6 });

  // A second page anchors one page earlier, proving the cursor advanced.
  t.mock.restoreAll();
  seen.length = 0;
  t.mock.method(globalThis, "fetch", pageResponder([
    { ids: ["e0", "e1"], hasMoreBefore: false, total: 6, cursor: { firstEntryId: "e0", lastEntryId: "e1" } },
  ], seen));
  assert.equal(await catchUp.pageBackwards(), true);
  assert.deepEqual(displayed.entryIds, ids);
  assert.deepEqual(seen[0].cursor, { firstEntryId: "e2", lastEntryId: "e5", anchorEntryId: "e2", direction: "backward" });
  assert.deepEqual(catchUp.window(), { older: false, total: 6 });
  assert.equal(catchUp.partial(), false, "a window covering the whole path is no longer partial");
});

test("a backwards read is refused without a request once nothing older remains", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", pageResponder([], seen));
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "view", history() {}, live() {}, subscribe: () => false,
  });
  catchUp.seed(windowContext(["a", "b"]));

  assert.equal(await catchUp.pageBackwards(), false);
  assert.deepEqual(seen, [], "a session that fits in one page must not ask for older entries");
});

test("a backwards page that is not a prepend re-reads the newest page instead of merging", async (t) => {
  const seen = [];
  // The anchor left the selected path (compaction / a view switch), so the page
  // comes back as a `replace` — the oldest entries, not the ones before the window.
  t.mock.method(globalThis, "fetch", pageResponder([
    { ids: ["e0", "e1"], mode: "replace", hasMoreBefore: false, total: 2, cursor: { firstEntryId: "e0", lastEntryId: "e1" } },
    { ids: ["e900", "e999"], mode: "replace", hasMoreBefore: false, total: 2, cursor: { firstEntryId: "e0", lastEntryId: "e999" } },
  ], seen));
  let displayed;
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "view", history(next) { displayed = next; }, live() {}, subscribe: () => false,
  });
  catchUp.seed(windowContext(["e800", "e999"]), null, { hasMoreBefore: true, total: 1000 });

  assert.equal(await catchUp.pageBackwards(), false);
  assert.deepEqual(seen.map((s) => s.tail), [null, "1"], "a stale anchor falls back to the tail read");
  assert.deepEqual(displayed.entryIds, ["e900", "e999"], "never the oldest page spliced onto the window");
  assert.deepEqual(catchUp.window(), { older: false, total: 2 });
});

test("a backwards page whose window moved underneath it is dropped", async (t) => {
  let release;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let requests = 0;
  t.mock.method(globalThis, "fetch", () => {
    requests += 1;
    return new Promise((resolve) => {
      release = () => resolve({
        ok: true,
        json: async () => ({
          sessionId: "s1", leafId: null, live: null, mode: "prepend", baseEntryId: "e800",
          context: windowContext(["e600"]),
          cursor: { firstEntryId: "e0", lastEntryId: "e600" }, hasMore: false, hasMoreBefore: false, total: 1000,
        }),
      });
      markStarted();
    });
  });
  let displayed;
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "view", history(next) { displayed = next; }, live() {}, subscribe: () => false,
  });
  catchUp.seed(windowContext(["e800", "e999"]), null, { hasMoreBefore: true, total: 1000 });
  const pending = catchUp.pageBackwards();
  await started;
  // A completed forward drain advances the cursor while the page is in flight.
  displayed = windowContext(["e800", "e999", "e1000"]);
  catchUp.invalidate();
  release();
  assert.equal(await pending, false);
  assert.equal(requests, 1);
  assert.deepEqual(displayed.entryIds, ["e800", "e999", "e1000"], "the overtaken page never reaches the transcript");
  assert.deepEqual(catchUp.position(), { firstEntryId: "e800", lastEntryId: "e999" }, "and never advances the cursor");
});

test("overlapping backwards reads share one request", async (t) => {
  const seen = [];
  let release;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  t.mock.method(globalThis, "fetch", () => new Promise((resolve) => {
    seen.push("request");
    markStarted();
    release = () => resolve({
      ok: true,
      json: async () => ({
        sessionId: "s1", leafId: null, live: null, mode: "prepend", baseEntryId: "e800",
        context: windowContext(["e600"]),
        cursor: { firstEntryId: "e0", lastEntryId: "e600" }, hasMore: false, hasMoreBefore: false, total: 2,
      }),
    });
  }));
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "view", history() {}, live() {}, subscribe: () => false,
  });
  catchUp.seed(windowContext(["e800", "e999"]), null, { hasMoreBefore: true, total: 1000 });

  const first = catchUp.pageBackwards();
  const second = catchUp.pageBackwards();
  await started;
  release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(seen, ["request"], "a scroll-up storm must not open one request per gesture");
});

test("selecting a new view forgets the previous window", () => {
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "view", history() {}, live() {}, subscribe: () => false,
  });
  catchUp.seed(windowContext(["e800", "e999"]), null, { hasMoreBefore: true, total: 1000 });
  catchUp.select({ leafId: "e900", includePreCompaction: false });

  assert.deepEqual(catchUp.window(), { older: false, total: 0 });
  assert.equal(catchUp.partial(), false);
  assert.equal(catchUp.historySession(), null, "another view of the same session is a different history");
});
