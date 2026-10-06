import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { GitCredentialsConfig, GitIdentityConfig } = await jiti.import("./GitCredentialsConfig.tsx");

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

// The identity block sits inside the credentials panel, above the credential
// list, because it is the other half of "git works from here".
test("the identity block renders above the credential list and states the unset case", () => {
  const html = renderToStaticMarkup(React.createElement(GitCredentialsConfig));
  assert.match(html, /Git Identity/);
  assert.ok(html.indexOf("Git Identity") < html.indexOf("Git Credentials"), "identity comes first");
  // git's own failure for an unset identity is an untranslated stderr string, so
  // the pre-load state has to say it outright rather than look empty.
  assert.match(html, /No git identity is set\./);
  assert.match(html, /git&#x27;s own message/);
  // And it must say where the identity is applied, because that is the reason
  // ~/.gitconfig is not used and a user looking for one would never find it.
  assert.match(html, /GIT_AUTHOR_NAME/);
  assert.match(html, /~\/\.gitconfig is never touched/);
});

test("the identity editor never renders a password input and starts empty", () => {
  const html = renderToStaticMarkup(React.createElement(GitIdentityConfig));
  const inputs = [...html.matchAll(/<input[^>]*>/g)].map((match) => match[0]);
  assert.ok(inputs.length >= 3, "repository, name and email");
  for (const tag of inputs) assert.match(tag, /value=""/, `no rendered input carries a value: ${tag}`);
  assert.ok(!inputs.some((tag) => /type="password"/.test(tag)), "identity is personal data, not a credential — it is editable, not write-only");

  const save = buttons(html).find((button) => button.includes("Save identity"));
  assert.ok(save, "the identity save button renders");
  assert.match(save, /disabled/, "saving is impossible with no name and email");
});
