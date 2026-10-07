import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// The auto-updater is the only thing in omp-web that installs a new runtime
// without being asked, so these tests are about refusal as much as function:
// the default path must update NOTHING.

const jiti = createJiti(import.meta.url, { tryNative: false, alias: { "@/": new URL("../", import.meta.url).pathname } });

const selfUpdate = await jiti.import("../self-update.ts");
const updatePolicy = await jiti.import("../update-policy.ts");

// Stub the two modules the loop reaches for, BEFORE importing it, so the
// module-level state starts clean for each test.
const calls = { check: [], prepare: [], commit: [] };
let nextCheck = { updateAvailable: false, currentVersion: "18.6.1", availableVersion: null, updateCommand: "omp update", updatesDisabled: false };
let selfUpdateStatus = null;
let prepareThrows = null;
let checkThrows = null;
let updateDisabled = false;

selfUpdate.prepareSelfUpdate = async () => { calls.prepare.push(1); if (prepareThrows) throw prepareThrows; return { attemptId: "att-1", targetVersion: "18.7.0" }; };
selfUpdate.commitSelfUpdate = (id) => { calls.commit.push(id); return { accepted: true, attemptId: id }; };
selfUpdate.getSelfUpdateStatus = () => selfUpdateStatus;
updatePolicy.isUpdateDisabled = () => updateDisabled;

const autoUpdate = await jiti.import("./auto-update.ts");
const updates = await jiti.import("./updates.ts");
// One stub installed before the import, driven by a flag: reassigning a module
// export afterwards does not reach an already-bound import.
updates.checkOmpUpdate = async (force) => { calls.check.push(force); if (checkThrows) throw checkThrows; return nextCheck; };

function reset() {
  calls.check.length = 0; calls.prepare.length = 0; calls.commit.length = 0;
  nextCheck = { updateAvailable: false, currentVersion: "18.6.1", availableVersion: null, updateCommand: "omp update", updatesDisabled: false };
  selfUpdateStatus = null; prepareThrows = null; checkThrows = null; updateDisabled = false;
  autoUpdate.stopOmpAutoUpdate();
}

test("with nothing available it updates nothing", async () => {
  reset();
  const result = await autoUpdate.runOmpAutoUpdateOnce();
  assert.equal(result.updated, false);
  assert.equal(result.reason, "up_to_date");
  assert.equal(calls.prepare.length, 0, "a no-op check must never reach prepare");
  assert.equal(calls.commit.length, 0);
});

test("an available update goes through prepare then commit — the same flow the route uses", async () => {
  reset();
  nextCheck = { updateAvailable: true, currentVersion: "18.6.1", availableVersion: "18.7.0", updateCommand: "omp update", updatesDisabled: false };
  const result = await autoUpdate.runOmpAutoUpdateOnce();
  assert.equal(result.updated, true);
  assert.equal(result.reason, "update_started");
  assert.equal(calls.prepare.length, 1);
  assert.deepEqual(calls.commit, ["att-1"], "commit must name the attempt prepare created");
});

test("an attempt already in flight is stepped over, not raced", async () => {
  reset();
  selfUpdateStatus = { attemptId: "manual-1", state: "running", fromVersion: "18.6.1", targetVersion: "18.7.0", preparedAt: new Date().toISOString() };
  nextCheck = { updateAvailable: true, currentVersion: "18.6.1", availableVersion: "18.7.0", updateCommand: "omp update", updatesDisabled: false };
  const result = await autoUpdate.runOmpAutoUpdateOnce();
  assert.equal(result.updated, false);
  assert.equal(result.reason, "update_in_progress");
  assert.equal(calls.prepare.length, 0, "a second updater must not fight for the lease");
});

test("the env kill switch outranks the setting, so it can be stopped without a rebuild", async () => {
  reset();
  updateDisabled = true;
  const result = await autoUpdate.runOmpAutoUpdateOnce();
  assert.equal(result.updated, false);
  assert.equal(result.reason, "disabled_by_env");
  assert.equal(calls.check.length, 0, "a disabled updater must not even check");
});

test("a failing check records the reason and never throws", async () => {
  reset();
  checkThrows = new Error("registry unreachable");
  const result = await autoUpdate.runOmpAutoUpdateOnce();
  assert.equal(result.reason, "check_failed");
  assert.equal(autoUpdate.getOmpAutoUpdateState().lastError, "registry unreachable");
  assert.equal(calls.prepare.length, 0, "a failed check must not fall through to an update");
});

test("a failed prepare is reported, and the binary is left alone", async () => {
  reset();
  nextCheck = { updateAvailable: true, currentVersion: "18.6.1", availableVersion: "18.7.0", updateCommand: "omp update", updatesDisabled: false };
  prepareThrows = new Error("No OMP update available");
  const result = await autoUpdate.runOmpAutoUpdateOnce();
  assert.equal(result.updated, false);
  assert.equal(calls.commit.length, 0, "a prepare that threw must not be committed");
  assert.equal(autoUpdate.getOmpAutoUpdateState().lastError, "No OMP update available");
});

test("the loop is idempotent, and refuses to start when disabled", () => {
  reset();
  const first = autoUpdate.startOmpAutoUpdate(60_000);
  assert.equal(first.started, true);
  const second = autoUpdate.startOmpAutoUpdate(60_000);
  assert.deepEqual(second, { started: true, reason: "already_running" },
    "a second register() must not leave two timers running");
  autoUpdate.stopOmpAutoUpdate();

  updateDisabled = true;
  const blocked = autoUpdate.startOmpAutoUpdate(60_000);
  assert.equal(blocked.started, false);
  assert.equal(blocked.reason, "disabled_by_env");
});

test("the timer never keeps the process alive", () => {
  reset();
  autoUpdate.startOmpAutoUpdate(60_000);
  // `unref()` is what makes this true; without it a 6-hour interval would hold
  // a container's event loop open and the server could never exit cleanly.
  const timer = globalThis.__ompWebAutoUpdate?.timer;
  assert.ok(timer && typeof timer.hasRef === "function" && timer.hasRef() === false,
    "the interval must be unref'd");
  autoUpdate.stopOmpAutoUpdate();
});