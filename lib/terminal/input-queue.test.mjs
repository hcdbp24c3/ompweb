// The browser-side half of the terminal input path: one FIFO of /input requests,
// because the route writes straight to the pty in whatever order the requests
// arrive. Everything here is about order — what reached the shell, in what
// sequence, how many requests it took, and what happens when one of them fails.
//
// The sender is deliberately inert: it records each request and waits for the
// test to answer it. A sender that answered itself could not tell a queue that
// serialises from one that fires a burst and forgets it, which is the whole
// defect.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { MAX_INPUT_BYTES, createTerminalInputQueue } = await jiti.import("@/lib/terminal/input-queue.ts");

/** Node runs macrotasks after the pending microtasks, so one turn is enough for
 *  a resolved promise and whatever the queue chained onto it. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A sender that records what it was asked for and never answers on its own.
 *
 * `calls` is the requests still in flight, so `calls.length` is the number of
 * requests the queue has in flight right now — the measurement that separates a
 * serialised queue from one that fires and forgets.
 */
function recordingSender() {
  const calls = [];
  const sent = [];
  return {
    sent,
    calls,
    send(body) {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      calls.push({ body, resolve, reject });
      sent.push(body);
      return promise;
    },
    /** Answer one request and let the queue react, e.g. by sending the next.
     *  `answer` settles the call; the default is a plain success. */
    async answerOne(answer = (call) => call.resolve()) {
      const call = calls.shift();
      answer(call);
      await settle();
      return call;
    },
    /** Answer everything outstanding, one at a time, in issue order. */
    async drain(answer = (call) => call.resolve()) {
      while (calls.length > 0) await this.answerOne(answer);
    },
  };
}

function harness(options = {}) {
  const sender = recordingSender();
  const errors = [];
  const queue = createTerminalInputQueue({
    cwd: "/repo",
    send: sender.send,
    onError: (error, kind) => errors.push({ error, kind }),
    ...options,
  });
  return { queue, sender, errors };
}

const sentData = (sent) => sent.map((body) => body.data);

test("an idle queue sends a keystroke at once", async () => {
  // No artificial delay in front of the user: with nothing in flight there is
  // nothing to be out of order with.
  const { queue, sender } = harness();
  queue.write("a");
  assert.equal(sender.calls.length, 1);
  assert.deepEqual(sender.sent[0], { cwd: "/repo", data: "a" });
});

test("a keystroke burst is sent in order, one request at a time", async () => {
  const { queue, sender } = harness();
  queue.write("a");
  queue.write("b");
  queue.write("c");
  assert.equal(sender.calls.length, 1, "only the first is in flight");
  assert.deepEqual(sender.sent[0], { cwd: "/repo", data: "a" });

  await sender.answerOne();
  assert.deepEqual(sender.sent[1], { cwd: "/repo", data: "bc" }, "the rest travel together, in order");

  await sender.drain();
  assert.equal(sentData(sender.sent).join(""), "abc");
});

test("a resize waits behind the keystrokes queued in front of it", async () => {
  // /api/terminal/input writes data and applies a resize in one handler, so a
  // resize that overtook a queued keystroke would reflow a half-typed line.
  const { queue, sender } = harness();
  queue.write("a");
  queue.resize(120, 40);
  assert.equal(sender.calls.length, 1, "the resize is not in flight beside the keystroke");

  await sender.drain();
  assert.deepEqual(sender.sent[1], { cwd: "/repo", cols: 120, rows: 40 });
});

test("a newer measurement replaces a resize that has not gone out yet", async () => {
  // A window drag measures many times and the middle ones are stale by the time
  // they would be sent, so the pending size is one slot, not a queue of them.
  const { queue, sender } = harness();
  queue.write("a");
  queue.resize(100, 30);
  queue.resize(120, 40);

  await sender.drain();
  assert.deepEqual(sender.sent[1], { cwd: "/repo", cols: 120, rows: 40 });
  assert.equal(sender.sent.length, 2, "the superseded measurement is never sent");
});

test("a keystroke after a queued resize keeps its place in the line", async () => {
  const { queue, sender } = harness();
  queue.write("a");
  queue.resize(120, 40);
  queue.write("b");

  await sender.drain();
  assert.deepEqual(sender.sent.slice(1), [
    { cwd: "/repo", cols: 120, rows: 40 },
    { cwd: "/repo", data: "b" },
  ]);
});

test("a rejected request does not stop the queue", async () => {
  // A dropped connection — the server restarting mid-command, a proxy cutting the
  // request — arrives as a thrown error. If that ended the chain, one lost request
  // would leave the keyboard dead for the rest of the session.
  const { queue, sender, errors } = harness();
  queue.write("a");
  queue.write("b");
  await sender.answerOne((call) => call.reject(new TypeError("Failed to fetch")));
  assert.equal(errors.length, 1, "the failure is reported rather than swallowed");
  assert.deepEqual(errors[0].kind, "keys", "as a keystroke failure, which has no retry of its own");
  assert.equal(sender.calls.length, 1, "and the queued keystroke still goes out");

  await sender.drain();
  assert.equal(sentData(sender.sent).join(""), "ab");
});

