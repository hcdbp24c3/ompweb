import { NextResponse } from "next/server";
import fs from "fs";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { AmbiguousGitCredentialError } from "@/lib/git-credential-resolve";
import { resolveGhEnvForCwd } from "@/lib/gh-env";
import { isWindowsAbsolutePath } from "@/lib/paths";

// Auth is proxy.ts's job: every /api/ route sits behind the same web-password
// gate, so there is no per-route authorization to extend here.
//
// Why this route exists at all: `gh` runs *inside* the omp child and inside a
// terminal shell, and neither can call a browser endpoint to ask for a token —
// they are handed the environment at spawn time. So the delivery surfaces are
// lib/gh-env.ts's ghEnvForSpawn() at the two spawn sites, not this route. What
// this route is for is the same thing the credential settings panel needs: seeing
// which credential a given repository resolves to, without starting a session.
//
// It therefore answers with the token because that is the whole question — but
// it is a *read* of a secret on a route the browser can reach, which is a
// different risk profile from the store's own GET (that one returns summaries
// only, and this task's store deliberately never serializes a token). Two
// properties keep it bounded:
//   - the cwd must pass the same allowlist /api/github-repo and /api/files use,
//     so it cannot be pointed at an arbitrary directory to probe the store;
//   - an undecidable store is a 409, never a guess.

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const cwd = new URL(request.url).searchParams.get("cwd")?.trim() ?? "";
  // Absolute only: a relative cwd would resolve against the server's own
  // working directory, which is /app inside the image — not the repository the
  // caller meant.
  if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
    return NextResponse.json({ error: "cwd must be an absolute path", code: "cwd_must_be_absolute" }, { status: 400 });
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(cwd, allowedRoots)) {
    return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
  }
  // Same probe /api/github-repo does, and for the same reason: a directory that
  // is gone answers `{}` from resolution, which is indistinguishable from "this
  // repository has no credential" and hides a stale cwd from the caller.
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    return NextResponse.json({ error: "Directory not found", code: "directory_not_found" }, { status: 404 });
  }
  if (!stat.isDirectory()) {
    return NextResponse.json({ error: "Not a directory", code: "not_a_directory" }, { status: 400 });
  }

  try {
    return NextResponse.json(await resolveGhEnvForCwd(cwd));
  } catch (error) {
    if (error instanceof AmbiguousGitCredentialError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
    }
    console.error("[api/git-credentials/gh-env] resolution failed:", error);
    return NextResponse.json({ error: "Could not resolve a git credential for this directory" }, { status: 500 });
  }
}