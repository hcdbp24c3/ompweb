import type { AgentMessage, SessionContext } from "./types";

/** Which end of the display history a page extends. */
export type SessionHistoryDirection = "forward" | "backward" | "tail";

/**
 * Durable display-history position, scoped to one session and selected view.
 *
 * `firstEntryId`/`lastEntryId` name the entries the caller has loaded, which is
 * NOT necessarily the whole path: a client that opened a long session holds one
 * window. `direction` and `anchorEntryId` request a page relative to that
 * position — `backward` pages the entries before `anchorEntryId`, `tail` asks for
 * the newest page outright. They are bounded, opaque ids: a cursor never
 * authorizes a session or a file path.
 */
export interface SessionHistoryCursor {
  firstEntryId: string | null;
  lastEntryId: string | null;
  anchorEntryId?: string | null;
  direction?: SessionHistoryDirection;
}

/** Ordering within one web-owned RPC process; resets when that process changes. */
export interface SessionStreamCursor {
  streamId: string;
  sequence: number;
}

export interface SessionLiveToolEvent {
  type: "tool_execution_start" | "tool_execution_update";
  toolCallId: string;
  [key: string]: unknown;
}

export interface SessionLiveSnapshot {
  cursor: SessionStreamCursor;
  isStreaming: boolean;
  isPromptRunning: boolean;
  isCompacting: boolean;
  streamingMessage: Partial<AgentMessage> | null;
  toolEvents: SessionLiveToolEvent[];
  /** Positive run-scoped evidence survives message_end's delayed file write. */
  responseObserved?: boolean;
}

export interface SessionHistoryPage {
  mode: "append" | "prepend" | "replace";
  baseEntryId: string | null;
  context: SessionContext;
  cursor: SessionHistoryCursor;
  /** Entries remain after this page; the forward drain reads until this is false. */
  hasMore: boolean;
  /** Entries remain before this page; a tail-first client pages until this is false. */
  hasMoreBefore: boolean;
  /** Entry count of the whole selected path, so a windowed client is never blind. */
  total: number;
}

export interface SessionHistoryRange extends Omit<SessionHistoryPage, "context"> {
  start: number;
  end: number;
}

export interface SessionSyncResponse extends SessionHistoryPage {
  sessionId: string;
  leafId: string | null;
  /** Null for a file-only session or a view pinned to a historical branch. */
  live: SessionLiveSnapshot | null;
}

export const MAX_SYNC_MESSAGES = 200;
const MAX_HISTORY_CURSOR_BYTES = 2048;
const MAX_ENTRY_ID_LENGTH = 256;

export function historyCursor(context: Pick<SessionContext, "entryIds">): SessionHistoryCursor {
  return {
    firstEntryId: context.entryIds[0] ?? null,
    lastEntryId: context.entryIds.at(-1) ?? null,
  };
}

/** Decode only bounded IDs; a cursor never authorizes a session or a file path. */
export function parseHistoryCursor(raw: string | null): SessionHistoryCursor | null {
  if (raw === null) return null;
  if (raw.length > MAX_HISTORY_CURSOR_BYTES) throw new Error("Invalid history cursor");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid history cursor");
  const cursor = value as Record<string, unknown>;
  const validId = (id: unknown): id is string | null => id === null || (typeof id === "string" && id.length > 0 && id.length <= MAX_ENTRY_ID_LENGTH);
  const anchorEntryId = cursor.anchorEntryId === undefined ? null : cursor.anchorEntryId;
  const direction = cursor.direction === undefined ? "forward" : cursor.direction;
  if (!validId(cursor.firstEntryId) || !validId(cursor.lastEntryId)
    || !validId(anchorEntryId)
    || (cursor.firstEntryId === null) !== (cursor.lastEntryId === null)
    || (direction !== "forward" && direction !== "backward" && direction !== "tail")
    // A backwards page is bounded by its anchor, and nothing else carries one.
    || (direction === "backward") !== (anchorEntryId !== null)
    // `tail` is a position at the end of the path, not a range within it.
    || (direction === "tail" && cursor.firstEntryId !== null)) {
    throw new Error("Invalid history cursor");
  }
  if (direction === "forward" && anchorEntryId === null) {
    return { firstEntryId: cursor.firstEntryId, lastEntryId: cursor.lastEntryId };
  }
  return {
    firstEntryId: cursor.firstEntryId,
    lastEntryId: cursor.lastEntryId,
    ...(anchorEntryId !== null ? { anchorEntryId } : {}),
    direction,
  };
}

