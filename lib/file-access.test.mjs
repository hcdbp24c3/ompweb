import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

async function loadSubject() {
  return jiti.import("./file-access.ts");
}

test("rejects an existing path that escapes an allowed root through a symlink", async (t) => {
  const { isExistingPathWithinRoots, isPathWithinRoots } = await loadSubject();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-file-access-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const allowed = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  const link = path.join(allowed, "link");
  fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  const target = path.join(link, "secret.txt");
  const roots = new Set([allowed]);

  assert.equal(isPathWithinRoots(target, roots), true);
  assert.equal(isExistingPathWithinRoots(target, roots), false);
});

// The file explorer can now upload into any folder it lists, so the guard has to
// accept a nested path under an allowed root while still rejecting traversal out
// of it. Before per-folder uploads, every request named a registered session cwd
// exactly, so nothing ever proved the "inside a root" half.
const { isExistingFilePathAllowed } = await loadSubject();
const { mkdtempSync, mkdirSync, rmSync } = fs;
const { tmpdir } = os;
const { join } = path;

test("accepts a nested path under an allowed root, which per-folder uploads rely on", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-roots-"));
  const nested = join(root, "src", "components");
  mkdirSync(nested, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const roots = new Set([root]);
  assert.equal(isExistingFilePathAllowed(nested, roots), true, "a folder inside an allowed root");
  assert.equal(isExistingFilePathAllowed(join(root, "src", "new.txt"), roots), false, "a file is not allowed");
});

test("still refuses a nested path that climbs out of the allowed root", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "omp-web-parent-"));
  const root = join(parent, "project");
  const outside = join(parent, "secret");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  t.after(() => rmSync(parent, { recursive: true, force: true }));

  const roots = new Set([root]);
  assert.equal(isExistingFilePathAllowed(join(root, "src"), roots), true, "the nested folder itself is fine");
  assert.equal(isExistingFilePathAllowed(join(root, "src", "..", "..", "secret"), roots), false);
  assert.equal(isExistingFilePathAllowed(outside, roots), false);
  assert.equal(isExistingFilePathAllowed(join(parent, "secret"), roots), false);
});
