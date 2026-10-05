import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@/": repoRoot } });
const {
  GIT_CREDENTIAL_FILE,
  GIT_CREDENTIAL_KEY_FILE,
  deleteGitCredential,
  gitCredentialsPath,
  listGitCredentials,
  loadGitCredentials,
  saveGitCredential,
  validateGitCredentialInput,
} = await jiti.import("./git-credentials.ts");
const { DELETE, GET, PUT } = await jiti.import("../app/api/git-credentials/route.ts");

/** Point the omp agent dir at a throwaway location for the duration of `t`. */
async function withAgentDir(t) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-git-credentials-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  });
  return agentDir;
}

const PAT = { name: "GitHub PAT", host: "github.com", account: "user1", type: "pat", token: "ghp_secret_token_value" };
const SSH = { name: "Work SSH", host: "github.com", account: "user1", type: "ssh", privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----", passphrase: "key-pass" };

/** POSIX mode bits are meaningless on Windows; skip those assertions there. */
const UNIX_ONLY = process.platform === "win32" ? { skip: "POSIX file modes" } : {};

function jsonRequest(method, body) {
  return new Request("http://localhost/api/git-credentials", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a stored secret never appears in plaintext on disk, and both files are 0o600", async (t) => {
  const agentDir = await withAgentDir(t);
  saveGitCredential(PAT);
  const raw = readFileSync(join(agentDir, GIT_CREDENTIAL_FILE), "utf8");
  assert.equal(raw.includes(PAT.token), false, "token must not be readable in the store");
  assert.match(raw, /v1\./, "the secret is stored as a versioned ciphertext envelope");
  assert.equal(exists(join(agentDir, GIT_CREDENTIAL_KEY_FILE)), true, "the local key file is created on first write");
  assert.equal(statSync(join(agentDir, GIT_CREDENTIAL_FILE)).mode & 0o777, 0o600, "the store is owner-readable only");
  assert.equal(statSync(join(agentDir, GIT_CREDENTIAL_KEY_FILE)).mode & 0o777, 0o600, "the key file is owner-readable only");
  assert.deepEqual(readdirSync(agentDir).filter((name) => name.includes(".tmp-")), [], "no temp files left behind");
  // Decryption is symmetric: the secret comes back through load.
  assert.equal(loadGitCredentials()[0].token, PAT.token);
}, UNIX_ONLY);

test("the credential list and every GET response carry no secret at all", async (t) => {
  await withAgentDir(t);
  saveGitCredential(PAT);
  saveGitCredential(SSH);
  const listed = listGitCredentials();
  assert.equal(listed.path, gitCredentialsPath());
  assert.equal(listed.credentials.length, 2);
  for (const credential of listed.credentials) {
    assert.equal("token" in credential, false);
    assert.equal("privateKey" in credential, false);
    assert.equal("passphrase" in credential, false);
  }
  const pat = listed.credentials.find((credential) => credential.type === "pat");
  assert.equal(pat.hasToken, true);
  assert.equal(pat.hasPrivateKey, false);
  const ssh = listed.credentials.find((credential) => credential.type === "ssh");
  assert.equal(ssh.hasPrivateKey, true);
  assert.equal(ssh.hasPassphrase, true);

  const response = await GET(new Request("http://localhost/api/git-credentials"));
  const body = await response.text();
  assert.equal(response.status, 200);
  for (const secret of [PAT.token, SSH.privateKey, SSH.passphrase]) {
    assert.equal(body.includes(secret), false, "GET must not serialize a stored secret");
  }
  assert.equal(JSON.parse(body).credentials.length, 2);
});

test("credentials for different accounts coexist and both round-trip with secrets intact", async (t) => {
  await withAgentDir(t);
  saveGitCredential({ ...PAT, name: "user1 token", account: "user1", token: "token-for-user1" });
  saveGitCredential({ ...PAT, name: "user2 token", account: "user2", token: "token-for-user2" });
  saveGitCredential({ ...SSH, name: "user2 ssh", account: "user2" });
  const loaded = loadGitCredentials();
  const byAccount = (account, name) => loaded.find((c) => c.account === account && c.name === name);
  assert.equal(byAccount("user1", "user1 token").token, "token-for-user1");
  assert.equal(byAccount("user2", "user2 token").token, "token-for-user2");
  assert.equal(byAccount("user2", "user2 ssh").privateKey, SSH.privateKey);
  assert.equal(byAccount("user2", "user2 ssh").passphrase, "key-pass");
  // Account is required, so the two identities are distinguishable server-side.
  assert.deepEqual(new Set(loaded.map((c) => c.account)), new Set(["user1", "user2"]));
});

test("an update that omits the secret keeps the stored one, and an explicit type change validates", async (t) => {
  await withAgentDir(t);
  const { id } = saveGitCredential(PAT);
  saveGitCredential({ id, name: "Renamed", host: PAT.host, account: PAT.account, type: "pat" });
  assert.equal(loadGitCredentials()[0].token, PAT.token, "the browser never sees the secret, so an omitted one must survive");
  assert.equal(loadGitCredentials()[0].name, "Renamed");
  assert.throws(
    () => validateGitCredentialInput({ id, name: "x", host: "h", account: "a", type: "ssh" }),
    /private key/i,
    "switching a stored credential to ssh without a key is refused",
  );
});

test("isDefaultForHost is exclusive per host", async (t) => {
  await withAgentDir(t);
  const first = saveGitCredential({ ...PAT, name: "work", isDefaultForHost: true });
  saveGitCredential({ ...PAT, name: "personal" });
  const promoted = saveGitCredential({ ...PAT, name: "personal", isDefaultForHost: true });
  const defaultsFor = (host) => loadGitCredentials().filter((c) => c.isDefaultForHost && c.host === host);
  assert.deepEqual(defaultsFor("github.com").map((c) => c.id), [promoted.id]);
  assert.notEqual(first.id, promoted.id);
  saveGitCredential({ ...PAT, name: "lab", host: "gitlab.com", isDefaultForHost: true });
  assert.deepEqual(defaultsFor("github.com").map((c) => c.id), [promoted.id], "another host is unaffected");
});

test("a corrupt store degrades to an empty list instead of throwing", async (t) => {
  const agentDir = await withAgentDir(t);
  saveGitCredential(PAT);
  const path = gitCredentialsPath();
  writeFileSync(path, "{ this is not json", "utf8");
  assert.deepEqual(loadGitCredentials(), []);
  assert.deepEqual(listGitCredentials().credentials, []);
  writeFileSync(path, JSON.stringify({ version: 1, credentials: { not: "an array" } }), "utf8");
  assert.deepEqual(loadGitCredentials(), []);
  rmSync(path, { force: true });
  assert.deepEqual(loadGitCredentials(), []);
  // A write after corruption starts a fresh store instead of propagating.
  saveGitCredential(PAT);
  assert.equal(loadGitCredentials()[0].token, PAT.token);
  assert.equal(agentDir.length > 0, true);
});

test("an undecryptable secret leaves the record visible and its ciphertext untouched", async (t) => {
  const agentDir = await withAgentDir(t);
  const { id } = saveGitCredential(PAT);
  const keyPath = join(agentDir, GIT_CREDENTIAL_KEY_FILE);
  const key = readFileSync(keyPath, "utf8");
  // A rotated/regenerated local key orphans the ciphertext: the metadata must
  // survive, and a metadata-only edit must not silently delete the secret.
  rmSync(keyPath);
  const loaded = loadGitCredentials();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].name, PAT.name);
  assert.equal(loaded[0].token, undefined);
  saveGitCredential({ id, name: "Still here", host: PAT.host, account: PAT.account, type: "pat" });
  const stored = readFileSync(gitCredentialsPath(), "utf8");
  assert.equal(stored.includes(PAT.token), false);
  assert.match(stored, /v1\./, "the undecryptable ciphertext is preserved, not rewritten");
  writeFileSync(keyPath, key, "utf8");
  assert.equal(loadGitCredentials()[0].token, PAT.token, "restoring the key file makes the secret readable again");
});