/** Page the selected display path; an invalidated branch/compaction cursor resets it. */
export function selectSessionHistory(
  context: SessionContext,
  cursor: SessionHistoryCursor | null,
  limit = MAX_SYNC_MESSAGES,
): SessionHistoryPage {
  const { start, end, ...page } = selectHistoryRange(context.entryIds, cursor, limit);
  return {
    ...page,
    context: { ...context, messages: context.messages.slice(start, end), entryIds: context.entryIds.slice(start, end) },
  };
}

/** Indexed readers can locate a cursor without scanning the delivered prefix again. */
export function selectHistoryRange(
  entryIds: readonly string[],
  cursor: SessionHistoryCursor | null,
  limit = MAX_SYNC_MESSAGES,
  positions?: ReadonlyMap<string, number>,
): SessionHistoryRange {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SYNC_MESSAGES) throw new RangeError("Invalid history page limit");
  const at = (id: string): number => positions ? positions.get(id) ?? -1 : entryIds.indexOf(id);
  const firstEntryId = entryIds[0] ?? null;
  // The returned cursor always names the whole path's head and this page's last
  // entry. An empty page reuses the previous boundary, so a quiet session stays
  // resumable; a client that merged a window recomputes its own with historyCursor.
  const page = (start: number, end: number) => ({
    start,
    end,
    hasMore: end < entryIds.length,
    hasMoreBefore: start > 0,
    total: entryIds.length,
    cursor: { firstEntryId, lastEntryId: entryIds[end - 1] ?? null },
  });

  if (cursor?.direction === "backward") {
    const anchorIndex = cursor.anchorEntryId ? at(cursor.anchorEntryId) : -1;
    // An anchor that left the selected path bounds nothing, so it gets the same
    // full reset an orphaned forward cursor gets rather than a guessed page.
    if (anchorIndex >= 0) {
      const end = anchorIndex;
      const start = Math.max(0, end - limit);
      return { mode: "prepend", baseEntryId: entryIds[anchorIndex], ...page(start, end) };
    }
  }
  // The first read of a session has no cursor to walk forward from: serve the
  // newest page and let the client page backwards from it.
  if (cursor?.direction === "tail") {
    const end = entryIds.length;
    return { mode: "replace", baseEntryId: null, ...page(Math.max(0, end - limit), end) };
  }

  const cursorIndex = cursor?.lastEntryId ? at(cursor.lastEntryId) : -1;
  const firstIndex = cursor?.firstEntryId ? at(cursor.firstEntryId) : -1;
  // Both ends of the loaded window must still sit on the selected path, in order.
  // Requiring firstEntryId to be the WHOLE path's head instead is what turned
  // every windowed client's catch-up into a replace of the first 200 entries.
  const append = cursor !== null && (
    cursor.lastEntryId === null
      ? entryIds.length === 0
      : cursorIndex >= 0 && entryIds[cursorIndex] === cursor.lastEntryId
        && firstIndex >= 0 && firstIndex <= cursorIndex
  );
  const start = append ? cursorIndex + 1 : 0;
  const end = Math.min(start + limit, entryIds.length);
  return { mode: append ? "append" : "replace", baseEntryId: append ? cursor.lastEntryId : null, ...page(start, end) };
}
