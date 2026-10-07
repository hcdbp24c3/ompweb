"use client";

/**
 * Where the Git tab's write surface lives, and why it is not a `useState` in
 * `RightPanel`.
 *
 * The three buttons are in RightPanel's toolbar and the message box and the
 * output are in `GitChangesPanel`, which are two places in the tree with no
 * common owner but `RightPanel` itself. Hoisting the state there is the obvious
 * wiring — and it breaks the reason `RightPanel` is memoised at all: that comment
 * on the component says the panel is skipped so AppShell's polls do not
 * "reconcile all of that per update". State in `RightPanel` means every keystroke
 * in the commit box re-renders the tab bar, the full file tree and every open
 * file viewer, which is exactly the cost the memo boundary exists to avoid.
 *
 * A provider fixes it without moving a single button: `children` is referentially
 * stable across the provider's own re-renders, so React skips the whole `<aside>`
 * subtree and only the two consumers update. `RightPanel` does not re-render at
 * all when the state changes, so the memo boundary is intact.
 *
 * The hook itself stays in `hooks/useGitActions.ts` — this file is only the
 * bridge between the two ends of the panel.
 */
import { createContext, useContext, type ReactNode } from "react";
import { useGitActions, type UseGitActions } from "@/hooks/useGitActions";

const GitActionsContext = createContext<UseGitActions | null>(null);

export function GitActionsProvider({
  cwd,
  onChanged,
  children,
}: {
  /** The directory the tab is browsing. null until a project is selected, which
   *  is the state in which no write may be started. */
  cwd: string | null;
  onChanged?: () => void;
  children: ReactNode;
}) {
  const actions = useGitActions({ cwd, onChanged });
  return <GitActionsContext.Provider value={actions}>{children}</GitActionsContext.Provider>;
}

/** The surface, or null outside the provider. Callers are inside the panel, so a
 *  missing provider is a wiring bug rather than a state to handle — but returning
 *  null keeps the failure a clear render error instead of an undefined deref. */
export function useGitActionsContext(): UseGitActions | null {
  return useContext(GitActionsContext);
}