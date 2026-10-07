import type { GitFileStatus, GitFileStatusKind } from "./git-types";

/**
 * How the commit message box is filled.
 *
 * `auto` derives the message from the ticked files' own change kinds — no model,
 * no network, no diff parsing, so it cannot fail and cannot be wrong about which
 * files are in the commit. `ai` asks a model to write one; it is declared here so
 * the setting can be persisted and rendered, but no generator for it exists yet
 * (see `.hive/features/ui-polish-and-scale/context/commit-message-two-modes.md`
 * for the measurement that has to come first). Callers must therefore treat `ai`
 * as "no generator", never as "an empty result".
 */
export type CommitMessageMode = "ai" | "auto";

export const COMMIT_MESSAGE_MODE_KEY = "omp-web:commit-message-mode";

/**
 * Ordered so the two kinds that change what the user must do come first: a
 * conflict stops the commit outright, and a deletion is the other change that is
 * routinely not what the author meant. The rest follow the commit's own arc —
 * new, added, renamed, then edited.
 */
const GROUP_ORDER: readonly GitFileStatusKind[] = [
  "conflict",
  "deleted",
  "renamed",
  "untracked",
  "added",
  "modified",
];

const GROUP_LABEL: Record<GitFileStatusKind, string> = {
  conflict: "conflicted",
  deleted: "removed",
  renamed: "renamed",
  untracked: "new",
  added: "added",
  modified: "updated",
};

export interface SummarizeOptions {
  /** Paths spelled out per group before it collapses to a count. */
  maxPathsPerGroup?: number;
}

const DEFAULT_MAX_PATHS_PER_GROUP = 3;

const DIGITS = /(\d+)/;

/**
 * Natural order, so a change across `f1.ts … f11.ts` lists `f1, f2, f3` rather
 * than `f1, f10, f11, f2`. Pure lexicographic order is deterministic but reads
 * as a bug in a commit subject, and the whole point of this message is to be
 * read by a person.
 *
 * Runs of digits compare numerically and everything else compares by code unit,
 * which keeps the result independent of the runtime's locale data — two users
 * with the same files must get byte-identical subjects.
 */
function comparePaths(a: string, b: string): number {
  const ax = a.split(DIGITS);
  const bx = b.split(DIGITS);
  for (let i = 0; i < Math.max(ax.length, bx.length); i += 1) {
    const left = ax[i];
    const right = bx[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const ln = /^\d+$/.test(left);
    const rn = /^\d+$/.test(right);
    // A numeric chunk against a non-numeric one is compared as text; treating it
    // as 0 would silently sort "2" and "10" of different names together.
    if (ln && rn) {
      const diff = Number(left) - Number(right);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * "updated src/a.ts, src/b.ts; removed c.ts; +7 more"
 *
 * A subject line, not a log: every ticked file appears, but only the first few
 * per group are spelled out. A 100-file mechanical refactor has to produce
 * something readable, and it will not readably if it lists 100 paths.
 *
 * Returns "" for no files, so a caller can treat "nothing to say" and "said
 * nothing" as the same condition rather than committing an empty message.
 */
export function summarizeTickedChanges(
  files: readonly Pick<GitFileStatus, "filePath" | "status">[],
  options: SummarizeOptions = {},
): string {
  const maxPaths = options.maxPathsPerGroup ?? DEFAULT_MAX_PATHS_PER_GROUP;
  if (files.length === 0) return "";

  const groups = new Map<GitFileStatusKind, string[]>();
  for (const file of files) {
    const bucket = groups.get(file.status);
    if (bucket) bucket.push(file.filePath);
    else groups.set(file.status, [file.filePath]);
  }

  // GROUP_ORDER drives the output, not Map insertion order: the order files were
  // ticked in is not an order anyone reads a commit subject in, and relying on it
  // would make the same change produce a different subject every time.
  const ordered = GROUP_ORDER.filter((kind) => groups.has(kind));
  const parts: string[] = [];
  let hidden = 0;

  for (const kind of ordered) {
    const paths = groups.get(kind) ?? [];
    // Sorted, not tick order: the same set of files clicked in a different order
    // must produce the same subject, or the message looks like it was chosen at
    // random. Plain comparison rather than `localeCompare` — the latter's result
    // depends on the runtime's ICU data, so two users could get different subjects
    // for identical input.
    paths.sort(comparePaths);
    const shown = paths.slice(0, maxPaths);
    hidden += Math.max(0, paths.length - shown.length);
    parts.push(`${GROUP_LABEL[kind]} ${shown.join(", ")}`);
  }

  // An unknown kind must not be dropped: this module is the last place that can
  // still account for a file before it is silently left out of the subject.
  let unknown = 0;
  for (const [kind, paths] of groups) {
    if (!GROUP_ORDER.includes(kind)) unknown += paths.length;
  }
  hidden += unknown;
  if (unknown > 0) parts.push(`${unknown} other`);

  return hidden > 0 ? `${parts.join("; ")}; +${hidden} more` : parts.join("; ");
}

function isCommitMessageMode(value: unknown): value is CommitMessageMode {
  return value === "ai" || value === "auto";
}

/**
 * localStorage, so it is unreadable until mounted and it throws in private
 * browsing. Both are ordinary, so both fall back rather than propagating: a
 * cosmetic preference must never be the reason the Git tab does not render.
 */
export function readCommitMessageMode(): CommitMessageMode {
  try {
    const stored = globalThis.localStorage?.getItem(COMMIT_MESSAGE_MODE_KEY);
    return isCommitMessageMode(stored) ? stored : "auto";
  } catch {
    return "auto";
  }
}

export function writeCommitMessageMode(mode: CommitMessageMode): void {
  try {
    globalThis.localStorage?.setItem(COMMIT_MESSAGE_MODE_KEY, mode);
  } catch {
    // A mode that cannot be remembered is still a mode for this session.
  }
}