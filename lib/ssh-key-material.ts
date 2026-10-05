import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ============================================================================
// Materializing a stored SSH private key for one git child, and building the
// GIT_SSH_COMMAND that points ssh at it.
//
// WHY A FILE AT ALL. ssh takes `-i <path>`, so a key that only exists as an
// encrypted string in the store (lib/git-credentials.ts) has to reach the disk
// somehow. Writing it under getAgentDir() is what the plan forbids and what this
// module exists to avoid: that directory is the persisted volume, so a plaintext
// key there outlives the request, survives a container recreate, and is readable
// by anything with the omp user's permissions. Instead every operation gets a
// THROWAWAY directory that is removed when the operation ends.
//
// WHY mkdtemp AND NOT A FIXED PATH. A predictable filename in a shared tmpdir is
// a symlink-attack surface: whoever runs first can create
// `/tmp/omp-web-ssh-key-<id>` as a symlink to a file they want overwritten, or
// pre-create the key file to have their own key read. mkdtemp creates the
// directory atomically with a random name and 0o700, so nothing else can enter
// it. The modes are passed explicitly rather than left to umask: ssh itself
// refuses a readable identity file and a writable known_hosts, so a permissive
// umask must not decide this.
//
// WHY THERE IS NO PASSPHRASE PATH. BatchMode=yes (below) makes an encrypted key
// FAIL, immediately, instead of blocking on a prompt. That is a deliberate
// choice: the alternatives both cost something real. `sshpass` would add a
// dependency that the image does not have and put the passphrase in the child's
// environment next to the git credential; an askpass helper would be the helper
// task 09 deliberately avoided needing, and would have to be shipped in the
// image. A passphrase-protected key is therefore rejected by the server rather
// than silently waited on, which is the failure mode this whole feature exists
// to avoid. Detection is NOT attempted — reading OpenSSH's private-key header to
// see whether a cipher is named would duplicate ssh's own parser and could be
// wrong about a format we do not control.
//
// HOST KEYS. StrictHostKeyChecking=accept-new records a host the first time and
// FAILS when a host presents a different key than the one recorded. That is the
// whole security story, and it is strictly stronger than the reference product,
// which probes with ssh-keyscan, asks the browser, and hard-codes
// `isKeyChanged: false` — so a changed key arrives there as an ordinary
// first-time prompt with no comparison at all. There is no fingerprint prompt
// here on purpose: the clone POST is a one-way NDJSON stream with no round trip
// and this feature has no UI surface, so there is nobody to ask.
//
// The path in UserKnownHostsFile comes from lib/ssh-known-hosts.ts, which owns
// it. It is deliberately NOT /dev/null and NOT a per-operation temp file: a
// known_hosts that is thrown away makes every clone a fresh first-time trust and
// removes the ability to detect a change.
// ============================================================================

/** Prefix for the throwaway directories, so a leak is identifiable. */
export const SSH_KEY_DIR_PREFIX = "omp-web-ssh-key-";

/** Inside the throwaway directory. Fixed name, but the directory is not. */
const KEY_FILE = "id_ed25519";

export interface SshKeyMaterial {
  /** The throwaway directory, 0o700. */
  readonly dir: string;
  /** The key file inside it, 0o600. */
  readonly keyPath: string;
  /** Remove the directory and everything in it. Idempotent. */
  dispose(): void;
}

/** A stable classification of *why* nothing was delivered: `ssh_key_invalid`
 *  (the stored secret cannot authenticate), `ssh_key_insecure` (the filesystem
 *  would not give the key 0o600), `ssh_key_unwritable` (no usable tmpdir). It is
 *  what the tests assert on — `apiErrorResponse()` only forwards the message. */
export class SshKeyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SshKeyError";
    this.code = code;
  }
}

/**
 * Refuse material we know cannot authenticate, rather than handing ssh an
 * identity it will reject much later with no mention of the credential. A
 * public key pasted into the private-key field is the realistic case; an empty
 * field is the other.
 */
function assertUsableKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) throw new SshKeyError("ssh_key_invalid", "The SSH credential has no private key");
  const firstLine = trimmed.split("\n")[0].trim();
  // An OpenSSH/PEM private key is a BEGIN block; an armored RSA/DSA key too.
  const isPrivateKey = firstLine.startsWith("-----BEGIN");
  // `ssh-ed25519 AAAA…` and friends are PUBLIC keys. They parse as an identity
  // and then fail to authenticate, which is a confusing way to learn the paste
  // was the wrong half of the key pair.
  const looksPublic = /^(ssh-rsa|ssh-ed25519|ssh-dss|ecdsa-sha2-nistp(?:256|384|521))\s+[A-Za-z0-9+/=]+/.test(firstLine);
  if (!isPrivateKey && looksPublic) {
    throw new SshKeyError("ssh_key_invalid", "This looks like an SSH public key. Store the private key — the public half cannot authenticate.");
  }
  if (!isPrivateKey && !firstLine.includes("PRIVATE KEY")) {
    throw new SshKeyError("ssh_key_invalid", "This does not look like an SSH private key");
  }
  return trimmed;
}

