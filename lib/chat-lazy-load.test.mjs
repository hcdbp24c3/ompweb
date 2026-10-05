import test from "node:test";
import assert from "node:assert/strict";

async function loadSubject() {
  return import("./chat-lazy-load.ts");
}

test("shows only the last visible render items", async () => {
  const { getVisibleRenderWindow } = await loadSubject();
  assert.deepEqual(getVisibleRenderWindow(200, 50), { startIndex: 150, hasMore: true });
});

test("shows all render items when the visible count reaches the total", async () => {
  const { getVisibleRenderWindow } = await loadSubject();
  assert.deepEqual(getVisibleRenderWindow(30, 50), { startIndex: 0, hasMore: false });
  assert.deepEqual(getVisibleRenderWindow(50, 50), { startIndex: 0, hasMore: false });
  assert.deepEqual(getVisibleRenderWindow(0, 50), { startIndex: 0, hasMore: false });
});

test("continues paging when render items outnumber source messages", async () => {
  const { getNextVisibleCount, getVisibleRenderWindow } = await loadSubject();
  let visibleCount = 50;

  visibleCount = getNextVisibleCount(visibleCount);
  assert.deepEqual(getVisibleRenderWindow(120, visibleCount), { startIndex: 20, hasMore: true });

  visibleCount = getNextVisibleCount(visibleCount);
  assert.deepEqual(getVisibleRenderWindow(120, visibleCount), { startIndex: 0, hasMore: false });
});

test("restores the viewport after prepending content", async () => {
  const { captureScrollDistance, restoreScrollTop } = await loadSubject();
  const savedDistance = captureScrollDistance(2000, 500);

  assert.equal(savedDistance, 1500);
  assert.equal(restoreScrollTop(2500, savedDistance), 1000);
});

test("restores top and bottom boundary positions", async () => {
  const { captureScrollDistance, restoreScrollTop } = await loadSubject();
  assert.equal(restoreScrollTop(3000, captureScrollDistance(2000, 0)), 1000);
  assert.equal(restoreScrollTop(3000, captureScrollDistance(2000, 2000)), 3000);
});

test("a scroll-up still asks for older entries after every loaded message is rendered", async () => {
  // The bug this pins: with 200 loaded and visibleCount grown to 200 the render
  // window has nothing left to hide, so a sentinel driven only by the local
  // count stops firing after four pages and nothing fetches entry 201.
  const { historyLoadAction, shouldOfferHistoryLoad } = await loadSubject();
  assert.equal(historyLoadAction(false, true), "fetch-older-page");
  assert.equal(shouldOfferHistoryLoad(false, true), true, "the banner must stay mounted for server-side history");
  assert.equal(historyLoadAction(false, false), "none");
  assert.equal(shouldOfferHistoryLoad(false, false), false);

  // Before the window covers everything, a page read is still the better move:
  // extending the render window can only reveal entries already in memory.
  assert.equal(historyLoadAction(true, true), "fetch-older-page");
  assert.equal(historyLoadAction(true, false), "extend-render-window");
});

test("a prepend grows the render window, an append does not, and a replace restarts it", async () => {
  const { transcriptChange } = await loadSubject();
  const tail = "e199";
  assert.equal(transcriptChange({ head: "e0", tail, length: 200 }, { head: "e-200", tail, length: 400 }), "prepend");
  assert.equal(transcriptChange({ head: "e0", tail, length: 200 }, { head: "e0", tail: "e200", length: 201 }), "append");
  assert.equal(transcriptChange({ head: "e0", tail, length: 200 }, { head: "a0", tail: "z9", length: 12 }), "replace");
  assert.equal(transcriptChange({ head: "e0", tail, length: 200 }, { head: "e0", tail, length: 200 }), "unchanged");
  // A page read that hands back the same window (nothing was prepended).
  assert.equal(transcriptChange({ head: "e0", tail, length: 200 }, { head: "e0", tail, length: 100 }), "replace");
});

test("a prepended page grows the render window by its own size, a replacement restarts it", async () => {
  const { visibleCountAfterChange } = await loadSubject();
  // 200 loaded, window at 50 → a 200-entry page must land inside the window.
  assert.equal(visibleCountAfterChange("prepend", 50, 200, 400), 250);
  // An append needs no growth: new messages enter an end-anchored window already,
  // and growing it would slide the messages the user is reading out of sight.
  assert.equal(visibleCountAfterChange("append", 50, 200, 201), null);
  assert.equal(visibleCountAfterChange("unchanged", 50, 200, 200), null);
  assert.equal(visibleCountAfterChange("replace", 250, 200, 3), 50);
});
