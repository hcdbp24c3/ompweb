// Cloning a repository into a new workspace has been implemented the whole time:
// POST /api/projects/clone streams NDJSON progress, DELETE cancels and removes
// the partial clone, cloneDirectoryName() derives the directory from the URL,
// and the Add-workspace picker has the URL field, a "Clone here" button and a
// cancel. Nobody could find it.
//
// The reason is that the field sits in the dialog's footer with only a
// placeholder and an aria-label, under a directory tree. A monospace input
// there reads as a path filter, so the feature looked absent — which is exactly
// what it is to someone scanning the dialog.
//
// This pins visible text: the control has to be announced as its own action,
// not left to be inferred from a placeholder.
//
// DirectoryPicker renders into document.body (`if (!portalTarget) return null`),
// so it needs a DOM: renderToStaticMarkup returns an empty string, which is why
// an SSR assertion here would pass or fail for the wrong reason.
import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, render } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { DirectoryPicker } = await jiti.import("./DirectoryPicker.tsx");

beforeEach(() => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ entries: [], home: "/root", parent: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
});
afterEach(cleanup);

async function mount() {
  render(React.createElement(DirectoryPicker, { busy: false, onCancel() {}, onSelect() {} }));
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
  return document.body;
}

test("the clone field is announced by visible text, not only a placeholder", async () => {
  const body = await mount();
  assert.match(body.innerHTML, /Or clone from Git|directoryPicker\.cloneHeading/);
});

test("the visible heading sits above the URL field, not below it", async () => {
  const body = await mount();
  const heading = body.innerHTML.search(/Or clone from Git|directoryPicker\.cloneHeading/);
  const field = body.innerHTML.search(/directory-picker-clone-url/);
  assert.ok(heading >= 0 && field >= 0, "both are rendered");
  assert.ok(heading < field, "the heading introduces the field rather than trailing it");
});

test("the URL field keeps its accessible name for screen readers", async () => {
  const body = await mount();
  assert.match(
    body.innerHTML,
    /aria-label="(Git repository URL to clone|directoryPicker\.cloneUrlLabel)"/,
  );
});