/**
 * Write `privateKey` to a fresh throwaway directory and hand back the paths.
 *
 * `options.signal` makes removal abort-safe rather than `finally`-safe: the clone
 * route cancels through an AbortController and kills the whole process group,
 * so the child's `close` event can arrive long after any `finally` around it has
 * run — or never arrive at all, if a grandchild is still holding the output
 * pipes. Disposing on abort does not wait for that: the clone is already being
 * cancelled, so making ssh fail immediately is the intended outcome.
 */
export function materializeSshKey(privateKey: string, options: { signal?: AbortSignal } = {}): SshKeyMaterial {
  const key = assertUsableKey(privateKey);
  // mkdtemp(3) creates the directory 0o700 already; the chmod below restates it
  // so the mode this module depends on is visible at the call site too.
  const dir = mkdtempSync(join(tmpdir(), SSH_KEY_DIR_PREFIX));
  const keyPath = join(dir, KEY_FILE);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    options.signal?.removeEventListener("abort", dispose);
    // force + recursive: removing a directory that is already gone, or one a
    // half-written key left behind, is not a failure worth reporting.
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    // Stated rather than left to whatever mkdtemp/writeFileSync default to,
    // because ssh's opinion about who may read this directory and this file is
    // not negotiable.
    chmodSync(dir, 0o700);
    writeFileSync(keyPath, `${key}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(keyPath, 0o600);
    // A filesystem that accepts the call and then ignores the mode is the one
    // case chmod cannot report, and it fails much later as an opaque ssh error.
    //
    // Windows is excluded, and it is not a gap in the check: Node synthesises
    // 0o666 for every ordinary Windows file because NTFS has no POSIX
    // permission bits, so `mode` is always 0o666 there whatever chmod does and
    // OpenSSH-for-Windows reads the identity through Win32 without enforcing a
    // POSIX mode. The per-user temp directory plus inherited NTFS ACLs are the
    // isolation there. Asserting it made every SSH credential fail on Windows.
    if (process.platform !== "win32") {
      const mode = statSync(keyPath).mode & 0o777;
      if (mode !== 0o600) {
        throw new SshKeyError("ssh_key_insecure", `${keyPath} ended up ${mode.toString(8)}, not 600 — ssh refuses a readable identity file`);
      }
    }
  } catch (error) {
    dispose();
    throw error instanceof SshKeyError
      ? error
      : new SshKeyError("ssh_key_unwritable", `Could not stage the SSH key at ${keyPath}: ${(error as Error).message}`);
  }
  if (options.signal?.aborted) dispose();
  else options.signal?.addEventListener("abort", dispose, { once: true });
  return { dir, keyPath, dispose };
}

/** Quote for git's GIT_SSH_COMMAND parser, which understands double quotes (and
 *  only needs them for a path with a space; both paths here are ours). */
function quote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

/**
 * The command git runs for an ssh:// remote. Every `-o` here is load-bearing:
 *
 * - IdentitiesOnly=yes — offer the stored key only. Without it ssh offers every
 *   identity in the agent's default files first, and an agent that cannot use
 *   them burns the host's login attempts before reaching ours.
 * - PasswordAuthentication=no — ssh must never turn an unauthenticated remote
 *   into a password prompt nobody can answer.
 * - BatchMode=yes — THE one that prevents a hang. A passphrase-protected key
 *   makes ssh ask for it on the terminal; with no terminal that is either a hang
 *   or a confusing EOF. BatchMode turns it into an immediate failure.
 * - StrictHostKeyChecking=accept-new — record a first-seen host, fail on a
 *   changed key. Never `no`, never `ask`.
 * - UserKnownHostsFile — the shared file, so the record survives.
 *
 * `-T` disables pseudo-terminal allocation, matching the clone route's own
 * "no terminal, fail fast" posture.
 */
export function buildGitSshCommand(input: { keyPath: string; knownHosts: string }): string {
  return [
    "ssh -T",
    `-i ${quote(input.keyPath)}`,
    "-o IdentitiesOnly=yes",
    "-o PasswordAuthentication=no",
    "-o BatchMode=yes",
    "-o StrictHostKeyChecking=accept-new",
    `-o UserKnownHostsFile=${quote(input.knownHosts)}`,
  ].join(" ");
}