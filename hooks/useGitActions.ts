"use client";

/**
 * The Git tab's write surface, as one state machine.
 *
 * `components/RightPanel.tsx` renders the three buttons and `GitChangesPanel`
 * renders the message box and the output, so the state has to outlive both. It
 * lives here rather than in either component because four decisions would
 * otherwise be duplicated across them and could disagree:
 *
 * 1. THE TERMINAL FRAME DECIDES THE OUTCOME, not the response. The route answers
 *    a push with HTTP 200 and a stream; whether git accepted the push is stated
 *    by the last frame in it. Anything else — a request that resolved, a stream
 *    that ended, a 4xx before the stream began — is an error, because claiming
 *    success for a push the remote rejected is the one unrecoverable mistake
 *    this surface can make.
 *
 * 2. ONE OPERATION AT A TIME. `busy` is the single gate, in `run` and in
 *    `canCommit`, so there is never a second write to interleave with the first
 *    (git would refuse on the index lock anyway, and an interleaved commit would
 *    change what a half-written request meant).
 *
 * 3. WHERE THE TEXT COMES FROM IS NOT ARBITRARY. A refusal made BEFORE git runs
 *    — no upstream, no URL, a bad refspec — is omp-web's own, arrives as a
 *    `code`, and is rendered from the dictionary so it is localized. A failure
 *    after git ran is git's own, and the only honest rendering of it is the text
 *    git printed, which is why those operations stream: `log` is the message, and
 *    the headline above it is the localized sentence the dictionary has for that
 *    class of failure.
 *
 * 4. ABORT IS NOT THE SAME AS CANCEL. Cancelling asks the server to stop the
 *    child and then WAITS for the stream's own frame; it never invents a verdict.
 *    Aborting the request is the separate, unconditional consequence of leaving
 *    the panel, and the route treats a disconnect as a cancellation server-side.
 *
 * Not in `lib/git-write.ts`: that module imports `child_process`, and a type
 * imported from it would drag the server-only layer into the browser bundle.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appendProgress } from "@/lib/git-clone";
import { formatApiError } from "@/lib/i18n/api-error";
import { translate } from "@/lib/i18n";

/** What the user can start from the toolbar. `stage` has no button: a commit
 *  records the worktree's version of the ticked paths, so staging them first
 *  would only add a round trip. */
export type GitOperationKind = "commit" | "push" | "pull";

export type GitOperationOutcome =
  | { kind: "done" }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

export interface GitOperation {
  kind: GitOperationKind;
  /** git's own output, carriage returns already folded, as it arrives. */
  log: string;
  running: boolean;
  /** The verdict, or null while the operation is still running. */
  outcome: GitOperationOutcome | null;
}

interface GitActionFrame {
  type: "output" | "done" | "cancelled" | "error";
  text?: string;
  error?: string;
  code?: string;
}

/** Identity-stable empty selection, so "nothing ticked" is not a new array per
 *  render and `canCommit` cannot change just because something re-rendered. */
const NO_PATHS: readonly string[] = [];

const ACTION_URL = "/api/git/action";

/**
 * An id for one in-flight streamed operation, so `DELETE` can name it.
 *
 * `crypto.randomUUID` is the right source — but it only exists in a SECURE
 * context, and this app is routinely reached over plain http on a LAN
 * (`npm run dev:lan`), where it is `undefined` and a bare call would throw before
 * the push is ever sent. The fallback is not a secret and does not need to be:
 * the id is a lookup key into the server's own map of running operations, it is
 * not a capability, and the server only ever accepts it from the client that
 * created it. What it does need is to be unique among concurrent operations and to
 * match the route's `^[A-Za-z0-9-]{1,64}$`.
 */
