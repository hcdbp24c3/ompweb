import assert from "node:assert/strict";
import test from "node:test";
import { historyCursor, parseHistoryCursor, selectHistoryRange, selectSessionHistory } from "./session-sync.ts";

function context(ids) {
  return {
    messages: ids.map(() => ({ role: "assistant", content: [{ type: "text", text: "Repeated answer" }], model: "test", provider: "test" })),
    entryIds: ids,
    thinkingLevel: "high",
    model: { provider: "test", modelId: "test" },
    todoPhases: [],
  };
}

test("catch-up returns only entries after the confirmed cursor, including identical messages", () => {
  const saved = context(["a", "b", "c"]);
  const page = selectSessionHistory(saved, historyCursor(context(["a"])), 200);
  assert.equal(page.mode, "append");
  assert.equal(page.baseEntryId, "a");
  assert.deepEqual(page.context.entryIds, ["b", "c"]);
  assert.deepEqual(page.context.messages, [saved.messages[1], saved.messages[2]]);
  assert.deepEqual(page.cursor, { firstEntryId: "a", lastEntryId: "c" });
  assert.equal(page.hasMore, false);
  assert.equal(page.context.thinkingLevel, "high");
});

test("pages remain contiguous while new entries are appended", () => {
  const initial = selectSessionHistory(context(["a", "b", "c", "d"]), null, 2);
  assert.equal(initial.mode, "replace");
  assert.deepEqual(initial.context.entryIds, ["a", "b"]);
  assert.equal(initial.hasMore, true);
  const next = selectSessionHistory(context(["a", "b", "c", "d", "e"]), initial.cursor, 2);
  const last = selectSessionHistory(context(["a", "b", "c", "d", "e"]), next.cursor, 2);
  assert.deepEqual([...initial.context.entryIds, ...next.context.entryIds, ...last.context.entryIds], ["a", "b", "c", "d", "e"]);
  assert.equal(next.mode, "append");
  assert.equal(last.hasMore, false);
});

test("an orphaned branch cursor replaces history instead of appending unrelated entries", () => {
  const page = selectSessionHistory(context(["root", "other"]), historyCursor(context(["root", "old-branch"])));
  assert.equal(page.mode, "replace");
  assert.deepEqual(page.context.entryIds, ["root", "other"]);
  assert.equal(page.baseEntryId, null);
});

test("compaction changes the context prefix even when the old cursor survives", () => {
  const page = selectSessionHistory(context(["summary", "kept", "new"]), historyCursor(context(["old", "kept"])));
  assert.equal(page.mode, "replace");
  assert.deepEqual(page.context.entryIds, ["summary", "kept", "new"]);
});

test("an unchanged context returns an empty delta and retains its cursor", () => {
  const cursor = historyCursor(context(["a", "b"]));
  const page = selectSessionHistory(context(["a", "b"]), cursor);
  assert.equal(page.mode, "append");
  assert.deepEqual(page.context.messages, []);
  assert.deepEqual(page.context.entryIds, []);
  assert.deepEqual(page.cursor, cursor);
});

test("empty history remains resumable and truncation produces a reset", () => {
  const empty = selectSessionHistory(context([]), null);
  assert.deepEqual(empty.cursor, { firstEntryId: null, lastEntryId: null });
  assert.equal(selectSessionHistory(context([]), empty.cursor).mode, "append");
  assert.equal(selectSessionHistory(context([]), historyCursor(context(["a"]))).mode, "replace");
  const added = selectSessionHistory(context(["a"]), empty.cursor);
  assert.equal(added.mode, "replace");
  assert.deepEqual(added.context.entryIds, ["a"]);
});

test("indexed history selection preserves cursor boundaries and rejects stale positions", () => {
  const ids = ["a", "b", "c", "d"];
  const positions = new Map(ids.map((id, index) => [id, index]));
  const cursor = { firstEntryId: "a", lastEntryId: "b" };
  const range = selectHistoryRange(ids, cursor, 1, positions);
  assert.equal(range.mode, "append");
  assert.deepEqual(ids.slice(range.start, range.end), ["c"]);
  assert.deepEqual(range.cursor, { firstEntryId: "a", lastEntryId: "c" });
  assert.equal(range.hasMore, true);
  const changed = selectHistoryRange(["a", "different", "c", "d"], cursor, 2, positions);
  assert.equal(changed.mode, "replace");
  assert.equal(changed.baseEntryId, null);
});

