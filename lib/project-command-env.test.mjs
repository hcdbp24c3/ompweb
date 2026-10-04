import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { sanitizeProjectCommandEnvironment, hostChildEnv } = await jiti.import("./project-command-env.ts");

const BASE = {
  PATH: "/usr/bin",
  HOME: "/root",
  LC_ALL: "C",
  // Host configuration.
  PORT: "30177",
  NODE_ENV: "production",
  NEXT_PUBLIC_APP_NAME: "omp-web",
  // Host secrets. These are the values a child process must never see.
  OMP_WEB_PASSWORD: "hunter2",
  OMP_WEB_STT_KEY: "sk-speech-secret",
  // omp-web host plumbing, none of which describes the selected project.
  OMP_WEB_OMP_BIN: "/usr/local/bin/omp",
  OMP_WEB_HOSTNAME: "127.0.0.1",
  OMP_WEB_PORT: "30177",
  OMP_WEB_LAUNCHER_PID: "1234",
  OMP_WEB_PACKAGE_DIR: "/opt/ompweb",
  OMP_WEB_STT_ENDPOINT: "https://stt.example/v1",
  OMP_WEB_STT_MODEL: "whisper-1",
};

test("the web password never reaches a child process", () => {
  const env = sanitizeProjectCommandEnvironment(BASE, "linux");
  assert.equal(env.OMP_WEB_PASSWORD, undefined);
});

test("nor does the speech-to-text API key, which is the second host secret", () => {
  const env = sanitizeProjectCommandEnvironment(BASE, "linux");
  assert.equal(env.OMP_WEB_STT_KEY, undefined);
});

test("every OMP_WEB_* variable is dropped: they are host plumbing, not project state", () => {
  // An enumeration would rot: a future OMP_WEB_* secret would silently leak.
  // None of these describe the selected project, and no child binary reads them.
  const env = sanitizeProjectCommandEnvironment(BASE, "linux");
  const leaked = Object.keys(env).filter((name) => name.startsWith("OMP_WEB_"));
  assert.deepEqual(leaked, [], "no OMP_WEB_* survives");
});

test("the variable actually being stripped is the one omp-web reads", () => {
  // Guards against renaming the env var without updating this rule.
  const webAuth = readFileSync(join(repoRoot, "lib/web-auth.ts"), "utf8");
  assert.match(webAuth, /process\.env\.OMP_WEB_PASSWORD/);
});

test("project-visible environment is preserved", () => {
  const env = sanitizeProjectCommandEnvironment(BASE, "linux");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/root");
  assert.equal(env.LC_ALL, "C");
});

test("unrelated secrets the user set for their project are left alone", () => {
  // Only the host's own variables go. A user's OPENAI_API_KEY belongs to their
  // shell and to omp, so stripping it would break the thing this app exists to do.
  const env = sanitizeProjectCommandEnvironment({ ...BASE, OPENAI_API_KEY: "sk-user" }, "linux");
  assert.equal(env.OPENAI_API_KEY, "sk-user");
});

test("windows comparison is case-insensitive, as the existing rules already are", () => {
  const env = sanitizeProjectCommandEnvironment(
    { ...BASE, omp_web_password: "lowercase-on-windows" },
    "win32",
  );
  assert.equal(env.omp_web_password, undefined);
  // The lowercase spelling must survive on a case-sensitive platform.
  const posix = sanitizeProjectCommandEnvironment({ ...BASE, omp_web_password: "keep" }, "linux");
  assert.equal(posix.omp_web_password, "keep");
});

test("hostChildEnv composes the sanitized base with caller overrides", () => {
  const env = hostChildEnv({ LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" });
  assert.equal(env.OMP_WEB_PASSWORD, undefined);
  assert.equal(env.OMP_WEB_STT_KEY, undefined);
  assert.equal(env.LC_ALL, "C");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
});

test("hostChildEnv applies sanitization after the caller's overrides, so a caller cannot reintroduce a host secret by accident", () => {
  // Overrides are meant for things like FORCE_COLOR=0. If sanitization ran first,
  // an override could put OMP_WEB_PASSWORD back.
  const env = hostChildEnv({ OMP_WEB_PASSWORD: "reintroduced" });
  assert.equal(env.OMP_WEB_PASSWORD, undefined);
});

/** Every file that spawns a process must go through hostChildEnv or the
 *  sanitizer, so a future edit cannot quietly re-add `...process.env`. */
function spawnSites() {
  const roots = ["lib", "app", "components", "bin"];
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry) || /\.test\.mjs$/.test(entry)) continue;
      const text = readFileSync(full, "utf8");
      if (/\.\.\.process\.env/.test(text)) found.push(full);
    }
  };
  for (const root of roots) {
    try { walk(join(repoRoot, root)); } catch { /* directory absent in some layouts */ }
  }
  return found;
}

test("no module spreads process.env into a child process directly", () => {
  // lib/omp/rpc-process.ts is the one legitimate composition site: it sanitizes
  // the merged result itself and needs the raw base plus per-call overrides.
  // Two legitimate composition sites:
  //  - rpc-process.ts sanitizes the merged result itself and needs the raw base
  //    plus per-call overrides (it forces the default profile for isolated runs).
  //  - windows-service.ts builds the environment for the omp-web SERVICE itself,
  //    which must keep OMP_WEB_PASSWORD or the app cannot authenticate at all.
  //  - terminal/pty-registry.ts sanitizes its own merge and then deletes
  //    OMP_WEB_PASSWORD, because it needs to add TERM and SHELL for the shell.
  const allowed = new Set([
    "lib/omp/rpc-process.ts",
    "lib/windows-service.ts",
    "lib/terminal/pty-registry.ts",
  ]);
  const offenders = spawnSites()
    .map((file) => relative(repoRoot, file))
    .filter((file) => !allowed.has(file));
  assert.deepEqual(offenders, [], "these spread process.env into a child; use hostChildEnv()");
});