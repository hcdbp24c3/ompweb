// The client half of the Git tab's write surface. `lib/git-write.test.mjs` and
// `lib/git-action-route.test.mjs` already pin what git does and what the route
// does; this file pins what the BROWSER does with the answer, which is where the
// four plan failures live:
//
//   - an empty commit (disabled here, refused server-side, and this asserts the
//     request never leaves with no selection or no message);
//   - a success claimed for a push git rejected — the outcome is decided by the
//     terminal FRAME, never by "the request resolved";
//   - a cancel that does not stop the child — DELETE must name the id of the
//     operation that is actually running, and each operation gets its own;
//   - a pull that cannot fast-forward — its own code's message, not a generic
//     one, and no invented success.
//
// The single-source rule for git's own wording: a refusal that happens BEFORE git
// runs is omp-web's own, so it has a dictionary entry and is localized; a failure
// that happens after git runs is git's, so it arrives as `output` frames in the
// log this hook accumulates. One assertion below holds each half of that.
import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { act, cleanup, renderHook } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { useGitActions } = await jiti.import("./useGitActions.ts");
const { translate } = await jiti.import("@/lib/i18n");

const REPO = "/repo";
const A = `${REPO}/a.ts`;
const B = `${REPO}/lib/b.ts`;

/** Every request the hook made, in order. */
let requests = [];
/** Answers the next request; a test sets it per case. */
let responder = () => json({ ok: true, output: "" });
/** `refreshes` counts the status refresh the hook asks for after a change. */
let refreshes = 0;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function ndjson(frames) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
  );
}

/**
 * A stream the test drives by hand, so "the push is still running" is a state the
 * assertions can sit in rather than a race. Never closed on its own.
 */