test("validation rejects unusable input before anything is written", async (t) => {
  await withAgentDir(t);
  const reject = (input, pattern) => assert.throws(() => saveGitCredential(input), pattern);
  reject({ ...PAT, account: "  " }, /account/i);
  reject({ ...PAT, name: "" }, /name/i);
  reject({ ...PAT, host: "https://github.com" }, /host/i);
  reject({ ...PAT, host: "git@github.com" }, /host/i);
  reject({ ...PAT, host: "github.com/owner" }, /host/i);
  reject({ ...PAT, type: "token" }, /type/i);
  reject({ ...PAT, token: "" }, /token/i);
  reject({ name: "no token", host: "github.com", account: "user1", type: "pat" }, /token/i);
  reject({ name: "no key", host: "github.com", account: "user1", type: "ssh" }, /private key/i);
  assert.deepEqual(loadGitCredentials(), [], "nothing was persisted by a rejected write");
});

test("removing a credential deletes its ciphertext and leaves the rest intact", async (t) => {
  const agentDir = await withAgentDir(t);
  const first = saveGitCredential({ ...PAT, name: "one" });
  saveGitCredential({ ...PAT, name: "two" });
  deleteGitCredential(first.id);
  const remaining = loadGitCredentials();
  assert.deepEqual(remaining.map((c) => c.name), ["two"]);
  const raw = readFileSync(join(agentDir, GIT_CREDENTIAL_FILE), "utf8");
  assert.equal(raw.includes(first.id), false);
  assert.throws(() => deleteGitCredential("missing-id"), /not found/i);
});

