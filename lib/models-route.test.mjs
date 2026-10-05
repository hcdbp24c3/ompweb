// The provider cards join omp's runtime model list against the provider keys in
// ~/.omp/agent/models.yml by string equality, so this file pins the half of that
// assumption omp-web owns: `/api/models` must hand the browser omp's `provider`
// field unchanged. A normalizer here (lowercasing, stripping a prefix, mapping to
// omp's built-in provider ids) would silently empty every card, and nothing else
// in the app would notice — the composer reads the same field but only ever
// displays it.
//
// The other half is omp's own behavior — that `get_available_models` reports a
// models.yml provider key verbatim in `model.provider`. Measured on omp 18.4.6
// against a throwaway agent dir declaring `providers.zzprobe` with
// `discovery: openai-models-list`: both resolved models came back as
// `{provider: "zzprobe"}`. `/api/models-config/discover` already relies on the
// same equality (toDiscoveredModels), so the two routes cannot drift apart.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

// The route spawns real omp children, so the RPC helper is replaced with a stub
// that scripts the three registry commands it sends. The stub is `.ts` on purpose
// (same reason as models-config-discover-route.test.mjs): only jiti transforms it.
const stubDir = mkdtempSync(join(tmpdir(), "omp-web-models-stub-"));
const stubPath = join(stubDir, "rpc-utility-stub.ts");
writeFileSync(
  stubPath,
  `export const state = { models: [] };
export async function runUtilityCommand(command) {
  if (command.type === "get_available_models") return { models: state.models };
  if (command.type === "get_login_providers") return { providers: state.loginProviders ?? [] };
  if (command.type === "get_state") return { model: { provider: null, id: null } };
  throw new Error("unexpected command " + command.type);
}
export function disposeUtilityRpc() {}
`,
  "utf8",
);

const jiti = createJiti(import.meta.url, {
  alias: { "@/lib/omp/rpc-utility": stubPath, "@/": repoRoot },
});
const { GET } = await jiti.import("../app/api/models/route.ts");
const stub = await jiti.import(stubPath);
const { invalidateModelsCache } = await jiti.import("../lib/models-cache.ts");

test.after(() => rmSync(stubDir, { recursive: true, force: true }));

async function get() {
  invalidateModelsCache();
  return (await GET()).json();
}

/** A provider key shaped to break a normalizer: uppercase, a dash, an underscore
 *  and a digit. models.yml accepts it verbatim, and omp reports it verbatim. */
const PROVIDER_KEY = "ZZ-Lab_2";

test("modelList carries omp's provider string through untouched, so the client can join it to a models.yml key", async () => {
  stub.state.models = [
    { id: "zz-alpha", name: "ZZ Alpha", provider: PROVIDER_KEY },
    { id: "zz-beta", name: "ZZ Beta", provider: PROVIDER_KEY },
    // A built-in catalog provider, to prove nothing is rewritten to omp's own ids.
    { id: "gpt-5", name: "GPT-5", provider: "openai" },
  ];

  const body = await get();

  const custom = body.modelList.filter((model) => model.id.startsWith("zz-"));
  assert.equal(custom.length, 2);
  for (const model of custom) {
    assert.equal(
      model.provider,
      PROVIDER_KEY,
      "the join key is omp's own string; case-folding or prefix-stripping it empties every provider card",
    );
  }
  assert.ok(
    body.modelList.some((model) => model.provider === "openai"),
    "catalog providers keep their own provider ids",
  );
});

test("modelList is not filtered by login status — /api/auth/all-providers is a different question", async () => {
  // The composer does not filter either, so a filter here would make this surface
  // disagree with the one place the list is used to pick a model.
  stub.state.models = [{ id: "zz-alpha", name: "ZZ Alpha", provider: PROVIDER_KEY }];
  stub.state.loginProviders = [];

  const body = await get();

  assert.equal(body.modelList.length, 1, "an un-authenticated provider's models are still reported");
  assert.deepEqual(body.connectedProviders, [], "the login-shaped payload is empty, which is where that filter belongs");
});

test("an unusable modelList entry is dropped rather than joining on a null provider", async () => {
  stub.state.models = [
    { id: "zz-alpha", name: "ZZ Alpha", provider: PROVIDER_KEY },
    { id: "no-provider", name: "No Provider" },
    null,
  ];

  const body = await get();

  assert.deepEqual(body.modelList.map((model) => model.id), ["zz-alpha"]);
});