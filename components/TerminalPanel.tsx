"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Terminal as TerminalIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useTheme } from "@/hooks/useTheme";

const INPUT_PATH = "/api/terminal/input";

/** A window drag fires the ResizeObserver dozens of times and the shell only
 *  needs the size it ends up at, so resizes are trailing-edge debounced. */
const RESIZE_DEBOUNCE_MS = 150;

/** The one terminal failure a user can act on. Keyed on the guard's code rather
 *  than on a bare 503: a proxy's 503 must not claim the password is missing. */
const AUTH_REQUIRED_CODE = "terminal_auth_required";

export interface TerminalClasses {
  Terminal: unknown;
  FitAddon: unknown;
}

export interface TerminalPanelProps {
  cwd: string | null;
  /** Rendered instead of the terminal when there is no workspace to run in. */
  emptyMessage?: string;
  /** Shown when the server refuses for lack of a web password (503). */
  authRequiredMessage?: string;
  onAuthRequired?: () => void;
  /** Supplies the xterm classes. Defaults to the dynamic import; tests pass a
   *  fake because assigning globalThis cannot intercept an ESM import, and the
   *  packages land in the dependency task. */
  loadTerminal?: () => Promise<TerminalClasses>;
}

/** Why the panel is not showing a usable shell. `null` is the normal state. */
type PanelOutcome =
  | { kind: "auth_required" }
  /** The shell itself exited (`exit`, Ctrl-D): writes are now server-side no-ops. */
  | { kind: "ended" }
  /** The stream closed without an exit frame — reaped, or the connection dropped. */
  | { kind: "closed" }
  | { kind: "error"; message: string }
  | null;

interface XtermInstance {
  options: { theme?: Record<string, string> };
  write(data: string): void;
  dispose(): void;
  onData(cb: (data: string) => void): { dispose(): void };
  loadAddon(addon: unknown): void;
  open(host: HTMLElement): void;
}

interface FitAddonInstance {
  fit(): void;
  proposeDimensions(): { cols: number; rows: number } | undefined;
}

/** Default xterm loader — a real dynamic import, so the terminal bundle is
 *  fetched only when a workspace actually opens a terminal. */
async function defaultTerminalLoader(): Promise<TerminalClasses> {
  const [xterm, fitAddon] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
  ]);
  return { Terminal: xterm.Terminal, FitAddon: fitAddon.FitAddon };
}

/**
 * Splits an SSE byte stream into frame payloads.
 *
 * Only `data:` lines are read, because the stream route sends unnamed frames
 * whose payload carries `type`. A future `event:` line cannot change what a
 * frame means: the name is never looked at. Comment lines (`:keepalive`) carry
 * nothing, several `data:` lines join per the SSE spec, and a frame split
 * across two chunks stays in `rest` until its remainder arrives.
 */
export function splitSseFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let rest = buffer;
  for (;;) {
    const boundary = /\r?\n\r?\n/.exec(rest);
    if (!boundary) break;
    const data = rest
      .slice(0, boundary.index)
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    rest = rest.slice(boundary.index + boundary[0].length);
    if (data) frames.push(data);
  }
  return { frames, rest };
}

/** xterm paints through canvas fillStyle and font strings, and neither can hold
 *  a `var(--token)`, so the tokens are resolved from the document instead. A
 *  token that is absent leaves its key out, which keeps xterm's own default
 *  rather than handing the canvas an invalid colour. */
function xtermTheme(): Record<string, string> {
  const styles = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {
    background: "--bg-panel",
    foreground: "--text",
    cursor: "--accent",
    selectionBackground: "--bg-selected",
  };
  const theme: Record<string, string> = {};
  for (const [key, token] of Object.entries(tokens)) {
    const value = styles.getPropertyValue(token).trim();
    if (value) theme[key] = value;
  }
  return theme;
}

function xtermFontFamily(): string | undefined {
  return getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || undefined;
}

async function readFailure(response: Response): Promise<{ authRequired: boolean; message: string }> {
  let message = `HTTP ${response.status}`;
  let authRequired = false;
  try {
    const body = await response.json() as { error?: string; code?: string };
    if (body.error) message = body.error;
    if (body.code === AUTH_REQUIRED_CODE) authRequired = true;
  } catch {
    // Not a JSON body; the status line is all there is.
  }
  return { authRequired, message };
}

