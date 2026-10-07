// The Git tab's per-file ticks. The panel had no test file at all, so everything
// here goes through jsdom with a mocked `fetch` for the two routes it reads.
//
// The seam under test is `onTickedPathsChange`: the panel owns the ticked set and
// reports it, because the commit button lives in RightPanel's toolbar and must
// receive exactly the ticked paths and nothing else. Asserting the reported list
// is therefore the same assertion as "committing sends exactly those two paths"
// — the commit request body is `{cwd, action:"commit", paths}`, and `paths` is
// what is asserted here.
//
// The three ways this could be got wrong, and what pins each:
//   - sharing `selectedPath` with the diff viewer, so ticking jumps the diff
//     ("ticking a file does not move the diff" + "clicking a row does not tick");
//   - one control that ticks everything implicitly ("ticking one file leaves the
//     others unticked");
//   - a tick surviving the event that invalidated it — a refresh that no longer
//     lists the path, or a cwd switch. The cwd test deliberately answers with a
//     status request that never resolves, so it can only pass if the ticks are
//     invalidated at render time rather than when the next response lands.
import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { GitChangesPanel } = await jiti.import("./GitChangesPanel.tsx");
const { translate, translatePlural } = await jiti.import("@/lib/i18n");

const REPO = "/repo";
const OTHER = "/other";
const A = `${REPO}/a.ts`;
const B = `${REPO}/lib/b.ts`;
const C = `${REPO}/c.md`;

const jsonHeaders = { "Content-Type": "application/json" };

/** Changed files as `/api/git/status` reports them, in display order. */
function statusFiles(...paths) {
  return paths.map((filePath) => ({
    filePath,
    status: "modified",
    code: "M",
    indexStatus: " M",
    worktreeStatus: "M",
  }));
}

/** The status the next `/api/git/status` answers with, keyed by cwd. */
let statusByCwd = new Map([[REPO, statusFiles(A, B, C)]]);

/** When set, the next status request parks instead of answering. */
let holdStatusCwd = null;

/** Every `/api/git/diff` path the panel asked for, in order. */
let diffRequests = [];

function json(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: jsonHeaders });
}

beforeEach(() => {
  statusByCwd = new Map([[REPO, statusFiles(A, B, C)], [OTHER, statusFiles(`${OTHER}/only.ts`)]]);
  holdStatusCwd = null;
  diffRequests = [];
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url), "https://omp.test");
    if (parsed.pathname === "/api/git/status") {
      const cwd = parsed.searchParams.get("cwd");
      // A held request never answers: the assertions that use it are about what
      // the panel does *before* the next status lands, so a response would
      // defeat them rather than help.
      if (holdStatusCwd === cwd) return new Promise(() => {});
      return json({ isGitRepository: true, repositoryRoot: cwd, files: statusByCwd.get(cwd) ?? [] });
    }
    if (parsed.pathname === "/api/git/diff") {
      diffRequests.push(parsed.searchParams.get("path"));
      return json({ supported: true, patch: "@@ -1 +1 @@\n-old\n+new\n" });
    }
    throw new Error(`unexpected request: ${parsed.pathname}`);
  };
});

afterEach(cleanup);

/** Let the panel's effects and its fetch chain finish. */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

/** Every path list the panel has reported, in order. */
const reports = [];

function renderPanel(props = {}) {
  reports.length = 0;
  return render(
    React.createElement(GitChangesPanel, {
      cwd: REPO,
      onOpenFile() {},
      onTickedPathsChange(paths) { reports.push([...paths]); },
      commitMessage: "",
      onCommitMessageChange() {},
      operation: null,
      canCancelOperation: false,
      onCancelOperation() {},
      ...props,
    }),
  );
}

/** The same props for a rerender, so a cwd switch keeps the commit surface. */
function panelProps(props = {}) {
  return {
    cwd: REPO,
    onOpenFile() {},
    onTickedPathsChange(paths) { reports.push([...paths]); },
    commitMessage: "",
    onCommitMessageChange() {},
    operation: null,
    canCancelOperation: false,
    onCancelOperation() {},
    ...props,
  };
}

const lastReported = () => reports.at(-1);

/** The row (role=option) for a file path, or null once it is gone. */
function rowFor(filePath) {
  return screen.queryAllByRole("option").find((row) => row.getAttribute("title") === filePath || row.textContent.includes(filePath.split("/").pop())) ?? null;
}

function tickFor(filePath) {
  const row = rowFor(filePath);
  assert.ok(row, `no row for ${filePath}`);
  return within(row).getByRole("checkbox");
}

