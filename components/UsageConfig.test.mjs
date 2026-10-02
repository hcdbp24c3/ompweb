import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});

const { UsageConfig } = await jiti.import("./UsageConfig.tsx");

test("UsageConfig renders static markup without crashing", () => {
  const html = renderToStaticMarkup(React.createElement(UsageConfig));
  assert.ok(html.length > 0);
  // Initial state renders the loading indicator
  assert.ok(html.includes("Loading usage analytics") || html.includes("Usage"));
});

// The model breakdown carried `provider` all along but rendered only the model
// id, using the provider solely as the React key. Two providers exposing the
// same model id therefore produced two rows that looked identical.
import "../tests/setup-dom.mjs";
import { cleanup, render, screen, waitFor } from "@testing-library/react/pure.js";
import { afterEach, beforeEach } from "node:test";

beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
afterEach(cleanup);

const J = (d) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });

function row(model, provider, cost, tokens) {
  return {
    model, provider, cost, tokens,
    inputTokens: tokens, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, share: 50,
  };
}

async function renderBreakdown(t, modelBreakdown) {
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).startsWith("/api/usage")) {
      return J({ summary: null, providers: [], modelBreakdown, dayBreakdown: [], projectBreakdown: [] });
    }
    return J({});
  });
  const view = render(React.createElement(UsageConfig));
  // The default breakdown view is "model"; wait for the report to land.
  await waitFor(() => screen.getByText(/sonnet/i), { timeout: 4000 }).catch(() => {});
  return view;
}

test("the model breakdown names the provider, so same-id models stay distinguishable", async (t) => {
  await renderBreakdown(t, [
    row("gpt-4o", "openai", 1.5, 1000),
    row("gpt-4o", "azure-openai", 2.5, 2000),
  ]);

  assert.ok(
    await screen.findByText("openai", {}, { timeout: 4000 }),
    "the first provider is visible",
  );
  assert.ok(
    screen.getByText("azure-openai"),
    "and so is the second — two providers sharing a model id are now tellable apart",
  );
});

test("each row carries the full provider/model selector for hover and copy", async (t) => {
  const view = await renderBreakdown(t, [row("gpt-4o", "azure-openai", 2.5, 2000)]);

  const titled = [...view.container.querySelectorAll("[title]")]
    .map((el) => el.getAttribute("title"))
    .filter((value) => value?.includes("azure-openai"));
  assert.ok(
    titled.some((value) => value === "azure-openai/gpt-4o"),
    `expected a title of "azure-openai/gpt-4o", saw ${JSON.stringify(titled)}`,
  );
});
