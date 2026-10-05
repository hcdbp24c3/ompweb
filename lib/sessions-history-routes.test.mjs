// Nothing else in the repo drives these two routes, and they are the whole of
// "a long session opens without shipping its transcript":
//   GET /api/sessions/[id]            — session metadata, transcript only on request
//   GET /api/sessions/[id]/context    — the paged read (`sync=1`), `boundary=1`, `tail=1`
// Both are asserted through the exported handlers against real session files,
// because the properties that matter (which entries arrive, in what order, and
// how many bytes leave the server) only exist end to end.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@/": new URL("../", import.meta.url).pathname } });
const { GET: getContext } = await jiti.import("../app/api/sessions/[id]/context/route.ts");
const { GET: getSession } = await jiti.import("../app/api/sessions/[id]/route.ts");
const { invalidateSessionCaches, invalidateSessionListCache } = await jiti.import("@/lib/session-reader");

const LONG_ID = "long-session";
const MESSAGE_COUNT = 5000;
const DELTA_ID = "delta-session";
const DELTA_COUNT = 600;
const SHORT_ID = "short-session";
const SHORT_COUNT = 12;
let agentDir;
let projectDir;
let deltaPath;

/** One linear path of `count` user/assistant pairs, parented to the previous entry. */
function longSession(count) {
  const entries = [];
  let parentId = null;
  for (let index = 0; index < count; index += 1) {
    const id = `e${index}`;
    const user = index % 2 === 0;
    entries.push({
      type: "message",
      id,
      parentId,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: user
        ? { role: "user", content: `question ${index} ${"q".repeat(200)}` }
        : { role: "assistant", provider: "test", model: "test-model", content: [{ type: "text", text: `answer ${index} ${"a".repeat(400)}` }] },
    });
    parentId = id;
  }
  return entries;
}

