/**
 * Marketplace catalog browsing for omp-web.
 *
 * `omp plugin marketplace` and `omp plugin discover` are the only ways to reach
 * a marketplace catalog, and neither honours `--json` — `handleDiscover()` takes
 * `(args, _flags)` and never reads the flags, so both print human text either
 * way. `omp plugin list --json` does emit JSON, but its `marketplace` array is
 * `listInstalledPlugins()` (plugins already installed), not the browsable
 * catalog, so it cannot substitute. Measured against omp 18.4.6.
 *
 * That leaves parsing the text output. The caller forces FORCE_COLOR=0 and
 * NO_COLOR=1, so it arrives plain and the shapes are indentation-driven:
 *
 *     Configured Marketplaces:
 *
 *       <name>  <source>
 *
 *     Available Plugins:
 *
 *       <name>[@<version>]
 *         <description>
 *
 * Every parser returns a `warning` instead of throwing. A format change in omp
 * must degrade to an empty list the UI can explain, never to a wrong one — a
 * silently empty catalog reads as "this marketplace has nothing in it".
 */

/** Mirrors `ANSI_RE` in the plugins route: runOmp strips colour, but a caller
 *  that forgets (or a TTY-less pipe that still emits it) should not break us. */
const ANSI_RE = /\x1B\[[0-9;]*m/g;

export interface MarketplaceEntry {
  name: string;
  source: string;
}

export interface DiscoverablePlugin {
  name: string;
  version: string | null;
  description: string | null;
}

/**
 * A `warning` is set only when the output matched no header omp prints today —
 * a format change — so the caller can tell "this marketplace is empty" apart
 * from "omp-web no longer understands omp".
 */
export interface MarketplaceListResult {
  marketplaces: MarketplaceEntry[];
  warning: string | null;
}

export interface DiscoverResult {
  plugins: DiscoverablePlugin[];
  warning: string | null;
}

/** omp's "none configured" / "none available" lines mean empty, not broken. */
const EMPTY_MARKERS = [
  "no marketplaces configured",
  "no plugins available",
  "no plugins found in",
];

function normalise(raw: string): string[] {
  return raw.replace(ANSI_RE, "").replace(/\r\n?/g, "\n").split("\n");
}

/** A marketplace source is a URL, a git remote or an absolute path — never a
 *  bare word — so the two-column split is on runs of 2+ spaces. Trim first:
 *  the entry's own indent would otherwise satisfy `\s{2,}` and leave the name
 *  empty. */
function splitColumns(line: string): [string, string] | null {
  const match = /^(.*?)\s{2,}(\S.*)$/.exec(line.trim());
  if (!match) return null;
  const name = match[1].trim();
  const source = match[2].trim();
  return name && source ? [name, source] : null;
}

/**
 * Parse `omp plugin marketplace` (bare or `--json`, which behaves identically).
 * Entries are `name  source`; anything else is skipped.
 */
export function parseMarketplaceList(raw: string): MarketplaceListResult {
  const lines = normalise(raw);
  if (lines.some((line) => EMPTY_MARKERS.some((marker) => line.toLowerCase().includes(marker)))) {
    return { marketplaces: [], warning: null };
  }
  if (!lines.some((line) => line.trim().toLowerCase().startsWith("configured marketplaces"))) {
    return { marketplaces: [], warning: "unrecognised `omp plugin marketplace` output" };
  }

  const marketplaces: MarketplaceEntry[] = [];
  for (const line of lines) {
    // Only the two-space-indented block under the header holds entries.
    if (!/^\s{2,}\S/.test(line)) continue;
    const columns = splitColumns(line);
    if (columns) marketplaces.push({ name: columns[0], source: columns[1] });
  }
  return { marketplaces, warning: null };
}

/** Split `name@version`, keeping a scoped name's own leading `@` intact: the
 *  separator is the LAST `@`, and a bare name has no version at all. */
function splitNameVersion(token: string): { name: string; version: string | null } {
  const at = token.lastIndexOf("@");
  if (at <= 0) return { name: token, version: null };
  return { name: token.slice(0, at), version: token.slice(at + 1) };
}

/**
 * Parse `omp plugin discover [<marketplace>]`. Entries are a two-space-indented
 * `name[@version]` line optionally followed by a four-space-indented
 * description line.
 */
export function parseDiscoverOutput(raw: string): DiscoverResult {
  const lines = normalise(raw);
  if (lines.some((line) => EMPTY_MARKERS.some((marker) => line.toLowerCase().includes(marker)))) {
    return { plugins: [], warning: null };
  }
  // Accepts both the bare header and the ` (marketplace)` filtered form.
  if (!lines.some((line) => /^available plugins\b/i.test(line.trim()))) {
    return { plugins: [], warning: "unrecognised `omp plugin discover` output" };
  }

  const plugins: DiscoverablePlugin[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^\s{2,}\S/.test(line)) continue;
    // A description line is indented deeper than its plugin line; skip it here
    // and fold it into the entry it belongs to.
    if (/^\s{4,}\S/.test(line)) continue;
    const { name, version } = splitNameVersion(line.trim());
    if (!name) continue;
    const next = lines[index + 1] ?? "";
    const description = /^\s{4,}\S/.test(next) ? next.trim() : null;
    if (description) index += 1;
    plugins.push({ name, version, description });
  }
  return { plugins, warning: null };
}

/**
 * The reference omp installs a marketplace plugin by: `name@marketplace`.
 * Separating on the last `@` keeps a scoped `@acme/pkg` intact.
 */
export function pluginInstallRef(name: string, marketplace?: string | null): string {
  return marketplace ? `${name}@${marketplace}` : name;
}