test("the store refuses to write when the local key file is unreadable", async (t) => {
  const agentDir = await withAgentDir(t);
  saveGitCredential(PAT);
  // A truncated key must not be silently regenerated: that would orphan every
  // stored secret while appearing to succeed.
  writeFileSync(join(agentDir, GIT_CREDENTIAL_KEY_FILE), "not-base64!!", "utf8");
  assert.deepEqual(loadGitCredentials().map((c) => c.token), [undefined]);
  assert.throws(() => saveGitCredential({ ...PAT, name: "renamed" }), /key/i);
});

test("a world-readable store is not left behind after a mode-changing edit", async (t) => {
  const agentDir = await withAgentDir(t);
  saveGitCredential(PAT);
  const path = join(agentDir, GIT_CREDENTIAL_FILE);
  chmodSync(path, 0o644);
  saveGitCredential({ ...PAT, name: "tightened" });
  assert.equal(statSync(path).mode & 0o777, 0o600, "the file is re-tightened on every write");
}, UNIX_ONLY);

test("the route upserts, lists, and deletes without ever serializing a secret", async (t) => {
  await withAgentDir(t);
  const created = await PUT(jsonRequest("PUT", PAT));
  assert.equal(created.status, 200);
  const createdBody = await created.json();
  assert.equal(createdBody.success, true);
  assert.equal(createdBody.credential.type, "pat");
  assert.equal("token" in createdBody.credential, false, "even the PUT response is secret-free");

  const listed = await (await GET(new Request("http://localhost/api/git-credentials"))).json();
  assert.equal(listed.credentials.length, 1);
  assert.equal(listed.credentials[0].id, createdBody.credential.id);
  assert.equal(listed.credentials[0].account, "user1");

  // An update through the API with no secret in the body keeps the stored one.
  const updated = await PUT(jsonRequest("PUT", { id: createdBody.credential.id, name: "Renamed", host: PAT.host, account: PAT.account, type: "pat" }));
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).credential.name, "Renamed");
  assert.equal(loadGitCredentials()[0].token, PAT.token);

  const removed = await DELETE(jsonRequest("DELETE", { id: createdBody.credential.id }));
  assert.equal(removed.status, 200);
  assert.deepEqual((await (await GET(new Request("http://localhost/api/git-credentials"))).json()).credentials, []);
});

test("the route rejects an invalid credential with 400 and a stable code", async (t) => {
  await withAgentDir(t);
  const response = await PUT(jsonRequest("PUT", { ...PAT, account: "" }));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, "account_required");
  assert.deepEqual(loadGitCredentials(), []);
});

function exists(path) {
  return statSync(path, { throwIfNoEntry: false }) !== undefined;
}