function writeSession(name, id, count) {
  const records = [
    { type: "session", version: 3, id, cwd: projectDir, timestamp: "2026-01-01T00:00:00.000Z" },
    ...longSession(count),
  ];
  const filePath = join(projectDir, `2026-01-01_${name}.jsonl`);
  writeFileSync(filePath, `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return filePath;
}

before(() => {
  agentDir = mkdtempSync(join(tmpdir(), "omp-web-history-routes-"));
  projectDir = join(agentDir, "sessions", "-project");
  mkdirSync(projectDir, { recursive: true });
  writeSession("long", LONG_ID, MESSAGE_COUNT);
  writeSession("short", SHORT_ID, SHORT_COUNT);
  deltaPath = writeSession("delta", DELTA_ID, DELTA_COUNT);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  invalidateSessionCaches();
  invalidateSessionListCache();
});

after(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  invalidateSessionCaches();
  rmSync(agentDir, { recursive: true, force: true });
});

async function get(pathname, query = {}, id = LONG_ID) {
  const url = new URL(`http://localhost/api/sessions/${id}${pathname}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await getContext(new Request(url), { params: Promise.resolve({ id }) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, bytes: text.length };
}

const cursorParam = (cursor) => JSON.stringify(cursor);

test("the initial paged read serves the newest page, not the oldest", async () => {
  const { status, body } = await get("/context", { sync: "1", tail: "1", deferThinking: "1", deferMedia: "1" });

  assert.equal(status, 200);
  assert.equal(body.mode, "replace", "a first read has no history to append to");
  assert.equal(body.total, MESSAGE_COUNT, "the true total is reported, not the window's size");
  assert.ok(body.context.entryIds.length <= 200, `page held ${body.context.entryIds.length} entries`);
  assert.equal(body.context.entryIds[0], `e${MESSAGE_COUNT - 200}`, "the page must be the NEWEST one");
  assert.equal(body.context.entryIds.at(-1), `e${MESSAGE_COUNT - 1}`);
  assert.equal(body.hasMore, false, "nothing follows the newest page");
  assert.equal(body.hasMoreBefore, true, "but older pages exist to scroll up to");
  assert.equal(body.sessionId, LONG_ID);
  assert.equal(body.leafId, `e${MESSAGE_COUNT - 1}`);
});

test("a paged read moves materially fewer bytes than the whole transcript", async () => {
  const page = await get("/context", { sync: "1", tail: "1", deferThinking: "1", deferMedia: "1" });
  const whole = await get("/context", { deferThinking: "1", deferMedia: "1" });

  assert.equal(whole.body.context.entryIds.length, MESSAGE_COUNT);
  assert.ok(
    page.bytes * 5 < whole.bytes,
    `page was ${page.bytes}B against a ${whole.bytes}B transcript — that is not materially smaller`,
  );
});

test("boundary reports every entry id without any bodies", async () => {
  const { status, body, bytes } = await get("/context", { boundary: "1" });

  assert.equal(status, 200);
  assert.equal(body.entryIds.length, MESSAGE_COUNT);
  assert.equal(body.entryIds[0], "e0");
  // `in`, not a comparison: a failing assert.equal would stringify the whole
  // transcript into the failure message and OOM the runner.
  assert.equal("messages" in body, false, "a boundary probe must not carry message bodies");
  const whole = await get("/context", { deferThinking: "1", deferMedia: "1" });
  assert.ok(bytes < whole.bytes / 20, `${bytes}B against a ${whole.bytes}B transcript`);
});

test("a windowed cursor is served the newest page again rather than an empty delta", async () => {
  const windowed = { firstEntryId: `e${MESSAGE_COUNT - 200}`, lastEntryId: `e${MESSAGE_COUNT - 1}` };

  const { status, body } = await get("/context", { sync: "1", cursor: cursorParam(windowed) });

  assert.equal(status, 200);
  // A replace answers `baseEntryId: null` and the first 200 entries; neither can
  // pass these two assertions, which is the point of the shape.
  assert.equal(body.mode, "append", "a window whose entries are all still on the path must not be discarded");
  assert.equal(body.baseEntryId, windowed.lastEntryId);
  assert.deepEqual(body.context.entryIds, []);
  assert.equal(body.hasMore, false);
});

test("a windowed cursor appends only what was written after its window", async () => {
  const initial = await get("/context", { sync: "1", tail: "1" }, DELTA_ID);
  const loaded = initial.body.context.entryIds;
  const windowed = { firstEntryId: loaded[0], lastEntryId: loaded.at(-1) };
  assert.equal(loaded.length, 200);

  appendFileSync(deltaPath, `${JSON.stringify({
    type: "message", id: "e600", parentId: `e${DELTA_COUNT - 1}`, timestamp: "2026-01-02T00:00:00.000Z",
    message: { role: "user", content: "written after the window" },
  })}\n`);

  const { body } = await get("/context", { sync: "1", cursor: cursorParam(windowed) }, DELTA_ID);

  assert.equal(body.mode, "append");
  assert.deepEqual(body.context.entryIds, ["e600"], "a replace would have re-sent the oldest 200 instead");
  assert.equal(body.context.messages[0].content, "written after the window");
  assert.equal(body.total, DELTA_COUNT + 1);
});

test("a backwards page returns the entries immediately before its anchor", async () => {
  const anchor = `e${MESSAGE_COUNT - 200}`;

  const { status, body } = await get("/context", {
    sync: "1",
    cursor: cursorParam({ firstEntryId: anchor, lastEntryId: `e${MESSAGE_COUNT - 1}`, direction: "backward", anchorEntryId: anchor }),
  });

  assert.equal(status, 200);
  assert.equal(body.mode, "prepend");
  assert.equal(body.baseEntryId, anchor);
  const delivered = body.context.entryIds;
  assert.equal(delivered.length, 200);
  assert.equal(body.hasMoreBefore, true);
  assert.equal(body.hasMore, true);
  assert.equal(body.total, MESSAGE_COUNT);
  assert.equal(body.context.messages.length, delivered.length);
  assert.equal(delivered.includes(anchor), false, "the anchor belongs to the window that asked for it");
  assert.deepEqual(
    delivered.map((id) => [id, Number(id.slice(1)) - (MESSAGE_COUNT - 400)]),
    Array.from({ length: 200 }, (_, index) => [`e${MESSAGE_COUNT - 400 + index}`, index]),
    "the 200 entries immediately before the anchor, in order",
  );
});

test("backwards pages tile the path without overlap", async () => {
  const pages = [];
  let anchor = `e${MESSAGE_COUNT - 200}`;
  for (let page = 0; page < 3; page += 1) {
    const { body } = await get("/context", {
      sync: "1",
      cursor: cursorParam({ firstEntryId: anchor, lastEntryId: `e${MESSAGE_COUNT - 1}`, direction: "backward", anchorEntryId: anchor }),
    });
    assert.equal(body.mode, "prepend");
    pages.unshift(...body.context.entryIds); // the client prepends each page
    anchor = body.context.entryIds[0];
  }
  const seen = pages.flat();
  assert.equal(new Set(seen).size, seen.length, "pages must not overlap");
  assert.deepEqual(seen, Array.from({ length: 600 }, (_, index) => `e${MESSAGE_COUNT - 800 + index}`));
  assert.equal(seen.at(-1), `e${MESSAGE_COUNT - 201}`, "and must butt up against the window that asked, without overlapping it");
});

test("a backwards page at the start of the path reports nothing older", async () => {
  const { body } = await get("/context", {
    sync: "1",
    cursor: cursorParam({ firstEntryId: "e5", lastEntryId: "e199", direction: "backward", anchorEntryId: "e5" }),
  });

  assert.equal(body.mode, "prepend");
  assert.deepEqual(body.context.entryIds, ["e0", "e1", "e2", "e3", "e4"]);
  assert.equal(body.hasMoreBefore, false);
});

test("a backwards page with a stale anchor resets instead of guessing a page", async () => {
  const { body } = await get("/context", {
    sync: "1",
    cursor: cursorParam({ firstEntryId: "gone", lastEntryId: "gone-too", direction: "backward", anchorEntryId: "gone" }),
  });

  assert.equal(body.mode, "replace");
  assert.equal(body.baseEntryId, null);
  assert.equal(body.context.entryIds[0], "e0", "a stale anchor bounds nothing, so history restarts");
});

test("a plain sync read still starts at the oldest entry", async () => {
  // The forward drain contract: a cursor-less sync read is the first page, so the
  // loop that walks a whole transcript forward keeps working unchanged.
  const { body } = await get("/context", { sync: "1" });

  assert.equal(body.mode, "replace");
  assert.equal(body.context.entryIds[0], "e0");
  assert.equal(body.hasMore, true);
  assert.equal(body.total, MESSAGE_COUNT);
});

test("a malformed tail flag is rejected with a stable code", async () => {
  for (const tail of ["0", "yes", "2"]) {
    const { status, body } = await get("/context", { sync: "1", tail });
    assert.equal(status, 400, tail);
    assert.equal(body.code, "invalid_sync_tail", tail);
  }
});

test("boundary mode refuses to be combined with a paged read", async () => {
  const { status, body } = await get("/context", { boundary: "1", tail: "1" });
  assert.equal(status, 400);
  assert.equal(body.code, "invalid_boundary_options");
});

test("an inconsistent backwards cursor is a 400, not a silent full reset", async () => {
  const { status, body } = await get("/context", {
    sync: "1",
    cursor: cursorParam({ firstEntryId: "a", lastEntryId: "b", direction: "backward" }),
  });
  assert.equal(status, 400);
  assert.equal(body.code, "invalid_sync_cursor");
});

test("the session route sends the transcript only when a caller asks for it", async () => {
  const call = async (id = LONG_ID, query = {}) => {
    const url = new URL(`http://localhost/api/sessions/${id}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await getSession(new Request(url), { params: Promise.resolve({ id }) });
    return { status: response.status, body: await response.json() };
  };

  const paged = await call(LONG_ID, { deferThinking: "1", deferMedia: "1" });
  assert.equal(paged.status, 200);
  // `in`, not a comparison: a failing assert.equal would stringify the whole
  // transcript into the failure message and OOM the runner.
  assert.equal("context" in paged.body, false, "an open must not ship a transcript it is about to page");
  assert.equal(paged.body.sessionId, LONG_ID);
  assert.ok(Array.isArray(paged.body.tree));
  assert.equal(paged.body.leafId, `e${MESSAGE_COUNT - 1}`);
  assert.equal(paged.body.info.messageCount, MESSAGE_COUNT);

  const whole = await call(LONG_ID, { context: "1", deferThinking: "1", deferMedia: "1" });
  assert.equal(whole.status, 200);
  assert.equal(whole.body.context.entryIds.length, MESSAGE_COUNT, "a non-lazy flow still gets the full body");
  assert.equal(whole.body.context.messages.length, MESSAGE_COUNT);
  assert.deepEqual(whole.body.context.entryIds[0], "e0");
});

test("a session that fits in one page is still served whole by default", async () => {
  const url = new URL(`http://localhost/api/sessions/${SHORT_ID}`);
  url.searchParams.set("deferThinking", "1");
  url.searchParams.set("deferMedia", "1");
  const response = await getSession(new Request(url), { params: Promise.resolve({ id: SHORT_ID }) });
  const body = await response.json();

  assert.equal(response.status, 200);
  // Every ordinary session is this shape, so it must keep costing one request:
  // paging it would add a round trip and change nothing about the bytes sent.
  assert.equal(body.context.entryIds.length, SHORT_COUNT);
  assert.equal(body.context.messages.length, SHORT_COUNT);
  assert.deepEqual(body.context.entryIds[0], "e0");
  assert.equal(body.info.messageCount, SHORT_COUNT);
});