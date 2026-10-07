import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// This route used to demand `autoResumeSessions` and forward ONLY that field, so
// the second toggle could never be switched on: every client sends just its own
// field, and the PUT answered 400 "autoResumeSessions must be a boolean".
//
// The assertions are behavioural rather than textual. A source-grep test would
// have kept passing through that bug, because the route DID contain the string
// "autoResumeSessions" and DID contain `saveWebServerSettings`.

const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: {
    "@/lib/rpc-manager": new URL("../__fixtures__/rpc-manager-stub.mjs", import.meta.url).pathname,
    "@/lib/web-settings": new URL("../__fixtures__/web-settings-stub.mjs", import.meta.url).pathname,
    "@/": new URL("../", import.meta.url).pathname,
  },
});

const { PUT, GET } = await jiti.import("./route.ts");
const stub = await jiti.import("../__fixtures__/web-settings-stub.mjs");
const { counters } = await jiti.import("../__fixtures__/rpc-manager-stub.mjs");

function reset() {
  stub.store.autoResumeSessions = false;
  stub.store.autoUpdateOmp = false;
  counters.sync = 0;
}

function put(body, raw = false) {
  return PUT(new Request("https://example.test/api/web-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: raw ? body : JSON.stringify(body),
  }));
}

test("a toggle can be set on its own, without restating the others", async () => {
  reset();
  // The exact request that failed.
  const res = await put({ autoUpdateOmp: true });
  assert.equal(res.status, 200);
  assert.equal(stub.store.autoUpdateOmp, true, "the value the client asked for is the value stored");
});

test("neither toggle overwrites the other", async () => {
  reset();
  await put({ autoUpdateOmp: true });
  await put({ autoResumeSessions: true });
  assert.deepEqual(stub.store, { autoResumeSessions: true, autoUpdateOmp: true },
    "saving one toggle must not silently reset the other");
});

test("saving the auto-update toggle does not disturb running sessions", async () => {
  reset();
  await put({ autoUpdateOmp: true });
  assert.equal(counters.sync, 0, "only a change to autoResumeSessions concerns live sessions");
  await put({ autoResumeSessions: true });
  assert.equal(counters.sync, 1);
});

test("a misspelt key is refused, not silently ignored", async () => {
  reset();
  const res = await put({ autoUpdateOML: true });
  assert.equal(res.status, 400);
  assert.equal(stub.store.autoUpdateOmp, false,
    "a typo must not look like a successful save that changed nothing");
});

test("a non-boolean value is refused, naming the offending key", async () => {
  reset();
  const res = await put({ autoUpdateOmp: "yes" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /autoUpdateOmp/);
});

test("an empty or non-object body is refused", async () => {
  reset();
  assert.equal((await put({})).status, 400);
  assert.equal((await put([1, 2])).status, 400);
  assert.equal((await put("{oops", true)).status, 400);
});

test("GET reflects what PUT stored", async () => {
  reset();
  await put({ autoUpdateOmp: true });
  const body = await (await GET()).json();
  assert.equal(body.autoUpdateOmp, true);
});