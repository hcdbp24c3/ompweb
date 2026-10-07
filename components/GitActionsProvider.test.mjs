// Why the Git tab's write surface is a provider and not `useState` in
// `RightPanel`.
//
// The three buttons live in RightPanel's toolbar and the message box and the
// streamed output live in `GitChangesPanel`, and RightPanel's `memo` boundary
// exists so AppShell's polls do not reconcile the file tree and every open file
// viewer (see the comment on the component). Holding the commit message in
// RightPanel's own state would put a re-render of exactly that subtree behind
// every keystroke in the message box, and nothing about the feature would say so.
//
// So this file pins the mechanism rather than the symptom: the provider's state
// changes must reach its CONSUMERS and leave the `children` it was handed alone.
// A refactor that inlines the hook back into RightPanel would fail the second
// assertion only if the children were re-created per render, so the check that
// matters is the first — children are referentially stable, and the whole
// property follows from that.
import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { GitActionsProvider, useGitActionsContext } = await jiti.import("./GitActionsProvider.tsx");

afterEach(cleanup);

beforeEach(() => {
  globalThis.sent = [];
  globalThis.fetch = async (url) => {
    globalThis.sent.push(String(url));
    return new Response("{}", { status: 200 });
  };
});

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

let childRenders = 0;

function CountingChild() {
  childRenders += 1;
  return React.createElement("span", null, "child");
}

/** A consumer that pushes the surface into a state a test can watch. */
function Trigger({ label = "Commit" }) {
  const git = useGitActionsContext();
  if (!git) return React.createElement("span", null, "no surface");
  return React.createElement("button", {
    onClick: () => git.setCommitMessage(label),
  }, "type");
}

test("the provider's state changes reach a consumer without re-rendering the children", async () => {
  childRenders = 0;
  render(
    React.createElement(GitActionsProvider, { cwd: "/repo" },
      React.createElement(CountingChild),
      React.createElement(Trigger),
    ),
  );
  assert.equal(childRenders, 1);

  fireEvent.click(screen.getByRole("button", { name: "type" }));
  await settle();

  assert.equal(childRenders, 1, "a keystroke in the commit box must not reconcile the file tree");
  assert.ok(screen.getByText("child"), "and the children are still mounted");
});

test("there is no write surface outside the provider, rather than a broken one", async () => {
  // The panel and the toolbar are always inside it, so this is a wiring guard: a
  // silent undefined would render a commit button that does nothing.
  render(React.createElement(React.Fragment, null, React.createElement(Trigger)));
  await settle();
  assert.equal(screen.getByText("no surface").textContent, "no surface");
});

test("a provider with no directory refuses work, so nothing can be written without a project", async () => {
  function Push() {
    const git = useGitActionsContext();
    return React.createElement("button", { onClick: () => git.push() }, "push");
  }
  render(React.createElement(GitActionsProvider, { cwd: null }, React.createElement(Push)));
  fireEvent.click(screen.getByRole("button", { name: "push" }));
  await settle();
  assert.deepEqual(globalThis.sent, []);
});