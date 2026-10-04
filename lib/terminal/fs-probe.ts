import { existsSync, statSync } from "fs";

/**
 * "Does this path exist, and is it a directory?" as one decision.
 *
 * existsSync() and statSync() are two calls, and a directory can be removed in
 * between — the first answers true and the second throws ENOENT. This runs on
 * the per-keystroke path, where the terminal user is the one deleting the
 * directory the panel is posting to, so the race is reachable rather than
 * theoretical.
 *
 * It stays in its own module, and lets the throw out, so the guard can be the
 * single place that decides what a vanished directory means. Swallowing it here
 * would make that policy untestable.
 */
export function isExistingDirectory(target: string): boolean {
  return existsSync(target) && statSync(target).isDirectory();
}
