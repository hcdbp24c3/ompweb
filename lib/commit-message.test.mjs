import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tryNative: false, alias: { "@/": new URL("../", import.meta.url).pathname } });
const {
  summarizeTickedChanges,
  readCommitMessageMode,
  writeCommitMessageMode,
  COMMIT_MESSAGE_MODE_KEY,
} = await jiti.import("../lib/commit-message.ts");

const file = (filePath, status) => ({ filePath, status });

test("nothing ticked says nothing, rather than an empty-looking subject", () => {
  assert.equal(summarizeTickedChanges([]), "");
});

test("the message names the change, not just the file", () => {
  assert.equal(summarizeTickedChanges([file("a.ts", "modified")]), "updated a.ts");
  assert.equal(summarizeTickedChanges([file("a.ts", "deleted")]), "removed a.ts");
  assert.equal(summarizeTickedChanges([file("a.ts", "untracked")]), "new a.ts");
  assert.equal(summarizeTickedChanges([file("a.ts", "renamed")]), "renamed a.ts");
});

test("kinds are grouped, and the order is the commit's arc rather than the tick order", () => {
  // Ticked deleted-first on purpose: reverse input must give the same subject.
  const subject = summarizeTickedChanges([
    file("c.ts", "modified"),
    file("z.ts", "deleted"),
    file("n.ts", "untracked"),
    file("a.ts", "modified"),
  ]);
  assert.equal(subject, "removed z.ts; new n.ts; updated a.ts, c.ts");
});

test("a conflict outranks everything else, because it stops the commit", () => {
  const subject = summarizeTickedChanges([
    file("a.ts", "modified"),
    file("b.ts", "conflict"),
  ]);
  assert.equal(subject, "conflicted b.ts; updated a.ts");
});

test("the same change produces the same subject whatever order it was ticked in", () => {
  const a = summarizeTickedChanges([file("x", "modified"), file("y", "modified"), file("z", "added")]);
  const b = summarizeTickedChanges([file("z", "added"), file("y", "modified"), file("x", "modified")]);
  assert.equal(a, b);
});

test("a long change stays readable and still accounts for every file", () => {
  const many = Array.from({ length: 12 }, (_, i) => file(`src/f${i}.ts`, "modified"));
  const subject = summarizeTickedChanges(many);
  assert.equal(subject, "updated src/f0.ts, src/f1.ts, src/f2.ts; +9 more");
  // The count is the claim that nothing was dropped, so it has to be right.
  assert.match(subject, /\+9 more$/);
});

test("per-group caps add up, not multiply", () => {
  const fiveNew = Array.from({ length: 5 }, (_, i) => file(`n${i}.ts`, "untracked"));
  const fiveMod = Array.from({ length: 5 }, (_, i) => file(`m${i}.ts`, "modified"));
  assert.equal(summarizeTickedChanges([...fiveNew, ...fiveMod]), "new n0.ts, n1.ts, n2.ts; updated m0.ts, m1.ts, m2.ts; +4 more");
});

test("the cap is configurable", () => {
  assert.equal(summarizeTickedChanges([file("a", "modified"), file("b", "modified")], { maxPathsPerGroup: 1 }),
    "updated a; +1 more");
});

test("an unknown status is still accounted for, never dropped", () => {
  // A kind this build has never heard of must not vanish from the subject.
  const subject = summarizeTickedChanges([file("weird.ts", "spooky"), file("a.ts", "modified")]);
  assert.match(subject, /updated a\.ts/);
  assert.match(subject, /1 other/);
});

test("a file ticked but already committed is not silently dropped", () => {
  const subject = summarizeTickedChanges([file("a.ts", "modified"), file("b.ts", "modified"), file("c.ts", "modified")], { maxPathsPerGroup: 2 });
  assert.equal(subject, "updated a.ts, b.ts; +1 more");
});

// ---------------------------------------------------------------------------
// Mode persistence. A cosmetic preference must never be why the tab fails.
// ---------------------------------------------------------------------------

function withStorage(storage, run) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  try {
    return run();
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  }
}

const memoryStorage = () => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
};

test("the mode round-trips", () => {
  withStorage(memoryStorage(), () => {
    writeCommitMessageMode("ai");
    assert.equal(readCommitMessageMode(), "ai");
    writeCommitMessageMode("auto");
    assert.equal(readCommitMessageMode(), "auto");
  });
});

test("auto is the default, so the box works before anything is chosen", () => {
  withStorage(memoryStorage(), () => assert.equal(readCommitMessageMode(), "auto"));
  withStorage({ getItem: () => null, setItem: () => {} }, () => assert.equal(readCommitMessageMode(), "auto"));
});

test("a stored value that is neither mode falls back instead of leaking through", () => {
  withStorage({ getItem: () => "wat", setItem: () => {} }, () => assert.equal(readCommitMessageMode(), "auto"));
});

test("private browsing, where localStorage throws, is not an error", () => {
  const hostile = {
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("denied"); },
  };
  withStorage(hostile, () => {
    assert.equal(readCommitMessageMode(), "auto");
    assert.doesNotThrow(() => writeCommitMessageMode("ai"));
  });
  assert.equal(COMMIT_MESSAGE_MODE_KEY, "omp-web:commit-message-mode");
});
test("numbers in names order naturally, so f2 does not follow f11", () => {
  const subject = summarizeTickedChanges(
    [file("f10.ts", "modified"), file("f2.ts", "modified"), file("f1.ts", "modified")],
    { maxPathsPerGroup: 2 },
  );
  // Lexicographic would give "f1.ts, f10.ts" and read as a bug in the subject.
  assert.equal(subject, "updated f1.ts, f2.ts; +1 more");
});