function tickedBoxes() {
  return screen.queryAllByRole("checkbox").filter((box) => box.getAttribute("aria-checked") === "true");
}

async function renderSettled(props) {
  const view = renderPanel(props);
  await settle();
  return view;
}

test("nothing is ticked by default, so committing is always deliberate", async () => {
  await renderSettled();
  assert.equal(screen.getAllByRole("option").length, 3);
  assert.equal(screen.getAllByRole("checkbox").length, 3, "every row carries a tick");
  assert.deepEqual(tickedBoxes(), []);
  assert.deepEqual(lastReported(), []);
});

test("ticking two files reports exactly those two paths", async () => {
  await renderSettled();
  fireEvent.click(tickFor(A));
  fireEvent.click(tickFor(B));
  assert.deepEqual(lastReported(), [A, B]);
  assert.equal(tickedBoxes().length, 2);
});

test("the reported paths are the absolute ones git status returned", async () => {
  // A display-relative path would commit a different file (or fail the write
  // layer's repository-boundary check), so this is not a formatting detail.
  await renderSettled();
  fireEvent.click(tickFor(B));
  assert.deepEqual(lastReported(), [`${REPO}/lib/b.ts`]);
  assert.ok(!lastReported().includes("lib/b.ts"));
});

test("ticking one file leaves the others unticked", async () => {
  await renderSettled();
  fireEvent.click(tickFor(B));
  assert.equal(tickedBoxes().length, 1);
  assert.deepEqual(lastReported(), [B]);
});

test("ticking a file does not move the diff viewer", async () => {
  await renderSettled();
  // The panel previews the first changed file, so the initial diff request is A's.
  assert.deepEqual(diffRequests, [A]);
  const before = diffRequests.length;
  fireEvent.click(tickFor(B));
  fireEvent.click(tickFor(C));
  assert.equal(diffRequests.length, before, "ticking must not refetch a diff");
  const selected = screen.getAllByRole("option").filter((row) => row.getAttribute("aria-selected") === "true");
  assert.equal(selected.length, 1);
  assert.ok(rowFor(A).getAttribute("aria-selected") === "true");
});

test("clicking a row selects it for the diff without ticking it", async () => {
  await renderSettled();
  fireEvent.click(rowFor(C));
  assert.equal(rowFor(C).getAttribute("aria-selected"), "true");
  assert.deepEqual(lastReported(), []);
  assert.deepEqual(tickedBoxes(), []);
  assert.deepEqual(diffRequests, [A, C]);
});

test("the row's own space key selects the diff without ticking", async () => {
  await renderSettled();
  fireEvent.keyDown(rowFor(C), { key: " " });
  assert.equal(rowFor(C).getAttribute("aria-selected"), "true");
  assert.deepEqual(lastReported(), []);
  assert.deepEqual(tickedBoxes(), []);
});

test("unticking a file drops it from the reported paths", async () => {
  await renderSettled();
  fireEvent.click(tickFor(A));
  fireEvent.click(tickFor(B));
  assert.deepEqual(lastReported(), [A, B]);
  fireEvent.click(tickFor(A));
  assert.deepEqual(lastReported(), [B]);
  assert.equal(tickedBoxes().length, 1);
});

test("a tick on a path the next status refresh no longer lists is dropped", async () => {
  await renderSettled();
  fireEvent.click(tickFor(A));
  fireEvent.click(tickFor(B));
  assert.deepEqual(lastReported(), [A, B]);

  // A disappeared: the row is gone, so the tick must go with it.
  statusByCwd.set(REPO, statusFiles(B, C));
  fireEvent.click(document.querySelector(".git-refresh"));
  await settle();

  assert.equal(rowFor(A), null, "the reverted file should have left the list");
  assert.deepEqual(lastReported(), [B], "the stale tick must not survive into a commit");
  assert.deepEqual(tickedBoxes().length, 1);
});

test("a refresh that leaves the working tree clean clears every tick", async () => {
  await renderSettled();
  fireEvent.click(tickFor(A));
  fireEvent.click(tickFor(B));
  statusByCwd.set(REPO, []);
  fireEvent.click(document.querySelector(".git-refresh"));
  await settle();
  assert.deepEqual(lastReported(), []);
});

test("a status refresh that fails clears the selection", async () => {
  // A failed refresh says nothing about which files are still modified, so a
  // tick carried through it would be a commit the user cannot see the scope of.
  await renderSettled();
  fireEvent.click(tickFor(A));
  assert.deepEqual(lastReported(), [A]);

  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url), "https://omp.test");
    if (parsed.pathname === "/api/git/status") return new Response("nope", { status: 500 });
    return json({ supported: true, patch: "" });
  };
  fireEvent.click(document.querySelector(".git-refresh"));
  await settle();

  assert.ok(screen.getByRole("alert"), "expected the load-failure banner");
  assert.deepEqual(lastReported(), []);
});

