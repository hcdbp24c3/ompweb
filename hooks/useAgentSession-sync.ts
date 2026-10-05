import { historyCursor, type SessionHistoryCursor, type SessionLiveSnapshot, type SessionStreamCursor, type SessionSyncResponse } from "@/lib/session-sync";
import type { SessionContext } from "@/lib/types";
import type { AgentEvent } from "./useAgentSession-stream";

export type SessionView = { leafId: string | null; includePreCompaction: boolean };

/**
 * How much of the selected display path the client actually holds.
 *
 * `total` is the server's entry count, `older` whether entries remain before the
 * window — the two facts a tail-first browser needs, since a windowed transcript
 * makes the local message count meaningless for both the scroll-up trigger and
 * the context panel.
 */
export interface SessionHistoryWindow {
  older: boolean;
  total: number;
}

/** One paged read of the selected view. Shared by the tail and backwards reads. */
export function historyPageUrl(sid: string, view: SessionView, cursor: SessionHistoryCursor | null): string {
  const params = new URLSearchParams({ sync: "1", deferThinking: "1", deferMedia: "1" });
  if (cursor) params.set("cursor", JSON.stringify(cursor));
  else params.set("tail", "1");
  if (view.leafId) params.set("leafId", view.leafId);
  if (view.includePreCompaction) params.set("includePreCompaction", "1");
  return `/api/sessions/${encodeURIComponent(sid)}/context?${params}`;
}

export async function readHistoryPage(sid: string, url: string): Promise<SessionSyncResponse> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const page = await res.json() as SessionSyncResponse;
  if (page.sessionId !== sid) throw new Error("History page belongs to another session");
  if (page.context.messages.length !== page.context.entryIds.length) throw new Error("History page is not aligned");
  return page;
}

export interface SessionLiveFields {
  message: boolean;
  lifecycle: boolean;
  /** Null rejects tool hydration; otherwise retain these newer per-tool states. */
  tools: ReadonlySet<string> | null;
}

export interface SessionCatchUp {
  request(): Promise<SessionContext | null>;
  /** Read one page before the window's own head and prepend it. */
  pageBackwards(): Promise<boolean>;
  seed(
    context: SessionContext,
    position?: SessionHistoryCursor | null,
    /** Set when the seed came from one paged read; a whole transcript has none. */
    page?: Pick<SessionSyncResponse, "hasMoreBefore" | "total"> | null,
  ): SessionContext;
  invalidate(): void;
  view(): SessionView;
  position(): SessionHistoryCursor | null;
  history(): SessionContext | null;
  /** The session `history()` belongs to; null when no view is selected. */
  historySession(): string | null;
  window(): SessionHistoryWindow;
  /** True while entries exist outside the loaded window, on either side. */
  partial(): boolean;
  select(view: SessionView): void;
  disconnect(): void;
  observe(event: AgentEvent): "epoch" | "stale" | null;
}

