"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AtSign, Check, ExternalLink, GitBranch, RefreshCw, Search, X } from "lucide-react";
import { getFileIcon } from "./FileIcons";
import { DiffView } from "./FileViewer";
import { GIT_STATUS_COLORS, GIT_STATUS_LABEL_KEYS } from "./FileExplorer";
import { translate, useI18n } from "@/lib/i18n";
import {
  getFileDirectory,
  getFileName,
  getRelativeFilePath,
  normalizeFilePathSlashes,
} from "@/lib/file-paths";
import { pruneTickedPaths, toggleTickedPath } from "@/lib/git-file-selection";
import { summarizeTickedChanges } from "@/lib/commit-message";
import type { GitFileDiffResponse, GitStatusResponse } from "@/lib/git-types";
import type { GitOperation, GitOperationKind } from "@/hooks/useGitActions";

interface Props {
  cwd: string;
  refreshKey?: number;
  onOpenFile: (filePath: string, fileName: string) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onRefreshDone?: () => void;
  /** The ticked paths, absolute and exactly as ticked. The commit surface lives
   *  outside this panel, so the set is owned here and reported out. */
  onTickedPathsChange?: (paths: string[]) => void;
  /** The message the toolbar's Commit button will send. Owned by the hook
   *  because the button that consumes it is in RightPanel's toolbar, not here. */
  commitMessage: string;
  onCommitMessageChange: (message: string) => void;
  /** The newest write operation, or null if none has run. Its output is shown
   *  here rather than in the toolbar, so the buttons stay where the user left
   *  them and the log has room to grow. */
  operation: GitOperation | null;
  /** Whether asking the server to stop is still worth doing. The hook's single
   *  answer, so the button's state and its guard cannot disagree. */
  canCancelOperation: boolean;
  onCancelOperation: () => void;
}

/** Identity-stable "nothing ticked", so an empty selection is not a new object
 *  on every render. */
const NO_TICKED_PATHS: ReadonlySet<string> = new Set<string>();

const OPERATION_LABEL_KEYS: Record<GitOperationKind, string> = {
  commit: "gitChanges.commit",
  push: "gitChanges.push",
  pull: "gitChanges.pull",
};

async function fetchStatus(cwd: string): Promise<GitStatusResponse> {
  const params = new URLSearchParams({ cwd });
  const res = await fetch(`/api/git/status?${params.toString()}`);
  if (!res.ok) {
    throw new Error(translate("gitChanges.loadFailed", { status: res.status }));
  }
  return res.json() as Promise<GitStatusResponse>;
}

async function fetchPatch(cwd: string, filePath: string): Promise<GitFileDiffResponse> {
  const params = new URLSearchParams({ cwd, path: filePath });
  const res = await fetch(`/api/git/diff?${params.toString()}`);
  if (!res.ok) {
    throw new Error(translate("gitChanges.diffLoadFailed", { status: res.status }));
  }
  return res.json() as Promise<GitFileDiffResponse>;
}

/**
 * What the write surface reports back, below the working surface rather than
 * replacing it: a push can take a minute, and a minute of a panel that will not
 * scroll is a minute of not knowing. The log is bounded so the diff above it
 * keeps its room.
 *
 * The headline never decides the outcome. While the operation runs there is no
 * outcome, and once it ends the hook's verdict is the only thing allowed to say
 * what happened — a heading that read "finished" for a push the remote rejected
 * is the single failure this whole surface exists to prevent. The verdict's own
 * message is shown verbatim, and for a failure that happened after git ran it is
 * git's own wording, with the full output right under it.
 */
