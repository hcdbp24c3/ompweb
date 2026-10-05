// The clone form had a URL and nothing else, so the only way to get a branch,
// a tag or a commit out of a clone was to clone the default and switch
// afterwards. `git clone --branch` takes all three, so the gap is the missing
// field.
//
// This pins the client half of it, because a rendered input that is not in the
// POST body is an inert control — the same class of bug this dialog already had
// once, when the clone field was built but so hidden that nobody found it (see
// DirectoryPicker-clone-visible.test.mjs). The server re-validates the ref
// (lib/git-branch.ts, projects-clone-route.test.mjs); what is pinned here is
// that the browser sends what the user typed, and refuses to start a clone it
// already knows git will reject.
//
// DirectoryPicker renders into document.body (`if (!portalTarget) return null`),
// so it needs a DOM.
import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";
import en from "../lib/i18n/locales/en.json" with { type: "json" };

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { DirectoryPicker } = await jiti.import("./DirectoryPicker.tsx");

const PARENT = "/tmp/workspaces";
const URL_REPO = "https://github.com/octocat/repo.git";
let posts;

const copy = (key, vars) => Object.entries(vars ?? {}).reduce(
  (text, [name, value]) => text.replace(`{${name}}`, String(value)),
  en[key] ?? key,
);

const json = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "content-type": "application/json" },
});

beforeEach(() => {
  posts = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith("/api/cwd/browse")) {
      return json({ path: PARENT, parentPath: "/tmp", directories: [] });
    }
    if (target === "/api/projects/clone" && init?.method === "POST") {
      posts.push(JSON.parse(init.body));
      // An empty NDJSON stream: the reader ends at once. Only the request body
      // matters here — the frames are the route test's business.
      return new Response("", { status: 200, headers: { "content-type": "application/x-ndjson" } });
    }
    return json({});
  };
});
afterEach(cleanup);

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });

async function mount() {
  render(React.createElement(DirectoryPicker, { busy: false, onCancel() {}, onSelect() {} }));
  await settle();
  return document.body;
}

const field = (selector) => document.querySelector(selector);
const cloneButton = () => [...document.querySelectorAll("button")].find((node) =>
  (node.textContent ?? "") === copy("directoryPicker.cloneHere"));

const type = async (node, value) => {
  await act(async () => { fireEvent.change(node, { target: { value } }); });
};

test("the ref field sits next to the URL and is named for screen readers", async () => {
  const body = await mount();

  const input = field("input.directory-picker-clone-branch");
  assert.ok(input, "the clone form has no ref field");
  const urlAt = body.innerHTML.search("directory-picker-clone-url");
  const refAt = body.innerHTML.search("directory-picker-clone-branch");
  assert.ok(urlAt >= 0 && refAt >= 0, "both the URL field and the ref field are rendered");
  assert.ok(urlAt < refAt, "the ref belongs to the clone URL, so it reads directly under it");
  assert.equal(
    input.getAttribute("aria-label"),
    copy("directoryPicker.cloneBranchLabel"),
    "an unlabelled field is the same invisible control this dialog already grew one of",
  );
});

test("the ref the user typed is the ref the server is asked to clone", async () => {
  await mount();
  await type(field("input.directory-picker-clone-url"), URL_REPO);
  await type(field("input.directory-picker-clone-branch"), "release/2.0");

  await act(async () => { fireEvent.click(cloneButton()); });

  await waitFor(() => assert.equal(posts.length, 1, "the clone POST never fired"));
  assert.equal(posts[0].url, URL_REPO);
  assert.equal(posts[0].branch, "release/2.0");
  assert.equal(posts[0].parent, PARENT);
});

test("a ref is optional — leaving it blank clones the default branch", async () => {
  await mount();
  await type(field("input.directory-picker-clone-url"), URL_REPO);

  await act(async () => { fireEvent.click(cloneButton()); });

  await waitFor(() => assert.equal(posts.length, 1));
  assert.equal(posts[0].branch, undefined, "an empty --branch would fail the clone rather than default it");
});

test("a ref git cannot take never starts a clone, and says so", async () => {
  const body = await mount();
  await type(field("input.directory-picker-clone-url"), URL_REPO);
  await type(field("input.directory-picker-clone-branch"), "main..HEAD");

  assert.equal(cloneButton().disabled, true, "the button offers an action that would be refused");
  assert.ok(
    body.innerHTML.includes(copy("errors.invalid_git_ref")),
    "the reason is visible next to the field, not only in a server response",
  );
  assert.ok(
    !body.innerHTML.includes(copy("errors.invalid_git_url")),
    "the URL is fine here — blaming it would send the user looking in the wrong place",
  );

  await act(async () => { fireEvent.click(cloneButton()); });
  assert.equal(posts.length, 0);
});

test("the ref does not rename the target directory the user is shown", async () => {
  const body = await mount();
  await type(field("input.directory-picker-clone-url"), URL_REPO);
  await type(field("input.directory-picker-clone-branch"), "release/2.0");

  const preview = copy("directoryPicker.cloneInto", { path: `${PARENT}/repo` });
  assert.ok(body.innerHTML.includes(preview), `expected "${preview}" in the preview`);
  assert.ok(!body.innerHTML.includes(`${PARENT}/repo-release`), "the directory name comes from the URL alone");
});