/** One durable cursor per selected view. Live ordering is independent of disk pagination. */
export function createSessionCatchUp(options: {
  sessionId: () => string | null;
  scope: () => string | null;
  history: (context: SessionContext, leafId: string | null, metadata?: { version: number; hasLive: boolean }) => void;
  live: (snapshot: SessionLiveSnapshot, fields: SessionLiveFields) => void;
  subscribe: (force: boolean) => boolean;
  metadataVersion?: () => number;
}): SessionCatchUp {
  let context: SessionContext | null = null;
  let cursor: SessionHistoryCursor | null = null;
  let view: SessionView = { leafId: null, includePreCompaction: false };
  let revision = 0;
  let stream: SessionStreamCursor | null = null;
  let messageSequence = 0;
  let lifecycleSequence = 0;
  let toolsSnapshotSequence = 0;
  let latestToolSequence = 0;
  const toolSequences = new Map<string, number>();
  const resetStream = () => {
    stream = null;
    messageSequence = lifecycleSequence = toolsSnapshotSequence = latestToolSequence = 0;
    toolSequences.clear();
  };
  let requested = false;
  let pending: Promise<SessionContext | null> | null = null;
  // Which slice of the selected path the window covers. `windowTotal` is the
  // server's entry count; it is only meaningful alongside `older`, because both
  // describe entries the browser does not hold.
  let windowTotal = 0;
  let older = false;
  // The transcript currently in `context` may belong to a session or a view that
  // has already been navigated away from; seeding the next one must not read it.
  let contextSessionId: string | null = null;
  let backPending: Promise<boolean> | null = null;

  const invalidate = () => {
    revision += 1;
    if (pending) requested = true;
  };
  const seed = (
    next: SessionContext,
    position: SessionHistoryCursor | null = cursor,
    page: Pick<SessionSyncResponse, "hasMoreBefore" | "total"> | null = null,
  ) => {
    // A newer completed sync may reflect truncation, not just an append.
    // Keep it and re-read rather than inferring freshness from transcript length.
    if (cursor !== position && context) {
      void request();
      return context;
    }
    invalidate();
    context = next;
    contextSessionId = options.sessionId();
    // A seed from one paged read is a window, and must remember it: without
    // this the client would treat its newest page as the whole conversation and
    // never ask for older entries.
    windowTotal = page ? page.total : next.entryIds.length;
    older = page ? page.hasMoreBefore : false;
    cursor = historyCursor(next);
    options.history(next, view.leafId);
    return next;
  };

  const request = (): Promise<SessionContext | null> => {
    requested = true;
    if (pending) return pending;
    pending = Promise.resolve().then(async () => {
      let loaded: SessionContext | null = null;
      while (requested) {
        requested = false;
        const sid = options.sessionId();
        const scope = options.scope();
        if (!sid || scope === null) break;
        const version = revision;
        const publishedCursor = cursor;
        const metadataVersion = options.metadataVersion?.() ?? 0;
        // Pages are private until the selected history is complete. A failed
        // replacement must not truncate the visible history or advance its cursor.
        let nextContext = context;
        let nextCursor = cursor;
        try {
          while (true) {
            const base = nextCursor;
            const params = new URLSearchParams({ sync: "1", deferThinking: "1", deferMedia: "1" });
            if (base) params.set("cursor", JSON.stringify(base));
            if (view.leafId) params.set("leafId", view.leafId);
            if (view.includePreCompaction) params.set("includePreCompaction", "1");
            const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/context?${params}`, { signal: AbortSignal.timeout(30_000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const page = await res.json() as SessionSyncResponse;
            if (options.scope() !== scope || revision !== version || cursor !== publishedCursor || options.sessionId() !== sid) break;
            if (page.sessionId !== sid) break;
            if ((page.mode !== "append" && page.mode !== "replace") || page.context.messages.length !== page.context.entryIds.length) break;
            // This request discovered a wrapper restart that the old SSE never saw.
            if (page.live && stream && page.live.cursor.streamId !== stream.streamId) {
              options.subscribe(true);
              requested = false; // the new connection's open/connected frame starts a fresh read
              break;
            }
            if (page.mode === "append" && page.baseEntryId !== (base?.lastEntryId ?? null)) break;
            const unchanged = page.mode === "append" && page.context.entryIds.length === 0 && nextContext !== null;
            const messages = page.mode === "append" ? unchanged ? nextContext!.messages : [...(nextContext?.messages ?? [])] : [];
            const entryIds = page.mode === "append" ? unchanged ? nextContext!.entryIds : [...(nextContext?.entryIds ?? [])] : [];
            const seen = new Set(unchanged ? [] : entryIds);
            for (let i = 0; i < page.context.entryIds.length; i += 1) {
              const id = page.context.entryIds[i];
              if (!seen.has(id)) {
                seen.add(id);
                entryIds.push(id);
                messages.push(page.context.messages[i]);
              }
            }
            nextContext = { ...page.context, messages, entryIds };
            nextCursor = page.cursor;
            if (page.hasMore) {
              // Malformed/non-advancing pages must not create an unbounded read loop.
              if (base?.firstEntryId === nextCursor.firstEntryId && base?.lastEntryId === nextCursor.lastEntryId) break;
              continue;
            }
            context = nextContext;
            cursor = nextCursor;
            contextSessionId = sid;
            // The publishing page is the last one, so its view of the path is the
            // one the merged window now matches.
            older = page.hasMoreBefore;
            windowTotal = page.total;
            loaded = context;
            options.history(context, page.leafId, { version: metadataVersion, hasLive: page.live !== null });
            if (page.live) {
              if (options.subscribe(false)) {
                requested = false;
                break;
              }
              if (stream) {
                const sequence = page.live.cursor.sequence;
                const busy = page.live.isStreaming || page.live.isPromptRunning || page.live.isCompacting;
                const preserve = sequence >= Math.max(toolsSnapshotSequence, lifecycleSequence) ? new Set<string>() : null;
                const fields: SessionLiveFields = {
                  message: sequence >= Math.max(messageSequence, lifecycleSequence),
                  lifecycle: sequence >= lifecycleSequence && (busy || sequence >= Math.max(messageSequence, latestToolSequence)),
                  tools: preserve,
                };
                if (preserve) {
                  for (const [id, seen] of toolSequences) {
                    if (seen > sequence) preserve.add(id);
                    else toolSequences.delete(id);
                  }
                  toolsSnapshotSequence = sequence;
                  latestToolSequence = Math.max(latestToolSequence, sequence);
                }
                if (fields.message) messageSequence = sequence;
                if (fields.lifecycle) lifecycleSequence = sequence;
                stream = { ...stream, sequence: Math.max(stream.sequence, sequence) };
                if (fields.message || fields.lifecycle || fields.tools) options.live(page.live, fields);
              }
            }
            break;
          }
        } catch {
          // A failed read is not an empty transcript. A later trigger retries
          // from the last complete history, not a partially fetched replacement.
          loaded = null;
        }
      }
      return loaded;
    }).finally(() => {
      pending = null;
      // A trigger can arrive after the loop returned but before this finalizer.
      if (requested) void request();
    });
    return pending;
  };

  const pageBackwards = (): Promise<boolean> => {
    const base = context;
    const anchor = base?.entryIds[0];
    const sid = options.sessionId();
    const scope = options.scope();
    // Nothing to page for, or nothing to page against: a window that already
    // reaches the head of the path must not issue a request at all.
    if (!base || !older || anchor === undefined || !sid || scope === null) return Promise.resolve(false);
    if (backPending) return backPending;
    const version = revision;
    const publishedCursor = cursor;
    backPending = Promise.resolve().then(async () => {
      try {
        const page = await readHistoryPage(sid, historyPageUrl(sid, view, {
          firstEntryId: anchor,
          lastEntryId: base.entryIds.at(-1) ?? null,
          anchorEntryId: anchor,
          direction: "backward",
        }));
        if (options.scope() !== scope || revision !== version || cursor !== publishedCursor || options.sessionId() !== sid) return false;
        if (page.mode !== "prepend") {
          // The anchor left the selected path (compaction, a branch switch), so
          // the response describes entries that are not before this window.
          // Merging it would splice the oldest page onto the newest one; re-read
          // the tail instead, which is the only page that is correct either way.
          const tail = await readHistoryPage(sid, historyPageUrl(sid, view, null));
          seed(tail.context, cursor, tail);
          return false;
        }
        const entryIds = [...page.context.entryIds, ...base.entryIds];
        const messages = [...page.context.messages, ...base.messages];
        context = { ...page.context, messages, entryIds };
        contextSessionId = sid;
        // The window grew at the FRONT, so the cursor has to be recomputed from
        // what is now loaded. Keeping the cursor the page was cut from would
        // make the next forward read start from the whole path's head and hand
        // back the oldest 200 entries.
        cursor = historyCursor(context);
        older = page.hasMoreBefore;
        windowTotal = page.total;
        options.history(context, view.leafId);
        return true;
      } catch {
        // A failed page is not a shorter transcript; the window stays as it was
        // and the next scroll-up retries from the same anchor.
        return false;
      }
    }).finally(() => {
      backPending = null;
    });
    return backPending;
  };

  return {
    request,
    pageBackwards,
    seed,
    invalidate,
    view: () => view,
    position: () => cursor,
    history: () => context,
    historySession: () => contextSessionId,
    window: () => ({ older, total: windowTotal }),
    partial: () => context !== null && windowTotal > context.entryIds.length,
    select(next: SessionView) {
      invalidate();
      view = next;
      cursor = null;
      // A different view is a different transcript: the window facts and the
      // session the context belongs to describe the one being navigated away
      // from, and reading them would page against the wrong path.
      windowTotal = 0;
      older = false;
      contextSessionId = null;
    },
    disconnect() {
      invalidate();
      resetStream();
    },
    /** Observe receipt before token coalescing, so queued tokens also fence HTTP. */
    observe(event: AgentEvent): "epoch" | "stale" | null {
      const next = event.web;
      if (!next) return null;
      const changed = stream !== null && next.streamId !== stream.streamId;
      if (changed) {
        invalidate();
        resetStream();
      }
      const lifecycle = /^(agent_start|agent_end|prompt_result|prompt_error|auto_compaction_start|auto_compaction_end)$/.test(event.type);
      const message = /^(message_start|message_update|message_end)$/.test(event.type)
        && (event.message as { role?: unknown } | undefined)?.role !== "user";
      const tool = /^tool_execution_(start|update|end)$/.test(event.type) && typeof event.toolCallId === "string" ? event.toolCallId : null;
      const floor = lifecycle ? Math.max(lifecycleSequence, messageSequence, latestToolSequence)
        : message ? Math.max(lifecycleSequence, messageSequence)
        : tool ? Math.max(lifecycleSequence, toolsSnapshotSequence, toolSequences.get(tool) ?? 0) : 0;
      if (next.sequence < floor) return "stale";
      if (lifecycle) {
        lifecycleSequence = next.sequence;
        toolSequences.clear();
      }
      if (message) messageSequence = next.sequence;
      if (tool) {
        toolSequences.set(tool, next.sequence);
        latestToolSequence = Math.max(latestToolSequence, next.sequence);
      }
      stream = { ...next, sequence: Math.max(stream?.sequence ?? 0, next.sequence) };
      return changed ? "epoch" : null;
    },
  };
}
