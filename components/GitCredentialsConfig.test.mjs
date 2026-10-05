import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { GitCredentialsConfig } = await jiti.import("./GitCredentialsConfig.tsx");

const buttons = (html) => [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]);

// The panel is a client component that fetches in an effect, so a static render
// is the pre-load state. That is exactly what matters here: secrets are
// write-only, so the form must never be able to render one — not even as a
// masked value, and not in a plaintext input.
test("renders the store with no credential, and no input can hold a secret value", () => {
  const html = renderToStaticMarkup(React.createElement(GitCredentialsConfig));

  assert.match(html, /Git Credentials/);
  assert.match(html, /Add credential/);
  // The at-rest note is where the key file is surfaced, and it says what
  // losing it costs.
  assert.match(html, /key file/);
  assert.match(html, /permanently unreadable/);

  const inputs = [...html.matchAll(/<input[^>]*>/g)].map((match) => match[0]);
  assert.ok(inputs.length > 0, "the form has inputs");
  const secretInputs = inputs.filter((tag) => /type="password"/.test(tag));
  assert.ok(secretInputs.length > 0, "the token field is a password input");
  for (const tag of inputs) {
    if (/type="(checkbox|hidden)"/.test(tag)) continue;
    assert.match(tag, /value=""/, `no rendered input carries a value: ${tag}`);
  }
});

test("save stays disabled until the required fields are filled, and remove needs a selection", () => {
  const html = renderToStaticMarkup(React.createElement(GitCredentialsConfig));
  const save = buttons(html).find((button) => button.includes("Save credential"));
  assert.ok(save, "the save button renders");
  assert.match(save, /disabled/);
  // Remove is destructive, so it does not exist until something is selected.
  assert.ok(!buttons(html).some((button) => button.includes("Remove")));
});