test("changing cwd clears the selection before the new status arrives", async () => {
  const view = await renderSettled();
  fireEvent.click(tickFor(A));
  fireEvent.click(tickFor(B));
  assert.deepEqual(lastReported(), [A, B]);

  // The new cwd's status request never answers, so anything the panel still
  // holds can only have been dropped by the cwd change itself.
  holdStatusCwd = OTHER;
  view.rerender(React.createElement(GitChangesPanel, panelProps({ cwd: OTHER })));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.deepEqual(lastReported(), []);
  assert.deepEqual(tickedBoxes(), []);
});

test("a cwd change clears the selection even when the new cwd names the same directory", async () => {
  // The paths are absolute, so switching to a differently-spelled cwd that
  // resolves to the same directory is the one input where pruning alone would
  // keep the ticks alive: they are all still listed. The rule is "a tick belongs
  // to the cwd it was made in", not "a tick belongs to a set of paths".
  statusByCwd.set(`${REPO}/`, statusFiles(A, B, C));
  const view = await renderSettled();
  fireEvent.click(tickFor(A));
  fireEvent.click(tickFor(B));
  assert.deepEqual(lastReported(), [A, B]);

  view.rerender(React.createElement(GitChangesPanel, panelProps({ cwd: `${REPO}/` })));
  await settle();
  assert.deepEqual(lastReported(), []);
});

test("a tick made in the new cwd is kept", async () => {
  // The cwd guard must invalidate, not freeze: after the switch the panel is
  // usable again.
  const view = await renderSettled();
  fireEvent.click(tickFor(A));
  view.rerender(React.createElement(GitChangesPanel, panelProps({ cwd: OTHER })));
  await settle();
  fireEvent.click(tickFor(`${OTHER}/only.ts`));
  assert.deepEqual(lastReported(), [`${OTHER}/only.ts`]);
});

test("the tick carries the file name, so it is addressable by label", async () => {
  await renderSettled();
  const box = tickFor(B);
  assert.match(box.getAttribute("aria-label") ?? "", /b\.ts/);
  assert.ok(box.getAttribute("title"));
});

test("the ticked count is shown next to the changed-file count", async () => {
  await renderSettled();
  const count = document.querySelector(".git-change-ticked-count");
  assert.ok(count, "expected a count readout");
  assert.equal(count.textContent.trim(), "", "no count before anything is ticked");
  fireEvent.click(tickFor(A));
  fireEvent.click(tickFor(B));
  assert.equal(count.textContent.trim(), translatePlural("gitChanges.tickedCount", 2));
});

test("the open-file button on a row still opens the file, not the tick", async () => {
  const opened = [];
  await renderSettled({ onOpenFile: (filePath) => opened.push(filePath) });
  fireEvent.click(rowFor(C).querySelector(".git-change-open-action"));
  assert.deepEqual(opened, [C]);
  assert.deepEqual(lastReported(), [], "opening a file must not tick it");
});
// ---------------------------------------------------------------------------
// The commit message box and the streamed operation output.
//
// The buttons live in RightPanel's toolbar (components/RightPanel.test.mjs) and
// the state lives in useGitActions (hooks/useGitActions.test.mjs). What is left
// for this file is the surface between them: that the message box is here and
// reports upward, and that an operation's output is shown without taking the
// panel's working surface away — a push can take a minute, and a minute of
// nothing but a spinner is not progress.
/** An operation as the hook hands one over. */
function operation(props = {}) {
  return { kind: "push", log: "", running: false, outcome: null, ...props };
}

test("the message box is labelled and reports what is typed", async () => {
  const typed = [];
  await renderSettled({ commitMessage: "", onCommitMessageChange: (value) => typed.push(value) });
  const box = screen.getByRole("textbox", { name: translate("gitChanges.commitMessage") });
  fireEvent.change(box, { target: { value: "fix the thing" } });
  assert.deepEqual(typed, ["fix the thing"]);
});

test("the message box shows the message it was given, so it is a controlled field", async () => {
  await renderSettled({ commitMessage: "half typed" });
  const box = screen.getByRole("textbox", { name: translate("gitChanges.commitMessage") });
  assert.equal(box.value, "half typed");
});

