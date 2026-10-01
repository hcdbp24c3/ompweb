import { NextResponse } from "next/server";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  type ProviderConfig,
  serializeModelsConfig,
  validateModelsConfig,
} from "@/lib/omp/models-config";
import { type OmpModel, isNoModelBootFailure, runIsolatedUtilityCommand } from "@/lib/omp/rpc-utility";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

/** `reason` on an otherwise-successful empty discovery. Stable wire value so the
 *  browser can map it to a localized explanation.
 *
 *  omp has no "discovery found nothing" signal: the child runs the discovery,
 *  gets zero models, and falls into the same boot guard a fresh install hits
 *  (coding-agent `main.ts:2425`, "No models available. Use /login or set an API
 *  key…"). For a provider that declares `discovery` that advice is wrong — it
 *  needs no key, it needs a server that answers — so the route reads the refusal
 *  as the result it actually is and hands the UI the fact instead of the text. */
export const DISCOVERY_EMPTY_REASON = "discovery_returned_nothing";

// Model discovery contacts a remote server and spawns a throwaway omp process,
// so it gets the same budget as the connectivity test. Unlike that route, no
// credentials are needed: `discovery` makes omp read the server's own model list.
const DISCOVER_TIMEOUT_MS = 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Exactly the fields the provider/model editors can prefill. The raw
 *  get_available_models entries also carry `identity`, a ~40-key `compat` blob and
 *  internal `baseUrl` values, none of which belong in a browser response. */
export interface DiscoveredModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  thinking?: OmpModel["thinking"];
  input?: string[];
  contextWindow?: number | null;
  maxTokens?: number | null;
  cost?: OmpModel["cost"];
}

function toDiscoveredModels(models: OmpModel[], providerName: string): DiscoveredModel[] {
  return models
    .filter((model) => model?.provider === providerName)
    .map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      thinking: model.thinking,
      input: model.input,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      cost: model.cost,
    }));
}

/** Ask a server which models it serves.
 *
 * Provider-level, unlike `/api/models-config/test`: discovery is declared on the
 * provider, so the model list is the answer rather than an input. The provider is
 * written to a throwaway agent dir and resolved by a dedicated omp process, which
 * means the real ~/.omp (credentials, models.db cache, other providers) is never
 * read or written.
 */
export async function POST(req: Request) {
  let tempDir: string | undefined;
  // Kept outside the try so the catch can tell "omp refused because there is no
  // model" apart from "the spawn failed", which needs the provider block.
  let provider: ProviderConfig | undefined;

  try {
    const body = await req.json() as { providerName?: unknown; provider?: unknown };
    const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
    if (!providerName) return NextResponse.json({ ok: false, error: "providerName is required", code: "provider_name_required" }, { status: 400 });
    if (!isRecord(body.provider)) return NextResponse.json({ ok: false, error: "provider is required", code: "provider_required" }, { status: 400 });

    // Same validation as the connectivity test so the two routes cannot drift.
    // It does not have to be a config omp would load as-is yet — a discovery-only
    // provider is exactly the state the user is editing.
    provider = body.provider as ProviderConfig;
    const config = { providers: { [providerName]: provider } };
    try {
      validateModelsConfig(config);
    } catch (error) {
      return NextResponse.json({ ok: false, error: errorMessage(error), code: "invalid_provider" }, { status: 400 });
    }

    // Profile/XDG overrides are cleared so the redirect always wins (the omp child
    // still honors profiles even though omp-web ignores them).
    tempDir = mkdtempSync(join(tmpdir(), "omp-web-model-discover-"));
    writeFileSync(join(tempDir, "models.yml"), serializeModelsConfig(config), "utf8");

    const startedAt = Date.now();
    const reply = await runIsolatedUtilityCommand<{ models?: OmpModel[] }>(
      { type: "get_available_models" },
      {
        env: { PI_CODING_AGENT_DIR: tempDir, OMP_PROFILE: "", PI_PROFILE: "", XDG_DATA_HOME: "" },
        timeoutMs: DISCOVER_TIMEOUT_MS,
        signal: req.signal,
      },
    );
    const latencyMs = Date.now() - startedAt;

    // A server that answers but exposes nothing is a valid outcome, not a failure.
    const models = Array.isArray(reply?.models) ? toDiscoveredModels(reply.models, providerName) : [];

    return NextResponse.json({ ok: true, models, latencyMs });
  } catch (error) {
    // omp resolved zero models for a provider whose models come from the server
    // itself. That is the discovery's answer — which also covers a server that
    // could not be reached at all, which is why the UI is told to check the
    // endpoint instead of being shown omp's "set an API key" advice. Every other
    // failure (missing binary, timeout) keeps its own error, so nothing
    // unrelated is ever read as "no models".
    if (provider?.discovery && isNoModelBootFailure(error)) {
      return NextResponse.json({
        ok: true,
        models: [],
        reason: DISCOVERY_EMPTY_REASON,
        // Named so the UI can point at the endpoint that was actually asked.
        baseUrl: provider.baseUrl,
      });
    }
    return NextResponse.json({ ok: false, error: errorMessage(error), code: "discover_failed" }, { status: 500 });
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}
