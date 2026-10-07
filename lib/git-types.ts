export type GitFileStatusKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflict";

/**
 * The four operations `/api/git/action` accepts.
 *
 * Declared here rather than in `lib/git-write.ts` because that module imports
 * `child_process`: a client that wanted the type from its natural home would pull
 * a server-only module into the browser bundle. This file is the git feature's
 * client-safe type surface, so it is the only place the union is written and both
 * sides import it.
 */
export type GitWriteAction = "stage" | "commit" | "push" | "pull";

export interface GitFileStatus {
  filePath: string;
  status: GitFileStatusKind;
  code: "M" | "A" | "D" | "R" | "U" | "C";
  indexStatus: string;
  worktreeStatus: string;
}

export interface GitStatusResponse {
  isGitRepository: boolean;
  repositoryRoot: string | null;
  files: GitFileStatus[];
}

export interface GitFileDiffResponse {
  supported: boolean;
  status?: GitFileStatusKind;
  patch?: string;
}
