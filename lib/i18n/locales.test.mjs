// `translate()` falls back to the English string and, when that is missing too,
// returns the key itself: `dictionaries[locale]?.[key] ?? dictionaries.en[key] ?? key`.
// So a key present in en.json but absent from ja/zh-CN renders as raw text — for a
// plural key literally "gitChanges.filesChanged.other". 29 keys were in that
// state, covering the whole Git-changes panel, the composer context readout, and
// a batch of app-shell and sidebar affordances. Nothing caught it because every
// existing test asserted a key it had just added to all three files.
//
// Parity is the invariant: a locale may add a key en does not have (translate
// falls back to en), but it must never miss one that en has.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const LOCALES = ["en", "ja", "zh-CN"];
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const dicts = Object.fromEntries(
  LOCALES.map((locale) => [
    locale,
    JSON.parse(readFileSync(new URL(`./locales/${locale}.json`, import.meta.url), "utf8")),
  ]),
);
const enKeys = Object.keys(dicts.en);

/** Every literal key passed to tn(), straight from the source. */
function tnKeys() {
  const out = execFileSync(
    "bash",
    [
      "-c",
      `grep -rhoE 'tn\\(\\s*"[a-zA-Z0-9._]+"' components lib app --include=*.tsx --include=*.ts | sed 's/tn(\\s*//;s/"//g' | sort -u`,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return out.split("\n").filter(Boolean);
}

test("every locale defines every key en.json defines", () => {
  const problems = [];
  for (const locale of LOCALES) {
    if (locale === "en") continue;
    const missing = enKeys.filter((key) => !(key in dicts[locale]));
    if (missing.length) {
      problems.push(`${locale} is missing ${missing.length}: ${missing.slice(0, 8).join(", ")}`);
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("no locale carries a key en.json does not define", () => {
  // translate() cannot fall back for these, so they render as the key itself.
  const problems = [];
  for (const locale of LOCALES) {
    const extra = Object.keys(dicts[locale]).filter((key) => !(key in dicts.en));
    if (extra.length) {
      problems.push(`${locale} has ${extra.length} key(s) absent from en: ${extra.slice(0, 8).join(", ")}`);
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("locale files have the same key count, so parity cannot drift one-sided", () => {
  const counts = LOCALES.map((locale) => [locale, Object.keys(dicts[locale]).length]);
  assert.equal(
    new Set(counts.map(([, n]) => n)).size,
    1,
    `counts differ: ${counts.map(([l, n]) => `${l}=${n}`).join(" ")}`,
  );
});

test("plural keys ship both forms in every locale", () => {
  // tn() resolves `<key>.one` for count===1 and `<key>.other` otherwise, so a key
  // with only one form falls back to the raw key for the other count.
  const bases = new Set(
    enKeys
      .filter((k) => k.endsWith(".one") || k.endsWith(".other"))
      .map((k) => k.replace(/\.(one|other)$/, "")),
  );
  assert.ok(bases.size > 0, "the locale files use the plural form at all");

  const problems = [];
  for (const base of bases) {
    for (const locale of LOCALES) {
      for (const form of ["one", "other"]) {
        if (!(`${base}.${form}` in dicts[locale])) problems.push(`${locale} missing ${base}.${form}`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("every tn() call in the source resolves in every locale", () => {
  // The direct guard for this bug class: a plural call whose key lacks the form
  // for its count renders the raw key at runtime, which no JSON-only test sees.
  const keys = tnKeys();
  assert.ok(keys.length > 0, "found tn() call sites to check");

  const problems = [];
  for (const key of keys) {
    for (const locale of LOCALES) {
      for (const form of ["one", "other"]) {
        if (!(`${key}.${form}` in dicts[locale])) {
          problems.push(`${locale} missing ${key}.${form} (used by tn("${key}"))`);
        }
      }
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("no terminal hint carries backticks, because the panel renders them as plain text", () => {
  // The terminal panel paints its guidance into a plain <div>, so markdown
  // punctuation in a locale file reaches the user verbatim. `OMP_WEB_PASSWORD`
  // shipped with backticks around it and rendered as literal backticks in all
  // three locales; parity of *content* is not covered by the key-parity tests.
  const problems = [];
  for (const locale of LOCALES) {
    for (const [key, value] of Object.entries(dicts[locale])) {
      if (!key.startsWith("terminal.")) continue;
      if (typeof value !== "string") continue;
      if (value.includes("`")) problems.push(`${locale} ${key}: ${value}`);
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("plural templates receive the count they interpolate", () => {
  // A plural string that hardcodes "1" instead of {count} is fine for .one, but
  // the .other form must interpolate or it will show a literal {count}.
  const problems = [];
  for (const locale of LOCALES) {
    for (const [key, value] of Object.entries(dicts[locale])) {
      if (typeof value !== "string") continue;
      if (!key.endsWith(".other")) continue;
      if (!value.includes("{count}")) problems.push(`${locale} ${key} does not interpolate {count}`);
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});