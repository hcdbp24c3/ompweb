import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// skill-updates.ts imports via the "@/" path alias, which jiti resolves only
// when it is told the project root.
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@/": repoRoot } });
const {
  buildSkillUpdateArgs,
  checkSkillUpdate,
  checkSkillUpdates,
  skillUpdateKey,
} = await jiti.import("./skill-updates.ts");
const { GIT_CREDENTIAL_FILE, saveGitCredential } = await jiti.import("./git-credentials.ts");

function install(overrides = {}) {
  return {
    package: "owner/repo@example-skill",
    scope: "global",
    source: "owner/repo",
    sourceType: "github",
    skillsShUrl: "https://skills.sh/owner/repo/example-skill",
    skillPath: "skills/example-skill/SKILL.md",
    versionHash: "current-hash",
    canCheckForUpdates: true,
    ...overrides,
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("compares a global lock version with the remote Git tree", async () => {
  const seen = [];
  const upToDate = await checkSkillUpdate(install(), {
    fetcher: async (url) => {
      seen.push(url);
      return jsonResponse({
        sha: "root-hash",
        tree: [{ type: "tree", path: "skills/example-skill", sha: "current-hash" }],
      });
    },
  });

  assert.equal(upToDate.state, "up-to-date");
  assert.equal(upToDate.latestVersion, "current-hash");
  assert.match(seen[0], /repos\/owner\/repo\/git\/trees\/HEAD/);

  const available = await checkSkillUpdate(install(), {
    fetcher: async () => jsonResponse({
      sha: "root-hash",
      tree: [{ type: "tree", path: "skills/example-skill", sha: "next-hash" }],
    }),
  });
  assert.equal(available.state, "update-available");
  assert.equal(available.currentVersion, "current-hash");
  assert.equal(available.latestVersion, "next-hash");
});

test("uses the repository hash for a root global skill", async () => {
  const result = await checkSkillUpdate(install({ skillPath: "SKILL.md" }), {
    fetcher: async () => jsonResponse({ sha: "next-root", tree: [] }),
  });

  assert.equal(result.state, "update-available");
  assert.equal(result.latestVersion, "next-root");
});

test("compares a project lock version with the skills.sh snapshot", async () => {
  let requestedUrl = "";
  const result = await checkSkillUpdate(install({ scope: "project" }), {
    skillsApiBase: "https://skills.test",
    fetcher: async (url) => {
      requestedUrl = url;
      return jsonResponse({ hash: "current-hash" });
    },
  });

  assert.equal(result.state, "up-to-date");
  assert.equal(
    requestedUrl,
    "https://skills.test/api/download/owner/repo/example-skill",
  );
});

test("returns unsupported without making a remote request", async () => {
  let called = false;
  const result = await checkSkillUpdate(
    install({ canCheckForUpdates: false, versionHash: undefined }),
    { fetcher: async () => { called = true; return jsonResponse({}); } },
  );

  assert.equal(result.state, "unsupported");
  assert.equal(called, false);
});

test("returns a scoped error when the remote check fails", async () => {
  const result = await checkSkillUpdate(install(), {
    fetcher: async () => jsonResponse({}, 503),
  });

  assert.equal(result.state, "error");
  assert.equal(result.message, "HTTP 503");
  assert.equal(skillUpdateKey(install()), "global\0owner/repo@example-skill");
});

test("falls back to Git when the GitHub API is rate limited", async () => {
  let resolved = false;
  const result = await checkSkillUpdate(install(), {
    fetcher: async () => jsonResponse({}, 403),
    resolveGitTreeHash: async () => {
      resolved = true;
      return "next-hash";
    },
  });

  assert.equal(resolved, true);
  assert.equal(result.state, "update-available");
  assert.equal(result.latestVersion, "next-hash");
});

test("builds universal-agent update commands for each scope", () => {
  assert.deepEqual(buildSkillUpdateArgs(install()), [
    "skills",
    "add",
    "owner/repo/skills/example-skill",
    "--skill",
    "example-skill",
    "-y",
    "--agent",
    "universal",
    "-g",
  ]);
  assert.deepEqual(buildSkillUpdateArgs(install({ scope: "project" })), [
    "skills",
    "add",
    "owner/repo/skills/example-skill",
    "--skill",
    "example-skill",
    "-y",
    "--agent",
    "universal",
  ]);
  assert.deepEqual(buildSkillUpdateArgs(install({ ref: "release/v2" })), [
    "skills",
    "add",
    "owner/repo/skills/example-skill#release%2Fv2",
    "--skill",
    "example-skill",
    "-y",
    "--agent",
    "universal",
    "-g",
  ]);
});

test("reuses one remote request for skills from the same GitHub source", async () => {
  let requests = 0;
  const results = await checkSkillUpdates([
    install(),
    install({
      package: "owner/repo@another-skill",
      skillPath: "skills/another-skill/SKILL.md",
      versionHash: "another-hash",
    }),
  ], {
    fetcher: async () => {
      requests++;
      return jsonResponse({
        sha: "root-hash",
        tree: [
          { type: "tree", path: "skills/example-skill", sha: "current-hash" },
          { type: "tree", path: "skills/another-skill", sha: "another-hash" },
        ],
      });
    },
  });

  assert.equal(requests, 1);
  assert.deepEqual(results.map((item) => item.state), ["up-to-date", "up-to-date"]);
});

// --- the credentialed git fallback -----------------------------------------
//
// `resolveGitTreeHash` is the fallback for a rate-limited GitHub API: it runs a
// real `git fetch` against `https://github.com/<source>.git`. The default
// implementation is what these tests drive, through a fake `git` on PATH that
// records its own environment and argv, because the properties that matter
// (which credential was selected, and where the token reached git) exist only in
// the child process.

let gitRoot;
let gitEnvPath;
let gitArgvPath;
let originalPath;
let originalAgentDir;
const ambientGitConfig = [];

before(() => {
  gitRoot = mkdtempSync(join(tmpdir(), "omp-web-skill-git-"));
  gitEnvPath = join(gitRoot, "git-env.txt");
  gitArgvPath = join(gitRoot, "git-argv.txt");
  // `rev-parse` has to answer with something the caller accepts as a tree hash;
  // every other subcommand is a no-op, since nothing here touches the network.
  const shim = join(gitRoot, "git");
  writeFileSync(shim, `#!/bin/sh\nenv > "${gitEnvPath}"\nprintf '%s\\n' "$*" > "${gitArgvPath}"\ncase "$*" in *rev-parse*) printf '%040d\\n' 0;; esac\nexit 0\n`, "utf8");
  chmodSync(shim, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${gitRoot}${delimiter}${originalPath}`;
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(gitRoot, "agent");
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  // Some environments inject their own git credentials through GIT_CONFIG_*,
  // and hostChildEnv deliberately keeps them — so "nothing was added" is only
  // assertable from a clean start.
  for (const name of Object.keys(process.env)) {
    if (!/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(name)) continue;
    ambientGitConfig.push([name, process.env[name]]);
    delete process.env[name];
  }
});

after(() => {
  process.env.PATH = originalPath;
  for (const [name, value] of ambientGitConfig) process.env[name] = value;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(gitRoot, { recursive: true, force: true });
});

function storeCredentials(records) {
  rmSync(join(process.env.PI_CODING_AGENT_DIR, GIT_CREDENTIAL_FILE), { force: true });
  for (const record of records) saveGitCredential(record);
}

function recordedGitEnv() {
  const environment = {};
  for (const line of readFileSync(gitEnvPath, "utf8").split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) environment[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return environment;
}

function recordedGitArgv() {
  return readFileSync(gitArgvPath, "utf8").split("\n");
}

function decodedCredential(env) {
  return Buffer.from(env.GIT_CONFIG_VALUE_0.replace("AUTHORIZATION: basic ", ""), "base64").toString("utf8");
}

/** The GitHub API refusing us is what sends the check to git. */
const rateLimited = { fetcher: async () => jsonResponse({}, 403) };

const OWNER_PAT = { name: "owner personal", host: "github.com", account: "owner", type: "pat", token: "ghp_owner_token" };
const OTHER_PAT = { name: "org pat", host: "github.com", account: "some-org", type: "pat", token: "ghp_other_token" };

test("the skill git fetch authenticates as the source owner, resolved from the url alone", { skip: process.platform === "win32" }, async () => {
  storeCredentials([OTHER_PAT, OWNER_PAT]);
  const previous = process.env.OMP_WEB_PASSWORD;
  process.env.OMP_WEB_PASSWORD = "web-secret";
  let result;
  try {
    result = await checkSkillUpdate(install(), rateLimited);
  } finally {
    if (previous === undefined) delete process.env.OMP_WEB_PASSWORD;
    else process.env.OMP_WEB_PASSWORD = previous;
  }

  assert.equal(result.state, "update-available");
  assert.match(result.latestVersion, /^[0-9a-f]{40}$/);
  const env = recordedGitEnv();
  assert.equal(env.GIT_CONFIG_COUNT, "1");
  assert.equal(env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
  assert.equal(decodedCredential(env), "x-access-token:ghp_owner_token");
  assert.equal(env.OMP_WEB_PASSWORD, undefined, "a host secret must not ride along into a git child");
  // The lock entry has no directory, so resolution must never invent one.
  assert.equal(recordedGitArgv().some((line) => line.startsWith("-C") || line.includes(" config")), false);
  assert.equal(recordedGitArgv().some((line) => line.includes("ghp_")), false, "never in argv");
});

test("an ambiguous credential store fails the check with an explanation rather than guessing", { skip: process.platform === "win32" }, async () => {
  storeCredentials([OTHER_PAT, { ...OWNER_PAT, account: "another-org", name: "another org", token: "ghp_third_token" }]);

  const result = await checkSkillUpdate(install(), rateLimited);

  assert.equal(result.state, "error");
  assert.match(result.message, /another org/);
  assert.equal(result.message.includes("ghp_"), false);
});

test("no stored credential leaves the git environment without a credential header", { skip: process.platform === "win32" }, async () => {
  storeCredentials([]);

  const result = await checkSkillUpdate(install(), rateLimited);

  assert.equal(result.state, "update-available");
  assert.deepEqual(Object.keys(recordedGitEnv()).filter((name) => name.startsWith("GIT_CONFIG")), []);
});