function newActionId(action: string): string {
  const random = globalThis.crypto?.randomUUID?.();
  return `${action}-${random ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
}

export interface UseGitActionsOptions {
  /** null until a project is selected, which is the only state with nothing to
   *  write to. Every entry point refuses it rather than posting an empty cwd. */
  cwd: string | null;
  /** Called once an operation has actually changed the working tree, so the
   *  changed-file list can be re-read. Not called for a cancellation or a
   *  failure: neither moved anything. */
  onChanged?: () => void;
}

export interface UseGitActions {
  commitMessage: string;
  setCommitMessage: (message: string) => void;
  /** The ticked absolute paths, exactly as the panel reported them. */
  tickedPaths: readonly string[];
  setTickedPaths: (paths: readonly string[]) => void;
  /** Both halves of the rule, not the button's disabled attribute: the hook
   *  refuses an unready commit itself, so a caller that reaches for `commit()`
   *  cannot produce an empty commit by another route. */
  canCommit: boolean;
  busy: boolean;
  canCancel: boolean;
  commit: () => void;
  push: () => void;
  pull: () => void;
  cancel: () => void;
  operation: GitOperation | null;
}

export function useGitActions({ cwd, onChanged }: UseGitActionsOptions): UseGitActions {
  const [commitMessage, setCommitMessage] = useState("");
  const [tickedPaths, setTickedPaths] = useState<readonly string[]>(NO_PATHS);
  const [operation, setOperation] = useState<GitOperation | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // The id and the request currently on the wire. `cancel` names the id and
  // unmount aborts the request; neither could read either from state, because the
  // click that starts an operation and the click that stops it are different
  // renders and the verdict of the first has not been committed to the second.
  const streamIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // The refresh callback is read at settle time, so a new closure per AppShell
  // render must not become a dependency of every action.
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  // Leaving the panel is not a verdict, it is an abandonment: the route cancels on
  // a disconnect, so a push the user walked away from stops instead of finishing
  // against a remote nobody is watching.
  useEffect(() => () => abortRef.current?.abort(), []);

  const running = operation?.running === true ? operation : null;
  const busy = running !== null;
  const canCommit = tickedPaths.length > 0 && commitMessage.trim().length > 0 && !busy;
  // A commit is one local round trip that answers with JSON, so there is no child
  // to stop and no id for DELETE to name. Offering the control would be a lie.
  const canCancel = running !== null && running.kind !== "commit" && !cancelling;

  /** Moves a running operation to its verdict, or does nothing if it already has
   *  one. The guard matters because the same request can report twice — a
   *  terminal frame and then a reader that ends. */
  const settle = useCallback((outcome: GitOperationOutcome) => {
    abortRef.current = null;
    streamIdRef.current = null;
    setCancelling(false);
    setOperation((previous) =>
      previous && previous.running ? { ...previous, running: false, outcome } : previous,
    );
    if (outcome.kind === "done") onChangedRef.current?.();
  }, []);

  const start = useCallback((kind: GitOperationKind): AbortController | null => {
    if (!cwd || abortRef.current !== null) return null;
    const controller = new AbortController();
    abortRef.current = controller;
    setCancelling(false);
    setOperation({ kind, log: "", running: true, outcome: null });
    return controller;
  }, [cwd]);

  const runCommit = useCallback(() => {
    const message = commitMessage.trim();
    if (!message || tickedPaths.length === 0) return;
    const controller = start("commit");
    if (!controller) return;
    void (async () => {
      try {
        const response = await fetch(ACTION_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // No `id`: this action answers with JSON, so DELETE could not stop it.
          body: JSON.stringify({ cwd, action: "commit", message, paths: tickedPaths }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          settle({ kind: "error", message: formatApiError(payload as { error?: string; code?: string }) });
          return;
        }
        // A spent message is not retyped for the next commit, and leaving it in
        // the box would make the button look ready for a commit that already
        // happened.
        setCommitMessage("");
        settle({ kind: "done" });
      } catch (cause) {
        settle({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) });
      }
    })();
  }, [commitMessage, cwd, settle, start, tickedPaths]);

  const runStreamed = useCallback((kind: "push" | "pull") => {
    const controller = start(kind);
    if (!controller) return;
    // One id per operation, not one id for the panel: DELETE names a child, so a
    // shared id would let a cancel stop whatever ran most recently rather than
    // what the user was looking at.
    const id = newActionId(kind);
    streamIdRef.current = id;
    void (async () => {
      try {
        const response = await fetch(ACTION_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd, action: kind, id }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          const payload = await response.json().catch(() => ({}));
          settle({ kind: "error", message: formatApiError(payload as { error?: string; code?: string }) });
          return;
        }
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffered = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffered += value;
          // A frame can straddle two reads, so only complete lines are frames.
          const lines = buffered.split("\n");
          buffered = lines.pop() ?? "";
          for (const line of lines) {
            if (!line) continue;
            const frame = JSON.parse(line) as GitActionFrame;
            if (frame.type === "output") {
              const text = frame.text ?? "";
              setOperation((previous) =>
                previous && previous.running
                  ? { ...previous, log: appendProgress(previous.log, text) }
                  : previous,
              );
            } else if (frame.type === "done") {
              settle({ kind: "done" });
              return;
            } else if (frame.type === "cancelled") {
              settle({ kind: "cancelled" });
              return;
            } else if (frame.type === "error") {
              settle({ kind: "error", message: formatApiError(frame) });
              return;
            }
          }
        }
        // The stream ended with no verdict. Nothing was reported as accepted, and
        // nothing was reported as refused either, so it is an unknown outcome —
        // which is not a success.
        settle({ kind: "error", message: translate("gitChanges.operationInterrupted") });
      } catch (cause) {
        // An abort is the panel leaving or the tab closing: the server has already
        // cancelled the child, and there is nobody left to read a verdict.
        if (controller.signal.aborted) return;
        settle({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) });
      }
    })();
  }, [cwd, settle, start]);

  const push = useCallback(() => runStreamed("push"), [runStreamed]);
  const pull = useCallback(() => runStreamed("pull"), [runStreamed]);

  const cancel = useCallback(() => {
    const id = streamIdRef.current;
    // `canCancel` already implies an id exists — only a streamed operation can be
    // running, and `runStreamed` sets the id in the same synchronous block that
    // started it — so `!id` is a belt-and-braces clause rather than a reachable
    // branch, and a mutation that drops it is behaviourally identical today. It
    // is kept because the alternative failure is worse than a no-op: a DELETE
    // with no id 404s, and nothing but the stream can undo that, so the panel
    // would sit on "Cancelling…" with a child still pushing.
    if (!id || !canCancel) return;
    setCancelling(true);
    void fetch(ACTION_URL, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    })
      // A rejected DELETE changes nothing: the child may already be gone, or the
      // request never arrived, and only the stream can say. Dropping the button
      // back and waiting keeps the two answers from racing.
      .catch(() => setCancelling(false));
  }, [canCancel]);

  return useMemo(() => ({
    commitMessage,
    setCommitMessage,
    tickedPaths,
    setTickedPaths,
    canCommit,
    busy,
    canCancel,
    commit: runCommit,
    push,
    pull,
    cancel,
    operation,
  }), [busy, canCancel, canCommit, cancel, commitMessage, operation, pull, push, runCommit, tickedPaths]);
}