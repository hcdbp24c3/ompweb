// Upload always targeted the workspace root. POST /api/files already accepts
// nested path segments, and getUploadDirectory() already guards them
// (isFilePathAllowed → 403, statSync → 404, not-a-directory → 400), so the
// server never needed changing — the client simply never sent a subfolder: every
// request used `cwd`, for both the conflict check and the upload itself.
//
// These tests pin the fix: an upload icon on each folder row targets that
// folder, while the toolbar button keeps its existing whole-workspace meaning.
import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { FileExplorer } = await jiti.import("./FileExplorer.tsx");

const CWD = "/tmp/project";

beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  // The upload itself goes through XMLHttpRequest; the conflict pre-check is a
  // fetch. Only the pre-check matters here, so XHR is never exercised.
  globalThis.XMLHttpRequest = class {
    open() {}
    send() {}
    set onprogress(_fn) {}
    set onload(_fn) {}
    set onerror(_fn) {}
  };
});
afterEach(cleanup);

const TREE = {
  entries: [
    { name: "src", isDir: true, size: 0 },
    { name: "README.md", isDir: false, size: 12 },
  ],
};

/** Records the URL of every /api/files call so the target path is assertable. */
function mount({ onOpenFile = () => {} } = {}) {
  const urls = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    urls.push(target);
    if (target.includes("type=list")) {
      return new Response(JSON.stringify(TREE), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("type=upload-check")) {
      return new Response(JSON.stringify({ conflicts: [], nonReplaceable: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (target.startsWith("/api/git/status")) {
      return new Response(JSON.stringify({ changed: 0, isRepo: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const view = render(React.createElement(FileExplorer, { cwd: CWD, onOpenFile }));
  return { urls, view };
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

const folderUploadButtons = () =>
  screen.getAllByRole("button", { name: /upload to /i });

test("each folder row offers its own upload control", async () => {
  mount();
  await settle();
  const buttons = folderUploadButtons();
  assert.equal(buttons.length, 1, "one per folder — src");
  assert.ok(
    buttons[0].getAttribute("aria-label")?.includes("src"),
    `label names the destination, got ${buttons[0].getAttribute("aria-label")}`,
  );
});

test("file rows do not get the folder upload control", async () => {
  mount();
  await settle();
  // README.md is a file: it can receive an upload via its parent, but the
  // per-row control is about folders.
  const labels = folderUploadButtons().map((b) => b.getAttribute("aria-label"));
  assert.equal(labels.filter((l) => l?.includes("README.md")).length, 0);
});

test("a folder's upload icon uploads into that folder, not the workspace root", async () => {
  const { urls } = mount();
  await settle();

  await act(async () => { fireEvent.click(folderUploadButtons()[0]); });
  const input = document.querySelector('input[type="file"]');
  assert.ok(input, "the hidden file input is still the single picker");
  await act(async () => {
    fireEvent.change(input, {
      target: { files: [new File(["x"], "note.txt", { type: "text/plain" })] },
    });
  });

  await waitFor(() => {
    assert.ok(
      urls.some((u) => u.includes("type=upload-check") && u.includes("/tmp/project/src")),
      `expected the pre-check to target the folder, saw ${JSON.stringify(urls.filter((u) => u.includes("upload-check")))}`,
    );
  });
  assert.equal(
    urls.some((u) => u.includes("type=upload-check") && /\/tmp\/project\?/.test(u)),
    false,
    "and never the bare workspace root",
  );
});

test("the toolbar upload button keeps uploading to the workspace root", async () => {
  const { urls } = mount();
  await settle();

  // The imperative handle is how RightPanel opens the picker with no target.
  const ref = React.createRef();
  const view = render(React.createElement(FileExplorer, { cwd: CWD, onOpenFile() {}, ref }));
  await settle();

  const input = view.container.querySelector('input[type="file"]');
  assert.ok(input);
  // No folder icon was clicked, so the target must still be the root.
  await act(async () => {
    fireEvent.change(input, {
      target: { files: [new File(["x"], "root.txt", { type: "text/plain" })] },
    });
  });
  void ref;
  await waitFor(() => {
    assert.ok(urls.some((u) => u.includes("type=upload-check")), "the pre-check ran");
  });
  assert.ok(
    !urls.some((u) => u.includes("type=upload-check") && u.includes("/tmp/project/src")),
    "no folder target leaked in from the earlier click",
  );
});