export const VISIBLE_PAGE_SIZE = 50;

export function getVisibleRenderWindow(totalCount: number, visibleCount: number): {
  startIndex: number;
  hasMore: boolean;
} {
  const clampedVisibleCount = Math.min(Math.max(visibleCount, 0), Math.max(totalCount, 0));
  const startIndex = Math.max(0, totalCount - clampedVisibleCount);
  return { startIndex, hasMore: startIndex > 0 };
}

export function getNextVisibleCount(currentVisibleCount: number, pageSize = VISIBLE_PAGE_SIZE): number {
  return currentVisibleCount + pageSize;
}

export function captureScrollDistance(scrollHeight: number, scrollTop: number): number {
  return scrollHeight - scrollTop;
}

export function restoreScrollTop(scrollHeight: number, savedDistance: number): number {
  return Math.max(0, scrollHeight - savedDistance);
}

/**
 * What a scroll-up at the sentinel must do.
 *
 * `extend-render-window` only ever reveals entries already in memory, so once the
 * transcript is paged it stops being the answer: with 200 loaded and
 * `visibleCount` grown to 200 the local count has nothing left to give, and a
 * sentinel driven by it alone would stop firing after four pages while the server
 * still holds thousands of entries. The decision therefore takes the server's
 * word for it, not the local message count.
 */
export type HistoryLoadAction = "extend-render-window" | "fetch-older-page" | "none";

export function historyLoadAction(hasHiddenRendered: boolean, hasOlderEntries: boolean): HistoryLoadAction {
  if (hasOlderEntries) return "fetch-older-page";
  if (hasHiddenRendered) return "extend-render-window";
  return "none";
}

/** The sentinel banner stays mounted while either half of the window has more. */
export function shouldOfferHistoryLoad(hasHiddenRendered: boolean, hasOlderEntries: boolean): boolean {
  return hasHiddenRendered || hasOlderEntries;
}

export interface TranscriptWindow {
  head: string | null;
  tail: string | null;
  length: number;
}

/**
 * How a transcript update moved, from the two boundaries of the loaded window.
 *
 * Prepending is detected by the tail staying put while the head moves back, which
 * is what a backwards page does; an append keeps the head. Anything that moves
 * both (a compaction, a branch switch, a view change) replaced the window and
 * cannot be folded into a growth.
 */
export function transcriptChange(previous: TranscriptWindow, next: TranscriptWindow): "append" | "prepend" | "replace" | "unchanged" {
  if (previous.head === next.head && previous.tail === next.tail && previous.length === next.length) return "unchanged";
  if (previous.tail !== null && previous.tail === next.tail && previous.head !== next.head && next.length > previous.length) return "prepend";
  if (previous.head !== null && previous.head === next.head && previous.tail !== next.tail) return "append";
  return "replace";
}

/**
 * The render-window size a transcript change implies, or null to leave it alone.
 *
 * A prepended page has to grow the window by its own size or its rows sit above
 * an end-anchored window that never shows them; a replacement starts over. An
 * append needs neither — new messages enter an end-anchored window on their own,
 * and growing it there would slide the viewed messages out of sight.
 */
export function visibleCountAfterChange(
  change: ReturnType<typeof transcriptChange>,
  visibleCount: number,
  previousLength: number,
  nextLength: number,
): number | null {
  if (change === "prepend") return visibleCount + (nextLength - previousLength);
  if (change === "replace") return VISIBLE_PAGE_SIZE;
  return null;
}
