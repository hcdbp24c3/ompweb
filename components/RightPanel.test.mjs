// The Git tab's toolbar is where the plan puts the three buttons, and this file
// pins the wiring that the other two test files cannot see: that the panel's
// ticked set and its message box reach the buttons, and that the buttons send
// what the panel reported rather than something of their own.
//
// The assertions are made against the whole RightPanel rather than a rendered
// fragment on purpose. "Commit is disabled until a file is ticked and a message
// typed" is a statement about three components cooperating — a tick in
// GitChangesPanel, a message in the same panel's box, and a button in a toolbar
// the panel never touches — so a test that rendered the button alone would pass
// with the wire between them cut.
import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { RightPanel } = await jiti.import("./RightPanel.tsx");
const { translate } = await jiti.import("@/lib/i18n");

const REPO = "/repo";
const A = `${REPO}/a.ts`;
const B = `${REPO}/lib/b.ts`;
const C = `${REPO}/c.md`;

const STATUS_FILES = [A, B, C].map((filePath) => ({
  filePath,
  status: "modified",
  code: "M",
  indexStatus: " M",
  worktreeStatus: "M",
}));

let requests = [];
let responder = () => json({ ok: true, output: "" });
let refreshes = 0;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function ndjson(frames) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
  );
}

beforeEach(() => {
  requests = [];
  refreshes = 0;
  responder = () => json({ ok: true, output: "" });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.CSS = { escape: (value) => value };
  globalThis.fetch = async (url, init) => {
    const request = {
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body ? JSON.parse(init.body) : null,
    };
    requests.push(request);
    const parsed = new URL(request.url, "https://omp.test");
    if (parsed.pathname === "/api/git/status") {
      return json({ isGitRepository: true, repositoryRoot: REPO, files: STATUS_FILES });
    }
    if (parsed.pathname === "/api/git/diff") return json({ supported: true, patch: "@@ -1 +1 @@\n-a\n+b\n" });
    if (parsed.pathname === "/api/git/action") return responder(request);
    // The explorer tab is mounted behind this one and reads the same directory.
    return json({ entries: [] });
  };
});

afterEach(cleanup);

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });

function panel(props = {}) {
  return React.createElement(RightPanel, {
    fileTabs: [],
    activeFileTabId: null,
    rightView: "git",
    onSelectView() {},
    rightPanelOpen: true,
    rightPanelWidth: null,
    rightPanelResizing: false,
    rightPanelRef: { current: null },
    fileExplorerRef: { current: null },
    revealPath: null,
    onRevealDone() {},
    explorerCwd: REPO,
    activeCwd: REPO,
    explorerRefreshKey: 0,
    fileSearchOpen: false,
    onToggleFileSearch() {},
    onFileSearchOpenChange() {},
    explorerUploadBusy: false,
    onUploadBusyChange() {},
    explorerGitCount: 3,
    explorerIsRepo: true,
    explorerRefreshing: false,
    isMobile: false,
    isCompactOverlay: false,
    onOpenFile() {},
    onSelectFileTab() {},
    onCloseFileTab() {},
    onCloseOtherFileTabs() {},
    onCloseAllFileTabs() {},
    onMentionActiveFile() {},
    onCopyActiveFilePath() {},
    onDownloadActiveFile() {},
    onRevealActiveFile() {},
    onExplorerRefresh() { refreshes += 1; },
    onExplorerRefreshDone() {},
    onAtMention() {},
    onAtMentions() {},
    onMentionLines() {},
    onExplorerGitStatus() {},
    onResetRightPanelWidth() {},
    onRightPanelResizeStart() {},
    onRightPanelResizeKey() {},
    ...props,
  });
}

async function renderGit(props) {
  const view = render(panel(props));
  await settle();
  return view;
}

/** The git toolbar element, so a button in another toolbar cannot satisfy an
 *  assertion about where these three live. */
function gitToolbar() {
  return screen.getByRole("toolbar", { name: translate("tabBar.git") });
}

const button = (label) => within(gitToolbar()).getByRole("button", { name: label });

const commitButton = () => button(translate("gitChanges.commit"));
const pushButton = () => button(translate("gitChanges.push"));
const pullButton = () => button(translate("gitChanges.pull"));

/** The tick on one changed file's row. */
function tickFor(filePath) {
  const row = screen.getAllByRole("option").find((candidate) => candidate.textContent.includes(filePath.split("/").pop()));
  assert.ok(row, `no row for ${filePath}`);
  return within(row).getByRole("checkbox");
}

const messageBox = () => screen.getByRole("textbox", { name: translate("gitChanges.commitMessage") });

const actionPosts = () => requests.filter((request) => request.method === "POST" && new URL(request.url, "https://omp.test").pathname === "/api/git/action");

test("commit is disabled until a file is ticked and a message is typed", async () => {
  await renderGit();
  assert.equal(commitButton().disabled, true, "nothing ticked, nothing typed");

  fireEvent.click(tickFor(A));
  assert.equal(commitButton().disabled, true, "a ticked file alone is not a commit");

  fireEvent.change(messageBox(), { target: { value: "fix the thing" } });
  assert.equal(commitButton().disabled, false, "both halves are in");

  fireEvent.click(tickFor(A));
  assert.equal(commitButton().disabled, true, "and unticking the last file takes it away again");
});

