import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAgentDir } from "./omp/paths";

// ============================================================================
// The `known_hosts` file — the one path, and the reason accept-new is a
// decision rather than a rubber stamp.
//
// `StrictHostKeyChecking=accept-new` (lib/ssh-key-material.ts) does exactly one
// thing beyond asking: it refuses to continue when the host presents a key that
// is ALREADY in the file and does not match. That refusal is the entire security
// value of the design, and it exists only if the file survives between clones.
//
// Which is why the file lives in getAgentDir() rather than beside the temporary
// key material:
//   - it must be on the persisted `/root/.omp` volume, so a container recreate
//     does not silently reset every host to unverified, and
//   - it must be SHARED, because a host key is a property of the host, not of
//     the credential that happens to be used for it today.
//
// It holds PUBLIC keys only — that is what a known_hosts file is — so nothing
// here is a secret and the 0o600 mode is ssh's requirement rather than
// omp-web's own: OpenSSH ignores a known_hosts file that is group- or
// world-writable, so a file restored from a backup with loose permissions would
// otherwise fail every clone with a "Bad owner or permissions" message. The mode
// is therefore tightened on every call, and the file is opened for append only —
// truncating it would drop every host the user has already verified.
//
// This module OWNS the path. lib/ssh-key-material.ts embeds it in
// GIT_SSH_COMMAND rather than deciding one of its own, because two files that
// each believe they know where known_hosts lives is how a clone ends up trusting
// a file nobody is reading.
// ============================================================================

export const KNOWN_HOSTS_FILE = "known_hosts";

/** The single source of truth for where the host keys live. */
export function knownHostsPath(): string {
  return resolve(getAgentDir(), KNOWN_HOSTS_FILE);
}

/**
 * Make sure the file exists, is owner-only, and is empty or already populated.
 * Returns its path, so a caller can pass it straight into `GIT_SSH_COMMAND`.
 *
 * Fails loudly instead of degrading: a known_hosts path that cannot be created
 * would otherwise surface much later as an OpenSSH error with no connection to
 * the cause.
 */
export function ensureKnownHostsFile(): string {
  const path = knownHostsPath();
  mkdirSync(dirname(path), { recursive: true });
  // Append mode, never write/truncate: ssh owns the contents from here on.
  let handle: number | undefined;
  try {
    handle = openSync(path, "a", 0o600);
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
  // Unconditional: an existing file keeps whatever mode it was restored or
  // copied with, and OpenSSH refuses a writable one outright.
  chmodSync(path, 0o600);
  return path;
}