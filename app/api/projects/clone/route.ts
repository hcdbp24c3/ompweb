import { spawn } from "child_process";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { validateGitRef } from "@/lib/git-branch";
import { cloneDirectoryName } from "@/lib/git-clone";
import { AmbiguousGitCredentialError, gitCredentialEnv, resolveCredential } from "@/lib/git-credential-resolve";
import { loadGitCredentials } from "@/lib/git-credentials";
import { ProjectPathError, validateProjectPath } from "@/lib/project-registry";
import { hostChildEnv } from "@/lib/project-command-env";

// In-flight clones by client-chosen id, so DELETE can cancel one while its
// POST stream stays open to report the cleanup.
const clones = new Map<string, AbortController>();
const CLONE_ID = /^[A-Za-z0-9-]{1,64}$/;

type CloneFrame =
  | { type: "output"; text: string }
  | { type: "done"; path: string }
  | { type: "cancelled"; path: string }
  | { type: "error"; error: string; code: string };

/** Runs `git clone`, streaming its output. Resolves the exit code, or null if
 *  git could not start. Never prompts: credentials must come from helpers/agents
 *  or from `credentialEnv`, which answers the request git would otherwise ask
 *  about — so the empty GIT_ASKPASS below stays empty.
 *  On POSIX git leads its own session (no controlling terminal, so ssh fails
 *  fast on host-key or passphrase prompts instead of blocking on /dev/tty) and
 *  cancel signals the whole group: ssh/remote helpers hold the output pipes
 *  open, so killing git alone would leave the clone hanging until they exit.
 *  `ref` (already validated) goes before the `--`, which ends option parsing:
 *  after it, `--branch` would be read as the repository URL and `ref` as the
 *  target directory. It never reaches the target name, which comes from the URL. */
function runGitClone(url: string, target: string, ref: string | null, credentialEnv: Record<string, string>, signal: AbortSignal, onOutput: (text: string) => void): Promise<number | null> {
  // Aborted while the target was being created: skip git; the caller cleans up.
  if (signal.aborted) return Promise.resolve(null);
  const { promise, resolve } = Promise.withResolvers<number | null>();
  const child = spawn("git", ["clone", "--progress", ...(ref ? ["--branch", ref] : []), "--", url, target], {
    stdio: ["ignore", "pipe", "pipe"],
    // An empty GIT_ASKPASS also overrides core.askPass/SSH_ASKPASS fallbacks.
    // The credential, when there is one, arrives as GIT_CONFIG_* — environment
    // only, so it is in neither the argv nor the URL nor the streamed output.
    env: hostChildEnv({ GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", GIT_ALLOW_PROTOCOL: "https:ssh", ...credentialEnv }),
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const kill = () => {
    if (!child.pid) return;
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      return;
    }
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Group already gone.
    }
  };
  signal.addEventListener("abort", kill, { once: true });
  child.stdout.setEncoding("utf8").on("data", onOutput);
  child.stderr.setEncoding("utf8").on("data", onOutput);
  child.on("error", () => resolve(null));
  child.on("close", (code) => {
    signal.removeEventListener("abort", kill);
    resolve(code);
  });
  return promise;
}

// POST /api/projects/clone  body: { id, parent, url, branch? }
// Clones `url` into `<parent>/<repo name>` — the name comes from the URL alone,
// never from `branch` — and streams NDJSON frames: output chunks, then exactly
// one of done / cancelled / error. The target is removed on failure or
// cancellation (DELETE, or the client disconnecting).
export async function POST(req: Request) {
  let body: { id?: unknown; parent?: unknown; url?: unknown; branch?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request", code: "invalid_request" }, { status: 400 });
  }
  const id = typeof body.id === "string" && CLONE_ID.test(body.id) ? body.id : null;
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const name = cloneDirectoryName(url);
  // Optional branch, tag or commit. Re-checked here, not trusted from the
  // browser: an absent or blank value means the default branch, anything else
  // that is not a ref git could take is refused before a directory is created.
  const requestedRef = typeof body.branch === "string" ? body.branch.trim() : "";
  const ref = validateGitRef(requestedRef);
  if (!id || clones.has(id)) return NextResponse.json({ error: "Invalid request", code: "invalid_request" }, { status: 400 });
  if (!name) return NextResponse.json({ error: "Enter an https:// or ssh Git URL", code: "invalid_git_url" }, { status: 400 });
  if (requestedRef && !ref) return NextResponse.json({ error: "Enter a valid branch, tag or commit", code: "invalid_git_ref" }, { status: 400 });
  let target: string;
  try {
    target = join(validateProjectPath(typeof body.parent === "string" ? body.parent : ""), name);
  } catch (error) {
    if (error instanceof ProjectPathError) return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    throw error;
  }
  // Resolved before the target is created: a store that cannot say which
  // credential this remote wants is refused with a 400 rather than answered by
  // cloning as whichever record happened to be first. The resolution is url-only
  // — a clone target does not exist yet, so there is no cwd to resolve.
  let credentialEnv: Record<string, string>;
  try {
    credentialEnv = gitCredentialEnv(await resolveCredential({ url, credentials: loadGitCredentials() }));
  } catch (error) {
    if (error instanceof AmbiguousGitCredentialError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }
    throw error;
  }
  // Registered before any await so a cancel sent while the target is being
  // created is not a 404; runGitClone then skips git and the stream cleans up.
  const controller = new AbortController();
  clones.set(id, controller);
  req.signal.addEventListener("abort", () => controller.abort(), { once: true });
  if (req.signal.aborted) controller.abort();
  // Creating the (empty) target up front makes the existence check atomic, so
  // cleanup only ever removes a directory this request created.
  try {
    await mkdir(target);
  } catch (error) {
    clones.delete(id);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return NextResponse.json({ error: `Already exists: ${target}`, code: "clone_target_exists" }, { status: 409 });
    }
    return apiErrorResponse(error);
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(streamController) {
      const send = (frame: CloneFrame) => {
        try {
          streamController.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        } catch {
          // Client gone; the clone still finishes its cleanup.
        }
      };
      const code = await runGitClone(url, target, ref, credentialEnv, controller.signal, (text) => send({ type: "output", text }));
      clones.delete(id);
      if (code === 0 && !controller.signal.aborted) {
        send({ type: "done", path: target });
      } else {
        const removed = await rm(target, { recursive: true, force: true, maxRetries: 5 }).then(() => true, () => false);
        if (!removed) send({ type: "error", error: `Could not remove ${target}`, code: "clone_cleanup_failed" });
        else if (controller.signal.aborted) send({ type: "cancelled", path: target });
        else if (code === null) send({ type: "error", error: "Could not run git — is it installed?", code: "git_not_found" });
        else send({ type: "error", error: `git clone exited with code ${code}`, code: "clone_failed" });
      }
      try {
        streamController.close();
      } catch {
        // Already closed by a disconnect.
      }
    },
    cancel() {
      controller.abort();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}

// DELETE /api/projects/clone  body: { id } — cancel an in-flight clone.
export async function DELETE(req: Request) {
  const body = await req.json().catch(() => ({})) as { id?: unknown };
  const controller = typeof body.id === "string" ? clones.get(body.id) : undefined;
  if (!controller) return NextResponse.json({ error: "No clone in progress", code: "clone_not_found" }, { status: 404 });
  controller.abort();
  return NextResponse.json({ ok: true });
}
