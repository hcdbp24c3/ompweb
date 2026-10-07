/**
 * Which changed files a commit in the Git tab should cover.
 *
 * Kept out of the component because the interesting failures are not visual: a
 * stale tick that would commit a file which is no longer modified, and a tick
 * that outlives the directory it was made in, are both about *which paths are in
 * the set*.
 *
 * The set holds the ABSOLUTE `filePath` values `getGitStatus` reports, never the
 * display-relative ones. `git commit -- <paths>` addresses absolute paths, and
 * the write layer re-authorizes every path against the session's subtree, so a
 * relative path here would either fail that boundary check or commit a
 * different file than the one whose name is on screen.
 *
 * Deliberately NOT the diff viewer's selection. `selectedPath` answers "what am I
 * looking at"; this answers "what am I committing". Sharing one state would make
 * the diff jump every time a file is ticked.
 */

/** The only field pruning needs; a `GitStatusResponse["files"]` element. */
export interface GitTickedPathSource {
  filePath: string;
}

/** Add `filePath` if absent, remove it if present. One path, never a group. */
export function toggleTickedPath(ticked: ReadonlySet<string>, filePath: string): Set<string> {
  const next = new Set(ticked);
  if (!next.delete(filePath)) next.add(filePath);
  return next;
}

/**
 * Drop every ticked path the refreshed status no longer lists.
 *
 * A tick outlives the file it was made on — the user reverts a file, or an agent
 * commits it from the terminal — and the row then disappears while the tick is
 * still in the set. Committing would send a path git no longer reports modified,
 * so the stale one is dropped here rather than filtered at the send.
 *
 * `pruneTickedPaths` never invents a path and never reorders: the result keeps
 * the order the paths were ticked in, so the list handed to a commit request is
 * stable across refreshes.
 */
export function pruneTickedPaths(
  ticked: ReadonlySet<string>,
  files: readonly GitTickedPathSource[],
): Set<string> {
  const present = new Set(files.map((file) => file.filePath));
  const next = new Set<string>();
  for (const filePath of ticked) {
    if (present.has(filePath)) next.add(filePath);
  }
  return next;
}