export function TerminalPanel({
  cwd,
  emptyMessage,
  authRequiredMessage,
  onAuthRequired,
  loadTerminal,
}: TerminalPanelProps) {
  const { t } = useI18n();
  const { theme: themeId } = useTheme();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XtermInstance | null>(null);
  const [outcome, setOutcome] = useState<PanelOutcome>(null);
  const [restartKey, setRestartKey] = useState(0);
  const authRequired = outcome?.kind === "auth_required";

  // Read through refs so connecting does not depend on these props' identity: an
  // inline arrow from the parent would otherwise reconnect the shell on every
  // parent render.
  const loaderRef = useRef(loadTerminal);
  const onAuthRequiredRef = useRef(onAuthRequired);
  useEffect(() => {
    loaderRef.current = loadTerminal;
    onAuthRequiredRef.current = onAuthRequired;
  }, [loadTerminal, onAuthRequired]);

  const post = useCallback(async (path: string, body: Record<string, unknown>): Promise<void> => {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return;
    const failure = await readFailure(response);
    if (failure.authRequired) {
      onAuthRequiredRef.current?.();
      setOutcome({ kind: "auth_required" });
      return;
    }
    throw new Error(failure.message);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    // authRequired is a dependency, not an afterthought: the guidance takes the
    // host element away, so this effect has to tear the stream down at that
    // moment or the shell stays watched by a client that can no longer show it.
    if (!cwd || !host || authRequired) return;

    let cancelled = false;
    let shellEnded = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let teardown: (() => void) | null = null;
    const abort = new AbortController();

    setOutcome(null);

    (async () => {
      const load = loaderRef.current ?? defaultTerminalLoader;
      const { Terminal, FitAddon } = await load();
      if (cancelled) return;

      const fontFamily = xtermFontFamily();
      const options: Record<string, unknown> = {
        convertEol: true,
        fontSize: 12,
        cursorBlink: true,
        scrollback: 2000,
        theme: xtermTheme(),
      };
      // Not defaulted: an explicit undefined would override xterm's own font
      // stack with a broken canvas font string, and every column would measure wrong.
      if (fontFamily) options.fontFamily = fontFamily;

      const term = new (Terminal as new (opts: Record<string, unknown>) => XtermInstance)(options);
      const fit = new (FitAddon as new () => FitAddonInstance)();
      term.loadAddon(fit);
      term.open(host);
      // A hidden panel measures 0×0 and proposeDimensions declines, so fit() is a
      // no-op there and the ResizeObserver below refits it when it is shown.
      fit.fit();

      // Assigned before anything else can throw, so a failure from here on still
      // disposes the terminal rather than leaving it on a host nobody reads.
      termRef.current = term;
      const disposers: Array<() => void> = [];
      const dispose = () => {
        for (const release of disposers.splice(0)) release();
        termRef.current = null;
        term.dispose();
      };
      teardown = dispose;

      const keystrokes = term.onData((data) => {
        // After an exit frame the pty is gone: the write would be a silent
        // server-side no-op, which is indistinguishable from a dead keyboard.
        if (cancelled || shellEnded) return;
        void post(INPUT_PATH, { cwd, data })
          .catch((error: Error) => setOutcome({ kind: "error", message: error.message }));
      });
      disposers.push(() => keystrokes.dispose());

      let postedSize: { cols: number; rows: number } | null = null;
      const sendSize = (size: { cols: number; rows: number }) => {
        // Both dimensions or neither: the input route answers 400
        // terminal_size_invalid for half a pair.
        if (postedSize && postedSize.cols === size.cols && postedSize.rows === size.rows) return;
        postedSize = { cols: size.cols, rows: size.rows };
        void post(INPUT_PATH, { cwd, cols: size.cols, rows: size.rows }).catch(() => {
          // A resize that never landed would leave the shell the wrong shape, so
          // it is un-recorded and the next measurement — even the same one — posts again.
          postedSize = null;
        });
      };
      const scheduleSize = () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          resizeTimer = null;
          const size = fit.proposeDimensions();
          if (size) sendSize(size);
        }, RESIZE_DEBOUNCE_MS);
      };
      const observer = new ResizeObserver(scheduleSize);
      observer.observe(host);
      disposers.push(() => observer.disconnect());

      // Opened with the measured size so the shell is *born* the right shape: the
      // registry's spawn bridge drops a resize that arrives before node-pty has
      // resolved, so posting the size after the fact can silently lose the race.
      // The stream is fetched rather than opened with EventSource because that is
      // the only way to see the guard's status — EventSource cannot read a
      // response status, so a panel built on it would sit blank forever on the
      // very install that needs the guidance most.
      const size = fit.proposeDimensions();
      const query = new URLSearchParams({ cwd });
      if (size) {
        query.set("cols", String(size.cols));
        query.set("rows", String(size.rows));
      }
      const response = await fetch(`/api/terminal/stream?${query.toString()}`, {
        signal: abort.signal,
        headers: { Accept: "text/event-stream" },
      });
      if (cancelled) return;
      if (!response.ok) {
        const failure = await readFailure(response);
        dispose();
        teardown = null;
        if (failure.authRequired) {
          onAuthRequiredRef.current?.();
          setOutcome({ kind: "auth_required" });
          return;
        }
        throw new Error(failure.message);
      }

      if (!response.body) throw new Error("Terminal stream is not readable");
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done || cancelled) break;
        buffer += decoder.decode(value, { stream: true });
        const { frames, rest } = splitSseFrames(buffer);
        buffer = rest;
        for (const raw of frames) {
          let frame: { type?: string; data?: string };
          try {
            frame = JSON.parse(raw) as { type?: string; data?: string };
          } catch {
            // A malformed frame is not worth killing the terminal over.
            continue;
          }
          if (frame.type === "replay" || frame.type === "output") {
            if (frame.data) term.write(frame.data);
          } else if (frame.type === "exit") {
            shellEnded = true;
            setOutcome({ kind: "ended" });
            break;
          }
          // Any other frame type is a protocol addition, not an error.
        }
        if (shellEnded) break;
      }
      // Every way out of the loop stops reading for good, so the body is released
      // here instead of being left half-read on a connection that will send nothing more.
      await reader.cancel().catch(() => {
        // Already closed by the server, or already errored by abort().
      });

      if (!cancelled && !shellEnded) {
        // The shell was reaped or the connection dropped: nothing more will
        // arrive, and a terminal that waits for it is the frozen-terminal bug.
        setOutcome({ kind: "closed" });
      }
    })().catch((error: unknown) => {
      if (cancelled) return;
      setOutcome({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    });

    return () => {
      cancelled = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      abort.abort();
      teardown?.();
      const open = reader;
      reader = null;
      void open?.cancel().catch(() => {
        // Already errored by abort() or already closed by the server.
      });
    };
  }, [cwd, restartKey, post, authRequired]);

  // xterm bakes its colours into the canvas when it is constructed, so a theme
  // switch has to be pushed into the live instance.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermTheme();
  }, [themeId]);

  if (!cwd) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, textAlign: "center" }}>
        <TerminalIcon size={26} strokeWidth={1.5} aria-hidden="true" style={{ color: "var(--text-dim)" }} />
        <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 600 }}>{t("tabBar.terminal")}</div>
        <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.6, maxWidth: 260 }}>
          {emptyMessage ?? t("terminal.selectProjectFirst")}
        </div>
      </div>
    );
  }

  if (outcome?.kind === "auth_required") {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, textAlign: "center" }}>
        <TerminalIcon size={26} strokeWidth={1.5} aria-hidden="true" style={{ color: "var(--text-dim)" }} />
        <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 600 }}>
          {authRequiredMessage ?? t("terminal.authRequired")}
        </div>
        <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.6, maxWidth: 380 }}>
          {t("terminal.authRequiredHint")}
        </div>
      </div>
    );
  }

  const banner = outcome?.kind === "ended"
    ? t("terminal.shellEnded")
    : outcome?.kind === "closed"
      ? t("terminal.streamClosed")
      : outcome?.kind === "error"
        ? outcome.message
        : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--bg-panel)" }}>
      {banner && (
        <div
          role="alert"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "3px 6px 3px 8px",
            fontSize: 11,
            color: "var(--text-muted)",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {banner}
          </span>
          <button
            type="button"
            onClick={() => setRestartKey((value) => value + 1)}
            aria-label={t("terminal.restart")}
            title={t("terminal.restart")}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 22,
              height: 22,
              flexShrink: 0,
              padding: 0,
              background: "none",
              border: "none",
              borderRadius: "var(--radius-control)",
              color: "var(--text-dim)",
              cursor: "pointer",
            }}
            onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text)"; event.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-dim)"; event.currentTarget.style.background = "none"; }}
          >
            <RefreshCw size={13} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      )}
      <div ref={hostRef} style={{ flex: 1, minHeight: 0, padding: 6 }} />
    </div>
  );
}