test("the message box stays controlled by the toolbar's state, not by the keystroke", async () => {
  // The value has to come back DOWN through the toolbar to the box: a box that
  // kept its own copy would show a message the commit is not going to send.
  await renderGit();
  fireEvent.change(messageBox(), { target: { value: "fix the thing" } });
  assert.equal(messageBox().value, "fix the thing");
});

test("whitespace in the message box is not a message", async () => {
  await renderGit();
  fireEvent.click(tickFor(A));
  fireEvent.change(messageBox(), { target: { value: "   " } });
  assert.equal(commitButton().disabled, true);
});

test("push and pull need no selection at all", async () => {
  await renderGit();
  assert.equal(pushButton().disabled, false);
  assert.equal(pullButton().disabled, false);
  assert.equal(commitButton().disabled, true);
});

test("commit sends exactly the ticked paths and the typed message", async () => {
  await renderGit();
  fireEvent.click(tickFor(A));
  fireEvent.click(tickFor(B));
  fireEvent.change(messageBox(), { target: { value: "fix the thing" } });
  fireEvent.click(commitButton());
  await settle();

  const posts = actionPosts();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.action, "commit");
  assert.equal(posts[0].body.cwd, REPO);
  assert.equal(posts[0].body.message, "fix the thing");
  // Absolute, and only the ticked two: the third row is changed and unticked.
  assert.deepEqual(posts[0].body.paths, [A, B]);
});

test("a disabled commit cannot be pressed into sending an empty commit", async () => {
  await renderGit();
  fireEvent.click(commitButton());
  await settle();
  assert.deepEqual(actionPosts(), []);
});

test("a successful commit re-reads the changed files, so the list cannot claim a committed file", async () => {
  await renderGit();
  fireEvent.click(tickFor(A));
  fireEvent.change(messageBox(), { target: { value: "fix the thing" } });
  fireEvent.click(commitButton());
  await settle();

  assert.equal(refreshes, 1);
});

test("push sends the streamed action and its own id", async () => {
  responder = () => ndjson([{ type: "output", text: "To /repo.git\n" }, { type: "done" }]);
  await renderGit();
  fireEvent.click(pushButton());
  await settle();

  const posts = actionPosts();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.action, "push");
  assert.ok(posts[0].body.id, "a streamed action is cancellable, so it carries an id");
});

test("a push reports its outcome in the panel, not in the toolbar", async () => {
  responder = () => ndjson([
    { type: "output", text: " ! [rejected]        main -> main (fetch first)\n" },
    { type: "error", error: "error: failed to push some refs to '/repo.git'", code: "git_write_failed" },
  ]);
  await renderGit();
  fireEvent.click(pushButton());
  await settle();

  assert.equal(screen.getByRole("status").textContent, translate("errors.git_write_failed"));
  assert.match(document.querySelector(".git-operation-log").textContent, /fetch first/);
  assert.equal(pushButton().disabled, false, "the toolbar is usable again");
});

test("a cancel in the panel stops the running push and frees the toolbar", async () => {
  const encoder = new TextEncoder();
  let controller;
  const held = new Response(
    new ReadableStream({ start(c) { controller = c; } }),
    { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
  );
  responder = (request) => (request.method === "DELETE" ? json({ ok: true }) : held);
  await renderGit();

  fireEvent.click(pushButton());
  await settle();
  const id = actionPosts()[0].body.id;
  assert.equal(pushButton().disabled, true, "one operation at a time");

  fireEvent.click(screen.getByRole("button", { name: translate("gitChanges.cancelOperation") }));
  await settle();
  const cancels = requests.filter((request) => request.method === "DELETE");
  assert.equal(cancels.length, 1);
  assert.deepEqual(cancels[0].body, { id });

  await act(async () => {
    controller.enqueue(encoder.encode(`${JSON.stringify({ type: "cancelled" })}\n`));
    controller.close();
    await settle();
  });
  assert.equal(screen.getByRole("status").textContent, translate("gitChanges.operationCancelled", { action: translate("gitChanges.push") }));
  assert.equal(pushButton().disabled, false, "and the panel is back to idle");
});

test("the three buttons join the refresh in the git toolbar, and add nothing to another one", async () => {
  await renderGit();
  for (const label of ["gitChanges.refreshChanges", "gitChanges.commit", "gitChanges.push", "gitChanges.pull"]) {
    assert.ok(gitToolbar().querySelector(`[aria-label="${translate(label)}"]`), label);
  }
  // Only the active view's toolbar exists at all, so the git one is the only
  // candidate — four buttons in it is the whole assertion.
  assert.equal(screen.getAllByRole("toolbar").length, 1);
  assert.equal(within(gitToolbar()).getAllByRole("button").length, 4);
});

test("a directory that is not a repository offers no commit surface to fill in", async () => {
  responder = () => json({ ok: true, output: "" });
  globalThis.fetch = async (url, init) => {
    const request = { method: init?.method ?? "GET", url: String(url), body: init?.body ? JSON.parse(init.body) : null };
    requests.push(request);
    const parsed = new URL(request.url, "https://omp.test");
    if (parsed.pathname === "/api/git/status") return json({ isGitRepository: false, repositoryRoot: null, files: [] });
    if (parsed.pathname === "/api/git/diff") return json({ supported: true, patch: "" });
    return json({ entries: [] });
  };
  await renderGit();
  assert.equal(screen.queryByRole("textbox", { name: translate("gitChanges.commitMessage") }), null);
  assert.equal(commitButton().disabled, true);
});