test("a running operation reports what it is doing, and offers a cancel", async () => {
  await renderSettled({ operation: operation({ running: true }), canCancelOperation: true });
  const status = screen.getByRole("status");
  assert.equal(status.textContent, translate("gitChanges.operationRunning", { action: translate("gitChanges.push") }));
  const cancel = screen.getByRole("button", { name: translate("gitChanges.cancelOperation") });
  assert.equal(cancel.disabled, false);
});

test("clicking cancel asks the operation to stop, and the hook owns whether it can", async () => {
  let asked = 0;
  await renderSettled({
    operation: operation({ running: true }),
    canCancelOperation: true,
    onCancelOperation() { asked += 1; },
  });
  fireEvent.click(screen.getByRole("button", { name: translate("gitChanges.cancelOperation") }));
  assert.equal(asked, 1);
});

test("a cancel already asked for says so, so it cannot be asked twice", async () => {
  // `canCancelOperation` is the hook's single answer to "is it still worth asking",
  // so the button disappearing and the button being disabled are the same fact.
  await renderSettled({ operation: operation({ running: true }), canCancelOperation: false });
  assert.equal(screen.queryByRole("button", { name: translate("gitChanges.cancelOperation") }), null);
  const asked = screen.getByRole("button", { name: translate("gitChanges.operationCancelling") });
  assert.equal(asked.disabled, true, "the control stays put, but says the ask is already in flight");
});

test("a commit is never offered a cancel, because nothing is running to stop", async () => {
  await renderSettled({
    operation: operation({ kind: "commit", running: true }),
    canCancelOperation: true,
  });
  assert.equal(screen.queryByRole("button", { name: translate("gitChanges.cancelOperation") }), null);
  assert.equal(screen.getByRole("status").textContent, translate("gitChanges.operationRunning", { action: translate("gitChanges.commit") }));
});

test("a rejected push shows the remote's message, not a success", async () => {
  await renderSettled({
    operation: operation({
      log: "To /repo.git\n ! [rejected]        main -> main (fetch first)\n",
      outcome: { kind: "error", message: translate("errors.git_write_failed") },
    }),
  });
  assert.equal(screen.getByRole("status").textContent, translate("errors.git_write_failed"));
  const log = document.querySelector(".git-operation-log");
  assert.match(log.textContent, /fetch first/, "the remote's own words have to be on screen");
  assert.doesNotMatch(screen.getByRole("status").textContent, /finished/);
});

test("a settled operation says how it ended, in the operation's own words", async () => {
  for (const [outcome, key] of [
    [{ kind: "done" }, "gitChanges.operationDone"],
    [{ kind: "cancelled" }, "gitChanges.operationCancelled"],
  ]) {
    cleanup();
    await renderSettled({ operation: operation({ outcome }) });
    assert.equal(
      screen.getByRole("status").textContent,
      translate(key, { action: translate("gitChanges.push") }),
      key,
    );
  }
});

test("an operation's output is a bounded region, not a replacement for the diff", async () => {
  // The plan's "do not block the panel": a push can take a minute, so the file
  // list, the ticks and the diff all have to keep working while it does.
  await renderSettled({
    operation: operation({ running: true, log: "Counting objects: 42%\n" }),
    canCancelOperation: true,
  });
  assert.ok(document.querySelector(".git-operation-log"));
  assert.match(document.querySelector(".git-operation-log").textContent, /Counting objects/);
  assert.equal(screen.getAllByRole("option").length, 3, "the file list is still there");
  fireEvent.click(tickFor(B));
  assert.deepEqual(lastReported(), [B], "and the ticks still work");
  assert.equal(screen.getAllByRole("option").length, 3);
  assert.ok(document.querySelector(".diff-view, pre, [class*='diff']"), "the diff pane is still rendered");
});

test("git's output is a named, focusable log region, not an unlabelled pre", async () => {
  // A scrollable region that cannot be focused cannot be scrolled from the
  // keyboard, and a label on an element with no role is not exposed at all.
  await renderSettled({ operation: operation({ log: "Counting objects: 100%\n" }) });
  const log = screen.getByRole("log", { name: translate("gitChanges.gitOutput") });
  assert.match(log.textContent, /Counting objects/);
  assert.equal(log.tabIndex, 0);
});

test("no output yet means no log region, so the panel is not carrying an empty box", async () => {
  await renderSettled({ operation: operation({ running: true }), canCancelOperation: true });
  assert.equal(document.querySelector(".git-operation-log"), null);
});

test("nothing has run, so there is no operation surface at all", async () => {
  await renderSettled();
  assert.equal(screen.queryByRole("status"), null);
  assert.equal(document.querySelector(".git-operation"), null);
});
