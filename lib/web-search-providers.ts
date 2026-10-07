/**
 * Which provider cards are web-search backends rather than model providers.
 *
 * omp has no RPC that says "this provider is a search backend" — the provider
 * list is derived from `get_available_models` (see `app/api/auth/all-providers`),
 * which returns anything that resolves a model. So this is a heuristic, and it
 * is deliberately a MISPLACEMENT risk only: an id that is missing from the set
 * lands in the AI section where it was before, which is where it was already
 * correct. Nothing is hidden either way, which is the property that matters —
 * a provider omp can use must always be clickable.
 *
 * Sources, all read out of the omp binary rather than assumed:
 * - backend names present as standalone strings: exa, tavily, searxng,
 *   perplexity, jina, brave, duckduckgo, google/gemini
 * - `webSearchOrder` is omp's own provider-preference list for search
 *
 * `google` and `gemini` are deliberately ABSENT even though the binary lists
 * them beside the search backends: both are ordinary model providers, and
 * moving a real chat provider into a "web search" section would be worse than
 * leaving a search backend in the AI list.
 */
const WEB_SEARCH_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "brave",
  "duckduckgo",
  "exa",
  "jina",
  "perplexity",
  "searxng",
  "tavily",
]);

export function isWebSearchProvider(providerId: string): boolean {
  return WEB_SEARCH_PROVIDER_IDS.has(providerId.trim().toLowerCase());
}

/**
 * Split a provider list into the two sections, preserving the order it arrived
 * in. Both halves may be empty; the caller renders a heading per non-empty one.
 */
export function partitionByWebSearch<T extends { id: string }>(
  providers: readonly T[],
): { ai: T[]; webSearch: T[] } {
  const ai: T[] = [];
  const webSearch: T[] = [];
  for (const provider of providers) {
    (isWebSearchProvider(provider.id) ? webSearch : ai).push(provider);
  }
  return { ai, webSearch };
}