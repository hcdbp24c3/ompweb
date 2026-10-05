import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
  alias: { "@/": new URL("../", import.meta.url).pathname },
});
const { CommittedTranscript } = await jiti.import("./ChatWindow.tsx");

const BASE_PROPS = {
  messages: [],
  entryIds: [],
  conversationMeta: { toolResultsMap: new Map(), lastAnchorIdx: -1, visibleRefIndexByMessage: new Map() },
  messageRefs: { current: [] },
  isStreaming: false,
  sessionBusy: false,
  isNew: false,
  forkingEntryId: null,
  handleFork: () => {},
  handleNavigate: () => false,
  handleEditContent: () => {},
  modelNames: {},
  messageCwd: undefined,
  sessionId: undefined,
  toolCallsDefaultCollapsed: true,
  hideThinkingBlock: false,
  visibleCount: 200,
  nearBottom: false,
  sentinelRef: { current: null },
  handleLoadMoreClick: () => {},
};

function renderTranscript(overrides) {
  return renderToStaticMarkup(
    React.createElement(CommittedTranscript, { ...BASE_PROPS, ...overrides }),
  );
}

/** The rendered count is driven by visibleCount vs the loaded rows. */
const LOADED = Array.from({ length: 3 }, (_, i) => ({ role: "user", content: `question ${i}`, id: `m${i}` }));

// The sentinel banner is the only thing that can trigger a page read. Anchoring
// its existence on the render window alone unmounted it the moment visibleCount
// reached messages.length — which for a 200-entry window is four scrolls in, and
// then nothing ever asks the server for entry 201.
// The banner is the load-more trigger; its copy comes from
// chatWindow.scrollUpToLoad, which the default (en) locale resolves here.
const BANNER = /Scroll up to load earlier messages/;

test("the scroll-up trigger survives a window whose every loaded message is rendered", () => {
  const withOlder = renderTranscript({ messages: LOADED, entryIds: ["m0", "m1", "m2"], visibleCount: 3, hasOlderEntries: true });
  assert.match(withOlder, BANNER, "the banner must stay mounted for server-side history");

  const nothingLeft = renderTranscript({ messages: LOADED, entryIds: ["m0", "m1", "m2"], visibleCount: 3, hasOlderEntries: false });
  assert.doesNotMatch(nothingLeft, BANNER, "and must go away once neither half has more");
});

test("the scroll-up trigger also covers entries the render window is hiding", () => {
  assert.match(
    renderTranscript({ messages: LOADED, entryIds: ["m0", "m1", "m2"], visibleCount: 1, hasOlderEntries: false }),
    BANNER,
  );
});