test("cursor parsing accepts opaque entry IDs but rejects malformed or unbounded input", () => {
  const cursor = { firstEntryId: "first-id", lastEntryId: "last-id" };
  assert.deepEqual(parseHistoryCursor(JSON.stringify(cursor)), cursor);
  assert.equal(parseHistoryCursor(null), null);
  for (const raw of ["", "[]", "null", "{}", "not-json", JSON.stringify({ firstEntryId: null, lastEntryId: "id" }), JSON.stringify({ firstEntryId: "a", lastEntryId: "x".repeat(257) }), " ".repeat(2049)]) {
    assert.throws(() => parseHistoryCursor(raw));
  }
});

const LONG_IDS = Array.from({ length: 1000 }, (_, index) => `e${index}`);
const LONG_POSITIONS = new Map(LONG_IDS.map((id, index) => [id, index]));

test("a windowed cursor appends instead of restarting at the first page", () => {
  // The client holds the newest 200 of 1000, so its cursor names its own window
  // head. Requiring the FULL list's head here is what turns every catch-up into a
  // replace and hands the browser the oldest 200.
  const windowed = { firstEntryId: "e800", lastEntryId: "e999" };

  const quiet = selectHistoryRange(LONG_IDS, windowed, 200, LONG_POSITIONS);
  assert.equal(quiet.mode, "append", "a window whose entries are all still on the path must not be discarded");
  assert.equal(quiet.baseEntryId, "e999");
  assert.equal(quiet.start, 1000);
  assert.equal(quiet.end, 1000);
  assert.equal(quiet.hasMore, false);

  const grown = selectHistoryRange([...LONG_IDS, "e1000", "e1001"], windowed, 200, LONG_POSITIONS);
  assert.equal(grown.mode, "append");
  assert.equal(grown.start, 1000);
  assert.deepEqual([...LONG_IDS, "e1000", "e1001"].slice(grown.start, grown.end), ["e1000", "e1001"]);
  // A replace would have answered start 0 — the trap this assertion exists for.
  assert.notEqual(grown.start, 0);
});

test("a windowed cursor whose head left the path replaces history", () => {
  const range = selectHistoryRange(LONG_IDS, { firstEntryId: "gone", lastEntryId: "e999" }, 200, LONG_POSITIONS);
  assert.equal(range.mode, "replace");
  assert.equal(range.baseEntryId, null);
  assert.equal(range.start, 0);
});

test("a backwards cursor returns the page immediately before its anchor", () => {
  const range = selectHistoryRange(LONG_IDS, {
    firstEntryId: "e800", lastEntryId: "e999", direction: "backward", anchorEntryId: "e800",
  }, 200, LONG_POSITIONS);

  assert.equal(range.mode, "prepend");
  assert.equal(range.start, 600);
  assert.equal(range.end, 800);
  assert.equal(range.baseEntryId, "e800", "the anchor is what the client prepends onto");
  const delivered = LONG_IDS.slice(range.start, range.end);
  assert.equal(delivered[0], "e600");
  assert.equal(delivered.at(-1), "e799");
  assert.equal(delivered.includes("e800"), false, "the anchor itself is not part of the page before it");
  assert.equal(delivered.includes("e999"), false, "no overlap with the window that asked for it");
  assert.equal(range.hasMoreBefore, true);
  assert.equal(range.hasMore, true);
  assert.equal(range.total, 1000);
});

test("a backwards cursor at the head of the path reports nothing older", () => {
  const range = selectHistoryRange(LONG_IDS, {
    firstEntryId: "e100", lastEntryId: "e999", direction: "backward", anchorEntryId: "e100",
  }, 200, LONG_POSITIONS);

  assert.equal(range.mode, "prepend");
  assert.equal(range.start, 0);
  assert.equal(range.end, 100);
  assert.equal(range.hasMoreBefore, false);
  assert.equal(range.total, 1000);
});

test("a backwards cursor with an anchor that left the path resets rather than guessing", () => {
  const range = selectHistoryRange(LONG_IDS, {
    firstEntryId: "gone", lastEntryId: "e999", direction: "backward", anchorEntryId: "gone",
  }, 200, LONG_POSITIONS);

  assert.equal(range.mode, "replace");
  assert.equal(range.baseEntryId, null);
  assert.equal(range.start, 0);
});

