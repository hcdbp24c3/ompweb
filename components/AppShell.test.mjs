import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("sidebar drag scales pointer deltas by the interface zoom", async () => {
  const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  // clientX is viewport pixels while --sidebar-width is zoomed layout pixels;
  // without the correction the edge overshoots at 110/120% scale.
  assert.match(source, /--ui-scale/);
  assert.match(source, /\(ev\.clientX - startX\) \/ uiScale/);
});

// Source-level guard: the tests here do not render AppShell, so this pins the
// condition rather than the behaviour. The real proof is a reload in a browser;
// this exists so the condition cannot silently lose its projects gate again.
test("the get-started placeholder waits for the project list before claiming a first run", async () => {
  const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const show = /const showPlaceholder\s*=\s*([^;]+);/.exec(source)?.[1] ?? "";
  assert.match(show, /projectsSettled/, "showPlaceholder must require the project list to have settled");
  // The project count is the load-bearing half. Settling the list is not enough:
  // the sidebar adopts the project in the effect after its restore, so gating only
  // on "settled" still showed the beginner screen for 300ms+ on every reload.
  assert.match(show, /projects\.length === 0/, "a user who has projects must never see the first-run screen");
  // initialSessionRestored alone is the regression: it is initialised to true
  // whenever the URL carries no session id, which is every plain reload.
  assert.doesNotMatch(show, /^initialSessionRestored && !showChat$/);
});