test("a keystroke sent after a failure still reaches the shell", async () => {
  const { queue, sender } = harness();
  queue.write("a");
  await sender.answerOne((call) => call.reject(new Error("boom")));
  queue.write("b");
  await sender.drain();
  assert.equal(sentData(sender.sent).join(""), "ab");
});

test("a refused resize is reported as a resize, so the panel can post it again", async () => {
  // A 400 on a window drag is not something the user did, and the panel answers it
  // by un-recording the size and posting the same one again — so the failure has to
  // reach it, tagged as a resize rather than as a failed keystroke.
  const { queue, sender, errors } = harness();
  queue.write("a");
  queue.resize(120, 40);
  await sender.drain((call) => {
    if (call.body.data === undefined) call.reject(new Error("terminal_size_invalid"));
    else call.resolve();
  });

  assert.equal(errors.length, 1);
  assert.equal(errors[0].kind, "resize");
  assert.equal(errors[0].error.message, "terminal_size_invalid");
  assert.equal(sender.sent.length, 2);
});

test("a payload past the route's own limit is split in order, never truncated", async () => {
  // The input route refuses `data` over MAX_INPUT_BYTES with a 413. Coalescing
  // two pastes could produce such a payload on its own, so the queue splits at the
  // limit — silently dropping the overflow would lose the tail of a paste, which
  // is exactly the "keyboard is dead" symptom a dropped request causes.
  const { queue, sender } = harness({ maxInputBytes: 4 });
  queue.write("abc");
  await sender.answerOne();
  queue.write("defgh");

  await sender.drain();
  assert.deepEqual(sender.sent.map((body) => body.data), ["abc", "defg", "h"]);
  assert.equal(sentData(sender.sent).join(""), "abcdefgh");
});

test("a payload over the limit is split even when the queue is idle", async () => {
  // Otherwise the first chunk would be the one request the route refuses.
  const { queue, sender } = harness({ maxInputBytes: 4 });
  queue.write("abcdefgh");
  await sender.drain();
  assert.deepEqual(sender.sent.map((body) => body.data), ["abcd", "efgh"]);
});

test("a split never cuts a character in half", async () => {
  // 7 bytes fits € (3) + ✓ (3) but not the emoji (4) on top, so the split has to
  // fall on a character boundary rather than at the limit.
  const { queue, sender } = harness({ maxInputBytes: 7 });
  queue.write("a");
  await sender.answerOne();
  queue.write("€✓😀");
  await sender.drain();

  assert.deepEqual(sender.sent.map((body) => body.data), ["a", "€✓", "😀"]);
  assert.equal(sentData(sender.sent).join(""), "a€✓😀");
});

test("dispose drops what is queued and sends nothing more", async () => {
  // /input *attaches*, which spawns a shell when the cwd is not live: a queue that
  // flushed after teardown would resurrect a shell nobody is watching.
  const { queue, sender } = harness();
  queue.write("a");
  queue.write("b");
  queue.resize(120, 40);
  queue.dispose();

  await sender.drain();
  assert.deepEqual(sender.sent.map((body) => body.data), ["a"]);
  assert.equal(sender.calls.length, 0);

  queue.write("c");
  queue.resize(90, 28);
  assert.equal(sender.calls.length, 0, "a disposed queue is not a queue that went quiet");
});

test("dispose does not report the in-flight request's failure", async () => {
  // The panel is gone; there is nothing left to tell.
  const { queue, sender, errors } = harness();
  queue.write("a");
  queue.dispose();
  await sender.answerOne((call) => call.reject(new Error("network changed")));
  assert.equal(errors.length, 0);
});

test("the coalescing limit is the input route's own limit", () => {
  // The two constants are a pair, and nothing in the type system connects them: read
  // the route's declaration as a value so one side cannot quietly drift from the
  // other and start splitting (or not splitting) at a limit the route ignores.
  const route = readFileSync(new URL("../../app/api/terminal/input/route.ts", import.meta.url), "utf8");
  const declaration = /const MAX_INPUT_BYTES = ([^;]+);/.exec(route);
  assert.ok(declaration, "the input route still declares MAX_INPUT_BYTES");
  const routeLimit = Function(`"use strict"; return ${declaration[1].replaceAll("_", "")};`)();
  assert.equal(MAX_INPUT_BYTES, routeLimit);
});

test("nothing is sent for an empty keystroke", async () => {
  const { queue, sender } = harness();
  queue.write("");
  assert.equal(sender.calls.length, 0);
});