function openStream() {
  const encoder = new TextEncoder();
  let controller;
  const stream = new ReadableStream({ start(c) { controller = c; } });
  return {
    response: () => new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } }),
    send(frame) { controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`)); },
    end(frames = []) {
      for (const frame of frames) controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
      controller.close();
    },
  };
}

/** A POST / a DELETE, whichever the hook sent first. */
function sent(method) {
  return requests.find((request) => request.method === method);
}

beforeEach(() => {
  requests = [];
  refreshes = 0;
  responder = () => json({ ok: true, output: "" });
  globalThis.fetch = async (url, init) => {
    const request = {
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body ? JSON.parse(init.body) : null,
      signal: init?.signal ?? null,
    };
    requests.push(request);
    return await responder(request);
  };
});

afterEach(cleanup);

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

function mount(options = {}) {
  const onChanged = options.onChanged ?? (() => { refreshes += 1; });
  return renderHook((props) => useGitActions({ cwd: REPO, onChanged: props.onChanged }), {
    initialProps: { onChanged },
  });
}

/** Mounted, with a selection and a message typed, ready to commit. */
async function armed() {
  const view = mount();
  act(() => {
    view.result.current.setTickedPaths([A, B]);
    view.result.current.setCommitMessage("  fix the thing  ");
  });
  await settle();
  return view;
}

// ---------------------------------------------------------------------------
// the commit button's rule
// ---------------------------------------------------------------------------

test("a commit needs both a ticked file and a message, and whitespace is not a message", async () => {
  const { result } = mount();
  assert.equal(result.current.canCommit, false, "nothing ticked, nothing typed");
  act(() => result.current.setTickedPaths([A]));
  assert.equal(result.current.canCommit, false, "a ticked file alone is not a commit");
  act(() => result.current.setCommitMessage("   "));
  assert.equal(result.current.canCommit, false, "whitespace is not a message");
  act(() => result.current.setCommitMessage("fix"));
  assert.equal(result.current.canCommit, true);
  // Unticking the only file takes the commit away again, so the control tracks
  // the selection live rather than at the moment of the click.
  act(() => result.current.setTickedPaths([]));
  assert.equal(result.current.canCommit, false);
});

test("commit sends the ticked paths and the trimmed message, with no cancellable id", async () => {
  const { result } = await armed();

  await act(async () => { result.current.commit(); await settle(); });

  const post = sent("POST");
  assert.equal(post.url, "/api/git/action");
  assert.equal(post.body.cwd, REPO);
  assert.equal(post.body.action, "commit");
  assert.equal(post.body.message, "fix the thing", "the message is trimmed on the way out");
  assert.deepEqual(post.body.paths, [A, B]);
  assert.ok(!("id" in post.body), "a commit answers in one round trip, so it is not cancellable");
});

test("a refused commit keeps the message and reports the server's code, not its English text", async () => {
  responder = () => json({ error: "/elsewhere/x.ts is outside this session's working directory.", code: "path_outside_repository" }, 400);
  const { result } = await armed();

  await act(async () => { result.current.commit(); await settle(); });

  assert.equal(result.current.operation.outcome.kind, "error");
  assert.equal(result.current.operation.outcome.message, translate("errors.path_outside_repository"));
  assert.notEqual(result.current.operation.outcome.message, "/elsewhere/x.ts is outside this session's working directory.");
  assert.equal(result.current.commitMessage, "  fix the thing  ", "the message survives so it is not retyped");
  assert.equal(result.current.canCommit, true, "and the button is still there to retry with");
});

test("a successful commit clears the message and asks for the changed files to be re-read", async () => {
  const { result } = await armed();
  await act(async () => { result.current.commit(); await settle(); });

  assert.equal(result.current.operation.running, false);
  assert.equal(result.current.operation.outcome.kind, "done");
  assert.equal(result.current.commitMessage, "", "a committed message is spent");
  assert.equal(refreshes, 1, "the file list has to learn the commit happened");
});

test("no commit leaves the browser while its own rule says it is not ready", async () => {
  // Both halves separately: a caller reaching for `commit()` must be refused for
  // the same reason the button is disabled, or the guard and the control disagree.
  const bare = mount();
  act(() => bare.result.current.setTickedPaths([A]));
  await act(async () => { bare.result.current.commit(); await settle(); });
  assert.deepEqual(requests, [], "a message with nothing ticked is not a commit");

  const worded = mount();
  act(() => worded.result.current.setCommitMessage("fix the thing"));
  await act(async () => { worded.result.current.commit(); await settle(); });
  assert.deepEqual(requests, [], "ticked files with no message are not a commit either");
});

// ---------------------------------------------------------------------------
// streaming a push or a pull
// ---------------------------------------------------------------------------

test("push streams git's output into the log while it runs", async () => {
  const stream = openStream();
  responder = () => stream.response();
  const { result } = mount();

  await act(async () => { result.current.push(); await settle(); });
  assert.equal(result.current.operation.kind, "push");
  assert.equal(result.current.operation.running, true);
  assert.equal(result.current.busy, true);
  assert.equal(result.current.canCancel, true);

  await act(async () => { stream.send({ type: "output", text: "Counting objects: 100% (3/3), done.\r" }); await settle(); });
  assert.match(result.current.operation.log, /Counting objects/);

  // The operation is still running, so the panel is not idle: a second one must
  // not start on top of it (git would refuse on the index lock anyway).
  await act(async () => { result.current.pull(); await settle(); });
  assert.equal(requests.filter((request) => request.method === "POST").length, 1, "one operation at a time");
});

test("git's progress line is folded on its carriage return, not accumulated", async () => {
  // git rewrites one progress line with \r. Appending raw would leave a log that
  // says "Counting objects: 100%" fifty times, which is not progress, it is noise.
  responder = () => ndjson([
    { type: "output", text: "Counting objects:  50% (1/2)\r" },
    { type: "output", text: "Counting objects: 100% (2/2)\r" },
    { type: "done" },
  ]);
  const { result } = mount();

  await act(async () => { result.current.push(); await settle(); });

  assert.match(result.current.operation.log, /Counting objects: 100% \(2\/2\)/);
  assert.doesNotMatch(result.current.operation.log, /50%/, "the superseded state is dropped");
});

test("a rejected push ends as an error carrying git's own message, never as a success", async () => {
  responder = () => ndjson([
    { type: "output", text: "To /repo.git\n" },
    { type: "output", text: " ! [rejected]        main -> main (fetch first)\n" },
    { type: "error", error: "error: failed to push some refs to '/repo.git'", code: "git_write_failed" },
  ]);
  const { result } = mount();

  await act(async () => { result.current.push(); await settle(); });

  assert.equal(result.current.operation.outcome.kind, "error", "git's verdict decides the outcome");
  assert.equal(result.current.operation.outcome.message, translate("errors.git_write_failed"));
  // The remote's message is the outcome, and it is git's own wording, not omp-web's:
  assert.match(result.current.operation.log, /fetch first/);
  assert.match(result.current.operation.log, /To \/repo\.git/);
});

test("a refusal made before git runs is localized, because there is no git output for it", async () => {
  // The other half of the split: `upstreamRemote()` refuses without spawning
  // anything, so the frame carries omp-web's own text and the dictionary owns it.
  responder = () => ndjson([{ type: "error", error: "This branch has no upstream branch to push to.", code: "git_no_upstream" }]);
  const { result } = mount();

  await act(async () => { result.current.push(); await settle(); });

  assert.equal(result.current.operation.outcome.message, translate("errors.git_no_upstream"));
  assert.equal(result.current.operation.log, "", "git never ran, so it said nothing");
});

test("a pull that cannot fast-forward reports that, and does not report a success", async () => {
  responder = () => ndjson([
    { type: "output", text: "Updating a1b2c3d..e4f5a6b\n" },
    { type: "error", error: "fatal: Not possible to fast-forward, aborting.", code: "git_not_fast_forward" },
  ]);
  const { result } = mount();

  await act(async () => { result.current.pull(); await settle(); });

  assert.equal(result.current.operation.kind, "pull");
  assert.equal(result.current.operation.outcome.kind, "error");
  assert.equal(result.current.operation.outcome.message, translate("errors.git_not_fast_forward"));
  assert.ok(result.current.operation.outcome.message.includes(translate("errors.git_not_fast_forward")));
  assert.notEqual(result.current.operation.outcome.message, translate("errors.git_write_failed"));
});

test("a pull that fast-forwards ends as done", async () => {
  responder = () => ndjson([{ type: "output", text: "Updating a1b2c3d..e4f5a6b\n" }, { type: "done" }]);
  const { result } = mount();

  await act(async () => { result.current.pull(); await settle(); });

  assert.equal(result.current.operation.outcome.kind, "done");
  assert.equal(result.current.busy, false);
  assert.equal(refreshes, 1, "a pull moved the working tree, so the file list is stale");
});

test("a stream that ends without a verdict is an error, not a success", async () => {
  // The distinction the whole surface turns on: an HTTP 200 and a resolved stream
  // say nothing about whether git did what was asked.
  responder = () => ndjson([{ type: "output", text: "To /repo.git\n" }]);
  const { result } = mount();

  await act(async () => { result.current.push(); await settle(); });

  assert.equal(result.current.operation.outcome.kind, "error");
  assert.equal(result.current.operation.outcome.message, translate("gitChanges.operationInterrupted"));
});

test("a streamed action answered with a 4xx is an error carrying that code", async () => {
  responder = () => json({ error: "Access denied", code: "access_denied" }, 403);
  const { result } = mount();

  await act(async () => { result.current.push(); await settle(); });

  assert.equal(result.current.operation.outcome.kind, "error");
  assert.equal(result.current.operation.outcome.message, translate("errors.access_denied"));
  assert.equal(result.current.busy, false);
});

// ---------------------------------------------------------------------------
// cancelling
// ---------------------------------------------------------------------------

test("cancel names the running operation's id, and the panel returns to idle when it settles", async () => {
  const stream = openStream();
  responder = (request) => (request.method === "DELETE" ? json({ ok: true }) : stream.response());
  const { result } = mount();

  await act(async () => { result.current.push(); await settle(); });
  const post = sent("POST");
  assert.match(post.body.id, /^push-/);

  await act(async () => { result.current.cancel(); await settle(); });
  const del = sent("DELETE");
  assert.equal(del.url, "/api/git/action");
  assert.deepEqual(Object.keys(del.body), ["id"], "and the id is the whole request");
  assert.deepEqual(del.body, { id: post.body.id }, "the cancel must name the child that is running");
  assert.ok(del.body.id.length > 0, "never an empty or null id, which the route cannot answer");
  assert.equal(result.current.operation.running, true, "still running until the stream says so");
  assert.equal(result.current.canCancel, false, "and the button is not offered twice");

  await act(async () => { stream.end([{ type: "cancelled" }]); await settle(); });
  assert.equal(result.current.operation.outcome.kind, "cancelled");
  assert.equal(result.current.operation.running, false);
  assert.equal(result.current.busy, false);
  assert.equal(result.current.canCancel, false);
  assert.equal(refreshes, 0, "a cancelled push changed nothing to re-read");
});

test("a cancel whose DELETE fails waits for the stream rather than claiming a cancellation", async () => {
  // Reporting "cancelled" here would be a claim about a child that is still
  // running. The stream's own frame is the only thing allowed to say it stopped.
  const stream = openStream();
  responder = (request) => (request.method === "DELETE" ? Promise.reject(new Error("network down")) : stream.response());
  const { result } = mount();

  await act(async () => { result.current.push(); await settle(); });
  await act(async () => { result.current.cancel(); await settle(); });
  assert.equal(result.current.operation.running, true);
  assert.equal(result.current.operation.outcome, null, "no verdict has arrived yet");

  await act(async () => { stream.end([{ type: "error", error: "fatal: unable to access", code: "git_write_failed" }]); await settle(); });
  assert.equal(result.current.operation.outcome.kind, "error");
});

test("each operation gets its own id, so a cancel can never name a previous one", async () => {
  responder = () => ndjson([{ type: "done" }]);
  const { result } = mount();

  await act(async () => { result.current.push(); await settle(); });
  await act(async () => { result.current.push(); await settle(); });
  await act(async () => { result.current.pull(); await settle(); });

  const ids = requests.filter((request) => request.method === "POST").map((request) => request.body.id);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3, `ids repeated: ${JSON.stringify(ids)}`);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9-]{1,64}$/, "the route validates this shape");
});

test("a commit is not cancellable, so no cancel is offered while one is in flight", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  responder = async () => { await held; return json({ ok: true, output: "" }); };
  const { result } = await armed();

  act(() => { result.current.commit(); });
  await settle();
  assert.equal(result.current.operation.kind, "commit");
  assert.equal(result.current.operation.running, true);
  assert.equal(result.current.busy, true);
  assert.equal(result.current.canCancel, false, "there is no child to stop and no id to name");
  assert.equal(result.current.canCommit, false, "so the button cannot be pressed again either");

  await act(async () => { release(); await settle(); });
  assert.equal(result.current.operation.outcome.kind, "done");
  assert.equal(sent("DELETE"), undefined, "a commit must not be asked to cancel");
});

test("an operation still gets an id where the browser has no crypto.randomUUID", async () => {
  // `crypto.randomUUID` only exists in a secure context, and this app is routinely
  // served over plain http on a LAN. A bare call would throw before the push is
  // sent, and the button would silently do nothing.
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
  try {
    responder = () => ndjson([{ type: "done" }]);
    const { result } = mount();
    await act(async () => { result.current.push(); await settle(); });
    const id = sent("POST").body.id;
    assert.match(id, /^push-[A-Za-z0-9-]{1,60}$/, "and the shape the route validates");
    assert.equal(result.current.operation.outcome.kind, "done", "so the push actually ran");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else delete globalThis.crypto;
  }
});

test("there is nothing to cancel before any operation has run", async () => {
  const { result } = mount();
  assert.equal(result.current.canCancel, false);
  assert.equal(result.current.operation, null);
  await act(async () => { result.current.cancel(); await settle(); });
  assert.deepEqual(requests, []);
});

// ---------------------------------------------------------------------------
// the child outliving the panel
// ---------------------------------------------------------------------------

test("leaving the panel stops the request, so the server cancels the child", async () => {
  const stream = openStream();
  responder = () => stream.response();
  const { result, unmount } = mount();

  await act(async () => { result.current.push(); await settle(); });
  const signal = sent("POST").signal;
  assert.equal(signal.aborted, false);

  unmount();
  assert.equal(signal.aborted, true, "an abandoned push must not keep pushing");
});

test("without a cwd there is nothing to commit or push", async () => {
  const { result } = renderHook(() => useGitActions({ cwd: null }));
  await act(async () => { result.current.push(); result.current.commit(); await settle(); });
  assert.deepEqual(requests, []);
  assert.equal(result.current.canCommit, false);
});