function GitOperationStrip({
  operation,
  canCancel,
  onCancel,
}: {
  operation: GitOperation;
  canCancel: boolean;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const action = t(OPERATION_LABEL_KEYS[operation.kind]);
  const status = operation.running
    ? t("gitChanges.operationRunning", { action })
    : operation.outcome
      ? operation.outcome.kind === "done"
        ? t("gitChanges.operationDone", { action })
        : operation.outcome.kind === "cancelled"
          ? t("gitChanges.operationCancelled", { action })
          : operation.outcome.message
      // A finished operation with no verdict is a state the hook does not produce;
      // if one ever appears it is an unknown outcome, which is not a success.
      : t("gitChanges.operationInterrupted");
  // A commit answers with JSON in one round trip, so there is no child to stop and
  // no id for DELETE to name: offering the control would be a lie.
  const cancellable = operation.running && operation.kind !== "commit";

  return (
    <div
      className="git-operation"
      style={{ flexShrink: 0, borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", minWidth: 0 }}>
        <span
          role="status"
          className="git-operation-status"
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 11,
            fontWeight: 600,
            color: operation.outcome?.kind === "error" ? "var(--status-error)" : "var(--text-muted)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={status}
        >
          {status}
        </span>
        {cancellable && (
          <button
            className="git-operation-cancel"
            type="button"
            onClick={onCancel}
            disabled={!canCancel}
            title={canCancel ? t("gitChanges.cancelOperation") : t("gitChanges.operationCancelling")}
            style={{
              flexShrink: 0,
              height: 22,
              padding: "0 8px",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-control)",
              color: canCancel ? "var(--text)" : "var(--text-dim)",
              cursor: canCancel ? "pointer" : "default",
              opacity: canCancel ? 1 : 0.7,
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            {canCancel ? t("gitChanges.cancelOperation") : t("gitChanges.operationCancelling")}
          </button>
        )}
      </div>
      {operation.log && (
        // `role="log"` rather than a bare <pre>: the label is only exposed if the
        // element has a role, and it is the right one — a region that receives
        // streamed output. `tabIndex` because the region scrolls and a scrollable
        // region that cannot be focused cannot be scrolled from the keyboard.
        <pre
          className="git-operation-log"
          role="log"
          tabIndex={0}
          aria-label={t("gitChanges.gitOutput")}
          style={{
            margin: 0,
            padding: "4px 8px 6px",
            maxHeight: 96,
            overflow: "auto",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            lineHeight: 1.5,
            color: "var(--text-dim)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {operation.log}
        </pre>
      )}
    </div>
  );
}

export function GitChangesPanel({
  cwd,
  refreshKey,
  onOpenFile,
  onAtMention,
  onRefreshDone,
  onTickedPathsChange,
  commitMessage,
  onCommitMessageChange,
  operation,
  canCancelOperation,
  onCancelOperation,
}: Props) {
  const { t, tn } = useI18n();
  const [files, setFiles] = useState<GitStatusResponse["files"]>([]);
  const [isRepo, setIsRepo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);  const [patch, setPatch] = useState<string | null>(null);
  const [patchSupported, setPatchSupported] = useState(true);
  const [patchLoading, setPatchLoading] = useState(false);
  const [patchError, setPatchError] = useState<string | null>(null);
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);
  // The ticked paths, tagged with the cwd they were ticked in. A tick is only
  // meaningful for the directory it was made in — the paths are absolute, so no
  // path can survive into another repo — and reading the set only while the tag
  // still matches means a cwd switch hides them on the very next render, with no
  // window in which a stale path could still be sent to a commit.
  const [ticked, setTicked] = useState<{ cwd: string; paths: ReadonlySet<string> }>(
    () => ({ cwd, paths: NO_TICKED_PATHS }),
  );
  const tickedPaths = ticked.cwd === cwd ? ticked.paths : NO_TICKED_PATHS;
  const filterInputRef = useRef<HTMLInputElement>(null);
  const patchRequestRef = useRef(0);
  const refreshToken = `${refreshKey ?? 0}:${treeRefreshKey}`;

  // Keep the refresh-done callback in a ref so its identity cannot re-trigger
  // the fetch effect below (AppShell re-renders on every session boundary).
  const onRefreshDoneRef = useRef(onRefreshDone);
  onRefreshDoneRef.current = onRefreshDone;

  // Same reason: the selection is reported, not consumed, so a new closure each
  // render must not re-report an unchanged set.
  const onTickedPathsChangeRef = useRef(onTickedPathsChange);
  onTickedPathsChangeRef.current = onTickedPathsChange;

  /** Pair the ticked paths with the status list and derive the subject. Kept
   *  here because the tick set and the file list are both local to this panel;
   *  the derivation itself is pure and lives in `lib/commit-message`. */
  const suggestMessageFromTicks = useCallback(() => {
    const ticked = new Set(tickedPaths);
    const subject = summarizeTickedChanges(files.filter((file) => ticked.has(file.filePath)));
    if (subject) onCommitMessageChange(subject);
  }, [files, tickedPaths, onCommitMessageChange]);

  useEffect(() => {
    onTickedPathsChangeRef.current?.([...tickedPaths]);
  }, [tickedPaths, cwd]);

  // `tickedPaths` rather than the raw state: the cwd rule lives in the derivation
  // above, so the handler inherits it instead of restating it. (A tick can only
  // be made while rows are rendered, and rows are unmounted for the whole of a
  // status fetch, so a second copy of the rule here would be unreachable.)
  const toggleTick = useCallback((filePath: string) => {
    setTicked({ cwd, paths: toggleTickedPath(tickedPaths, filePath) });
  }, [cwd, tickedPaths]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchStatus(cwd)
      .then((status) => {
        if (cancelled) return;
        const nextFiles = status.isGitRepository ? status.files : [];
        setFiles(nextFiles);
        setIsRepo(status.isGitRepository);
        // A tick on a file this refresh no longer lists is dropped: the row is
        // gone, so committing it would send a path git does not consider
        // modified any more.
        setTicked((prev) => ({
          cwd,
          paths: pruneTickedPaths(prev.cwd === cwd ? prev.paths : NO_TICKED_PATHS, nextFiles),
        }));
        // Keep the selection when it still exists; otherwise preview the first
        // changed file so the diff pane is never blank behind a file list.
        setSelectedPath((prev) =>
          prev && nextFiles.some((f) => f.filePath === prev)
            ? prev
            : nextFiles[0]?.filePath ?? null,
        );
      })
      .catch((e) => {
        if (cancelled) return;
        setFiles([]);
        setIsRepo(false);
        setSelectedPath(null);
        setTicked({ cwd, paths: NO_TICKED_PATHS });
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
        onRefreshDoneRef.current?.();
      });
    return () => { cancelled = true; };
  }, [cwd, refreshToken]);

  useEffect(() => {
    if (!selectedPath) {
      setPatch(null);
      setPatchSupported(true);
      setPatchError(null);
      return;
    }
    const requestId = ++patchRequestRef.current;
    setPatchLoading(true);
    setPatchError(null);
    fetchPatch(cwd, selectedPath)
      .then((diff) => {
        if (requestId !== patchRequestRef.current) return;
        setPatchSupported(diff.supported);
        setPatch(typeof diff.patch === "string" ? diff.patch : null);
      })
      .catch((e) => {
        if (requestId !== patchRequestRef.current) return;
        setPatch(null);
        setPatchSupported(true);
        setPatchError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (requestId === patchRequestRef.current) setPatchLoading(false);
      });
  }, [cwd, selectedPath, refreshToken]);

  const filteredFiles = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) =>
      normalizeFilePathSlashes(getRelativeFilePath(f.filePath, cwd)).toLowerCase().includes(q),
    );
  }, [files, filter, cwd]);

  const selectedFile = selectedPath ? files.find((f) => f.filePath === selectedPath) ?? null : null;
  const selectedRelative = selectedPath ? getRelativeFilePath(selectedPath, cwd) : "";

  const openSelected = useCallback(() => {
    if (selectedPath) onOpenFile(selectedPath, getFileName(selectedPath));
  }, [selectedPath, onOpenFile]);

  const mentionSelected = useCallback(() => {
    if (selectedPath) onAtMention?.(getRelativeFilePath(selectedPath, cwd), false);
  }, [selectedPath, cwd, onAtMention]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 8px 4px",
          flexShrink: 0,
        }}
      >
        <Search size={13} strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)" }} />
        <input
          ref={filterInputRef}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setFilter("");
            }
          }}
          placeholder={t("gitChanges.filterFiles")}
          aria-label={t("gitChanges.filterFiles")}
          style={{
            flex: 1,
            minWidth: 0,
            height: 27,
            boxSizing: "border-box",
            padding: filter ? "0 8px" : "0 8px",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            outline: "none",
            color: "var(--text)",
            fontSize: 12,
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
        />
        {filter && (
          <button
            className="git-clear-filter"
            type="button"
            onClick={() => {
              setFilter("");
              filterInputRef.current?.focus();
            }}
            title={t("fileExplorer.clearSearch")}
            aria-label={t("fileExplorer.clearSearch")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 26, height: 26, padding: 0,
              background: "none", border: "none", borderRadius: "var(--radius-control)",
              color: "var(--text-dim)", cursor: "pointer", flexShrink: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-dim)"; }}
          >
            <X size={12} strokeWidth={2.4} aria-hidden="true" />
          </button>
        )}
        <button
          className="git-refresh"
          type="button"
          onClick={() => setTreeRefreshKey((k) => k + 1)}
          title={t("gitChanges.refreshChanges")}
          aria-label={t("gitChanges.refreshChanges")}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 26, height: 26, padding: 0,
            background: "none", border: "none", borderRadius: "var(--radius-control)",
            color: "var(--text-dim)", cursor: "pointer", flexShrink: 0,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
        >
          <RefreshCw size={13} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      {loading ? (
        <div role="status" aria-live="polite" style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>{t("fileExplorer.loadingFiles")}</div>
      ) : error ? (
        <div role="alert" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 12px", fontSize: 11, color: "var(--status-error)" }}>
          <span>{error}</span>
          <button
            className="load-retry-button"
            type="button"
            onClick={() => setTreeRefreshKey((key) => key + 1)}
            style={{ minHeight: 32, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}
          >
            {t("chatWindow.retry")}
          </button>
        </div>
      ) : !isRepo ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, textAlign: "center" }}>
          <GitBranch size={26} strokeWidth={1.5} aria-hidden="true" style={{ color: "var(--text-dim)" }} />
          <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 600 }}>{t("gitChanges.notARepo")}</div>
          <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.6, maxWidth: 260 }}>{t("gitChanges.notARepoHint")}</div>
        </div>
      ) : files.length === 0 ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, textAlign: "center" }}>
          <Check size={26} strokeWidth={1.5} aria-hidden="true" style={{ color: "var(--status-success)" }} />
          <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 600 }}>{t("gitChanges.noChanges")}</div>
          <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.6, maxWidth: 260 }}>{t("gitChanges.noChangesHint")}</div>
        </div>
      ) : (
        <>
          <div
            style={{
              padding: "0 12px 4px",
              fontSize: 10,
              color: "var(--text-dim)",
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span>{tn("gitChanges.filesChanged", files.length)}</span>
            {tickedPaths.size > 0 && <span aria-hidden="true">·</span>}
            <span className="git-change-ticked-count">
              {tickedPaths.size > 0 ? tn("gitChanges.tickedCount", tickedPaths.size) : ""}
            </span>
          </div>
          <div role="listbox" aria-label={t("tabBar.git")} style={{ flex: "0 1 auto", maxHeight: "38%", minHeight: 60, overflowY: "auto", overflowX: "hidden", padding: "0 4px", flexShrink: 1, borderBottom: "1px solid var(--border)" }}>
            {filteredFiles.length === 0 ? (
              <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>{t("fileExplorer.noMatchingFiles")}</div>
            ) : filteredFiles.map((file) => {
              const relative = getRelativeFilePath(file.filePath, cwd);
              const name = getFileName(relative);
              const directory = getFileDirectory(relative);
              const isSelected = file.filePath === selectedPath;
              const isHovered = file.filePath === hoveredPath;
              const isTicked = tickedPaths.has(file.filePath);
              return (
                <div
                  className="git-change-row"
                  key={file.filePath}
                  role="option"
                  tabIndex={0}
                  aria-selected={isSelected}
                  aria-label={`${name} (${t(GIT_STATUS_LABEL_KEYS[file.status])})`}
                  onClick={() => setSelectedPath(file.filePath)}
                  onDoubleClick={() => onOpenFile(file.filePath, getFileName(file.filePath))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      onOpenFile(file.filePath, getFileName(file.filePath));
                    } else if (e.key === " ") {
                      e.preventDefault();
                      setSelectedPath(file.filePath);
                    }
                  }}
                  onMouseEnter={() => setHoveredPath(file.filePath)}
                  onMouseLeave={() => setHoveredPath((prev) => (prev === file.filePath ? null : prev))}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    paddingLeft: 8,
                    paddingRight: 8,
                    height: 26,
                    cursor: "pointer",
                    background: isSelected ? "var(--bg-selected)" : isHovered ? "var(--bg-hover)" : "transparent",
                    borderRadius: "var(--radius-control)",
                    userSelect: "none",
                    boxShadow: isSelected ? "inset 2px 0 0 var(--accent)" : "none",
                    outline: "none",
                  }}
                >
                  <span style={{ flexShrink: 0, display: "flex", alignItems: "center", color: "var(--text-dim)" }}>
                    {getFileIcon(name, 14)}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      color: "var(--text)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      flex: directory ? "0 1 auto" : 1,
                      maxWidth: directory ? "60%" : undefined,
                    }}
                    title={file.filePath}
                  >
                    {name}
                  </span>
                  {directory && (
                    <span
                      style={{
                        flex: "1 1 auto",
                        minWidth: 0,
                        fontSize: 11,
                        color: "var(--text-dim)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        direction: "rtl",
                        textAlign: "left",
                      }}
                      title={file.filePath}
                    >
                      {directory}
                    </span>
                  )}
                  <span
                    title={t(GIT_STATUS_LABEL_KEYS[file.status])}
                    aria-hidden="true"
                    style={{
                      width: 14,
                      flexShrink: 0,
                      color: GIT_STATUS_COLORS[file.status],
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      fontWeight: 600,
                      textAlign: "center",
                    }}
                  >
                    {file.code}
                  </span>
                    <button
                      className="git-change-tick"
                      type="button"
                      role="checkbox"
                      aria-checked={isTicked}
                      aria-label={`${isTicked ? t("gitChanges.untickFile") : t("gitChanges.tickFile")}: ${name}`}
                      title={isTicked ? t("gitChanges.untickFile") : t("gitChanges.tickFile")}
                      onClick={(e) => {
                        // The row click is the diff viewer's selection; a tick must
                        // never move it.
                        e.stopPropagation();
                        toggleTick(file.filePath);
                      }}
                      style={{
                        flexShrink: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 18,
                        height: 18,
                        padding: 0,
                        background: isTicked ? "var(--accent)" : "var(--bg-panel)",
                        border: `1px solid ${isTicked ? "var(--accent)" : "var(--border)"}`,
                        borderRadius: "var(--radius-control)",
                        color: isTicked ? "var(--bg)" : "var(--text-dim)",
                        cursor: "pointer",
                      }}
                    >
                      {isTicked && <Check size={11} strokeWidth={2.6} aria-hidden="true" />}
                    </button>
                    <button
                      className="git-change-open-action"
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenFile(file.filePath, getFileName(file.filePath));
                      }}
                      title={t("gitChanges.openFile")}
                      aria-label={t("gitChanges.openFile")}
                      style={{
                        flexShrink: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 24,
                        height: 24,
                        background: "var(--bg-panel)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-control)",
                        color: "var(--text-muted)",
                        cursor: "pointer",
                      }}
                    >
                      <ExternalLink size={11} strokeWidth={2.2} aria-hidden="true" />
                    </button>
                </div>
              );
            })}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 12px",
              borderBottom: "1px solid var(--border)",
              flexShrink: 0,
              minWidth: 0,
            }}
          >
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: "var(--text)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={selectedRelative}
            >
              {selectedRelative}
            </span>
            {selectedFile && (
              <span
                title={t(GIT_STATUS_LABEL_KEYS[selectedFile.status])}
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: GIT_STATUS_COLORS[selectedFile.status],
                  flexShrink: 0,
                }}
              >
                {t(GIT_STATUS_LABEL_KEYS[selectedFile.status])}
              </span>
            )}
            {onAtMention && (
              <button
                className="git-change-mention-action"
                type="button"
                onClick={mentionSelected}
                disabled={!selectedPath}
                title={t("fileExplorer.insertPathIntoChat")}
                aria-label={t("fileExplorer.insertPathIntoChat")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                  height: 22, padding: "0 7px",
                  background: "var(--bg-panel)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-control)",
                  color: selectedPath ? "var(--accent)" : "var(--text-dim)",
                  cursor: selectedPath ? "pointer" : "default",
                  opacity: selectedPath ? 1 : 0.6,
                  fontSize: 11, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0,
                }}
              >
                <AtSign size={11} strokeWidth={2.2} aria-hidden="true" />
                {t("fileExplorer.mention")}
              </button>
            )}
            <button
              className="git-change-footer-open"
              type="button"
              onClick={openSelected}
              disabled={!selectedPath}
              title={t("gitChanges.openFile")}
              aria-label={t("gitChanges.openFile")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 26, height: 22, padding: 0,
                background: "var(--bg-panel)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-control)",
                color: "var(--text-muted)",
                cursor: selectedPath ? "pointer" : "default",
                opacity: selectedPath ? 1 : 0.6,
                flexShrink: 0,
              }}
            >
              <ExternalLink size={11} strokeWidth={2.2} aria-hidden="true" />
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: "auto", background: "var(--bg)" }}>
            {patchLoading ? (
              <div role="status" aria-live="polite" style={{ padding: "12px 16px", fontSize: 12, color: "var(--text-dim)" }}>{t("fileViewer.loading")}</div>
            ) : patchError ? (
              <div role="alert" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "12px 16px", fontSize: 12, color: "var(--status-error)" }}>
                <span>{patchError}</span>
                <button
                  className="load-retry-button"
                  type="button"
                  onClick={() => setTreeRefreshKey((key) => key + 1)}
                  style={{ minHeight: 32, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}
                >
                  {t("chatWindow.retry")}
                </button>
              </div>
            ) : !patchSupported || patch === null ? (
              <div style={{ padding: "12px 16px", fontSize: 12, color: "var(--text-dim)" }}>{t("gitChanges.diffUnavailable")}</div>
            ) : (
              <DiffView patch={patch} />
            )}
          </div>
        </>
      )}

      {/* The commit message box. It sits with the changed files rather than in the
          toolbar because that is what it describes, and because a message box in
          a 26px toolbar row would be unreadable. The button that consumes it is
          in the toolbar above; its disabled state is the honest signal that this
          box needs more than it has. */}
      {isRepo && !loading && !error && (
        <div className="git-commit-box" style={{ flexShrink: 0, padding: "6px 8px", borderTop: "1px solid var(--border)" }}>
          <textarea
            className="git-commit-message"
            value={commitMessage}
            onChange={(e) => onCommitMessageChange(e.target.value)}
            rows={2}
            placeholder={t("gitChanges.commitMessagePlaceholder")}
            aria-label={t("gitChanges.commitMessage")}
            onKeyDown={(e) => {
              if (e.key === "Escape") e.stopPropagation();
            }}
            style={{
              display: "block",
              width: "100%",
              boxSizing: "border-box",
              minHeight: 46,
              maxHeight: 140,
              padding: "5px 7px",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-control)",
              outline: "none",
              color: "var(--text)",
              fontSize: 12,
              lineHeight: 1.5,
              fontFamily: "inherit",
              resize: "vertical",
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
          />
          {/* Fills the box from the ticked files' own change kinds. A button, not
              an effect: auto-filling on every tick change would overwrite a message
              the user had already started typing. */}
          <button
            type="button"
            className="git-suggest-message"
            disabled={tickedPaths.size === 0 || commitMessage.trim().length > 0}
            onClick={suggestMessageFromTicks}
            style={{
              marginTop: 5,
              padding: "3px 8px",
              fontSize: 11,
              background: "transparent",
              color: tickedPaths.size === 0 ? "var(--text-dim)" : "var(--text-muted)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-control)",
              cursor: tickedPaths.size === 0 ? "default" : "pointer",
            }}
          >
            {t("gitChanges.suggestMessage")}
          </button>
        </div>
      )}

      {/* git's real output, streamed. */}
      {operation && (
        <GitOperationStrip
          operation={operation}
          canCancel={canCancelOperation}
          onCancel={onCancelOperation}
        />
      )}
    </div>
  );
}
