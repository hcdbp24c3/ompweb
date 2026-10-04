/**
 * The browser-side order guarantee for terminal input.
 *
 * `/api/terminal/input` writes `data` straight into the pty, so the shell sees
 * the bytes in the order the *requests arrive*, not the order they were sent.
 * One `fetch` per keystroke, fired without awaiting, therefore scrambles typing:
 * measured in a real browser, a 76-character command fed in as fast as the browser
 * would take it came out as `pritnf ' %\sn' … 0123457689` and left the shell on an
 * unterminated-quote prompt. Corrupted in the shell's own echo as well as in its
 * output, so it was write order and not rendering.
 *
 * So there is exactly one request in flight at a time, and keystrokes that arrive
 * while it is out are queued and travel together in the next one. The queue holds
 * a bounded amount of work: one in-flight request, one pending resize slot, and
 * keystrokes coalesced into chunks no larger than the input route accepts.
 */

/**
 * The input route refuses `data` over `MAX_INPUT_BYTES` with a 413, and two
 * coalesced pastes can reach that on their own, so coalescing is bounded by the
 * route's own limit rather than by a number invented here. Kept in step with
 * `app/api/terminal/input/route.ts`.
 */
export const MAX_INPUT_BYTES = 64 * 1024;

const encoder = new TextEncoder();

const utf8Length = (text: string): number => encoder.encode(text).length;

/** Queued input, in the order it was queued. Consecutive keystrokes are one
 *  entry, which is the coalescing: a burst costs one request. A resize is its own
 *  entry so it keeps its place in the line. */
type Pending = { kind: "keys"; data: string; bytes: number } | { kind: "resize"; cols: number; rows: number };

export interface TerminalInputQueueOptions {
  cwd: string;
  /** Posts one `/api/terminal/input` body. Rejecting or answering non-2xx ends
   *  that request only; the queue carries on with the next one. */
  send(body: Record<string, unknown>): Promise<void>;
  /** Told about a failed request, and which kind it was: a refused resize is
   *  retried by the panel's next measurement, so it is not the user's keystroke
   *  failing, while a keystroke has no second chance. */
  onError?(error: Error, kind: "keys" | "resize"): void;
  /** Defaults to the input route's own limit. */
  maxInputBytes?: number;
}

export interface TerminalInputQueue {
  /** Queues a keystroke for the pty. Empty input is ignored. */
  write(data: string): void;
  /** Queues a resize, replacing one that has not gone out yet. */
  resize(cols: number, rows: number): void;
  /** Drops everything queued and sends nothing further. */
  dispose(): void;
}

export function createTerminalInputQueue({
  cwd,
  send,
  onError,
  maxInputBytes = MAX_INPUT_BYTES,
}: TerminalInputQueueOptions): TerminalInputQueue {
  let pending: Pending[] = [];
  let inFlight = false;
  let closed = false;

  function drain(): void {
    if (inFlight || closed) return;
    const body = nextBody();
    if (!body) return;
    inFlight = true;
    // The chain owns `inFlight`, so a failed request cannot leave it set and wedge
    // the keyboard for the rest of the session.
    void send(body).then(
      () => { inFlight = false; drain(); },
      (error: unknown) => {
        inFlight = false;
        if (closed) return;
        // A refused resize is not a failed keystroke: the panel un-records the size
        // and posts it again on the next measurement, so there is nothing to tell
        // the user about. Keystrokes have no such second chance.
        const failure = error instanceof Error ? error : new Error(String(error));
        onError?.(failure, typeof body.data === "string" ? "keys" : "resize");
        drain();
      },
    );
  }

  /** The head of the queue as one request, within the route's size limit. */
  function nextBody(): Record<string, unknown> | null {
    const head = pending[0];
    if (!head) return null;
    if (head.kind === "resize") {
      pending.shift();
      return { cwd, cols: head.cols, rows: head.rows };
    }
    const chunk = takeChunk(head);
    if (chunk.rest === "") pending.shift();
    else {
      head.data = chunk.rest;
      head.bytes = chunk.restBytes;
    }
    return { cwd, data: chunk.data };
  }

  /** One request's worth of a queued keystroke run. */
  function takeChunk(entry: { data: string; bytes: number }): { data: string; rest: string; restBytes: number } {
    if (entry.bytes <= maxInputBytes) return { data: entry.data, rest: "", restBytes: 0 };
    let end = 0;
    let taken = 0;
    while (end < entry.data.length) {
      const codePoint = entry.data.codePointAt(end) ?? 0;
      const width = codePoint > 0xffff ? 2 : 1;
      const size = utf8Length(entry.data.slice(end, end + width));
      // `end > 0` so a single character over the limit is still sent whole rather
      // than dropped: the route refuses it either way, and dropping input is worse.
      if (taken + size > maxInputBytes && end > 0) break;
      end += width;
      taken += size;
    }
    return {
      data: entry.data.slice(0, end),
      rest: entry.data.slice(end),
      restBytes: entry.bytes - taken,
    };
  }

  /** The queued keystroke run at the tail, so a burst can join it. */
  function tailKeystrokes(): { data: string; bytes: number } | null {
    const last = pending[pending.length - 1];
    return last?.kind === "keys" ? last : null;
  }

  return {
    write(data: string) {
      if (closed || !data) return;
      const tail = tailKeystrokes();
      if (tail) {
        tail.data += data;
        tail.bytes += utf8Length(data);
      } else {
        pending.push({ kind: "keys", data, bytes: utf8Length(data) });
      }
      drain();
    },
    resize(cols: number, rows: number) {
      if (closed) return;
      // Only the newest size when nothing has been typed since it: a window drag
      // measures many times and the middle ones are stale by the time they would be
      // sent. An older resize keeps its place, because moving it would take it ahead
      // of the keystrokes it was queued behind.
      const last = pending[pending.length - 1];
      if (last?.kind === "resize") {
        last.cols = cols;
        last.rows = rows;
      } else {
        pending.push({ kind: "resize", cols, rows });
      }
      drain();
    },
    dispose() {
      // Dropped, not flushed: the panel is gone, and the input route *attaches* —
      // it spawns a shell for a cwd that is not live, so flushing here would leave
      // one running that nothing is watching.
      closed = true;
      pending = [];
    },
  };
}