test("the tail cursor serves the newest page and reports the whole path's size", () => {
  const range = selectHistoryRange(LONG_IDS, { firstEntryId: null, lastEntryId: null, direction: "tail" }, 200, LONG_POSITIONS);

  assert.equal(range.mode, "replace", "an initial read has nothing to append to");
  assert.equal(range.baseEntryId, null);
  assert.equal(range.start, 800);
  assert.equal(range.end, 1000);
  assert.equal(range.hasMore, false, "there is nothing after the newest page");
  assert.equal(range.hasMoreBefore, true, "but there are older pages to scroll up to");
  assert.equal(range.total, 1000);
  assert.deepEqual(range.cursor, { firstEntryId: "e0", lastEntryId: "e999" });

  // A short history is one page, and must not report a phantom older page.
  const short = selectHistoryRange(["a", "b"], { firstEntryId: null, lastEntryId: null, direction: "tail" }, 200);
  assert.equal(short.start, 0);
  assert.equal(short.end, 2);
  assert.equal(short.hasMoreBefore, false);
  assert.equal(short.total, 2);

  const empty = selectHistoryRange([], { firstEntryId: null, lastEntryId: null, direction: "tail" }, 200);
  assert.equal(empty.mode, "replace");
  assert.deepEqual(empty.cursor, { firstEntryId: null, lastEntryId: null });
  assert.equal(empty.total, 0);
});

test("a paged session keeps the page it delivered and reports its real total", () => {
  // selectSessionHistory is the in-memory twin of the indexed reader: the server
  // slices one page out of the full context with the same rule.
  const window = context(["e800", "e801", "e999"]);
  const page = selectSessionHistory(context(LONG_IDS), historyCursor(window), 200);

  assert.equal(page.mode, "append");
  assert.deepEqual(page.context.entryIds, []);
  assert.equal(page.total, 1000);
  assert.equal(page.hasMoreBefore, true);
});

test("cursor parsing accepts the direction fields and rejects inconsistent ones", () => {
  assert.deepEqual(
    parseHistoryCursor(JSON.stringify({ firstEntryId: "e800", lastEntryId: "e999", direction: "backward", anchorEntryId: "e800" })),
    { firstEntryId: "e800", lastEntryId: "e999", direction: "backward", anchorEntryId: "e800" },
  );
  assert.deepEqual(
    parseHistoryCursor(JSON.stringify({ firstEntryId: null, lastEntryId: null, direction: "tail" })),
    { firstEntryId: null, lastEntryId: null, direction: "tail" },
  );
  // A cursor without a direction is the historical forward form.
  assert.deepEqual(
    parseHistoryCursor(JSON.stringify({ firstEntryId: "a", lastEntryId: "b", direction: "forward" })),
    { firstEntryId: "a", lastEntryId: "b" },
  );
  for (const raw of [
    // A backwards page without an anchor has no bound to page against.
    JSON.stringify({ firstEntryId: "a", lastEntryId: "b", direction: "backward" }),
    JSON.stringify({ firstEntryId: "a", lastEntryId: "b", direction: "backward", anchorEntryId: null }),
    // A forward or tail request must not smuggle an anchor past validation.
    JSON.stringify({ firstEntryId: "a", lastEntryId: "b", anchorEntryId: "a" }),
    JSON.stringify({ firstEntryId: null, lastEntryId: null, direction: "tail", anchorEntryId: "a" }),
    // The tail is a position, not a range.
    JSON.stringify({ firstEntryId: "a", lastEntryId: "b", direction: "tail" }),
    JSON.stringify({ firstEntryId: "a", lastEntryId: "b", direction: "sideways" }),
    JSON.stringify({ firstEntryId: "a", lastEntryId: "b", direction: 1 }),
    JSON.stringify({ firstEntryId: "a", lastEntryId: "b", anchorEntryId: 5 }),
    JSON.stringify({ firstEntryId: "a", lastEntryId: "b", direction: "backward", anchorEntryId: "x".repeat(257) }),
  ]) {
    assert.throws(() => parseHistoryCursor(raw), undefined, raw);
  }
});
