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
const { translatePlural } = await jiti.import("@/lib/i18n");

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
      ...props,
    }),
  );
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
  view.rerender(
    React.createElement(GitChangesPanel, {
      cwd: OTHER,
      onOpenFile() {},
      onTickedPathsChange(paths) { reports.push([...paths]); },
    }),
  );
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

  view.rerender(
    React.createElement(GitChangesPanel, {
      cwd: `${REPO}/`,
      onOpenFile() {},
      onTickedPathsChange(paths) { reports.push([...paths]); },
    }),
  );
  await settle();
  assert.deepEqual(lastReported(), []);
});

test("a tick made in the new cwd is kept", async () => {
  // The cwd guard must invalidate, not freeze: after the switch the panel is
  // usable again.
  const view = await renderSettled();
  fireEvent.click(tickFor(A));
  view.rerender(
    React.createElement(GitChangesPanel, {
      cwd: OTHER,
      onOpenFile() {},
      onTickedPathsChange(paths) { reports.push([...paths]); },
    }),
  );
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