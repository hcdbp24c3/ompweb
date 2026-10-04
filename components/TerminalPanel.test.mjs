// xterm.js and the terminal routes are both outside a node test's reach, so the
// panel takes the xterm classes as an injectable prop and the stream arrives
// through the mocked `fetch`. That keeps the wiring under test — replay, live
// output, exit, resize debouncing, cwd switching, the 503 guidance — without a
// real DOM terminal or a live shell.
//
// The stream is read with `fetch`, not `EventSource`, and the test fakes an
// HTTP response for it: `EventSource` cannot see a response status, so a panel
// built on it could never learn that the server refused for want of a web
// password — the one failure this panel has to explain.
import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { TerminalPanel, splitSseFrames } = await jiti.import("./TerminalPanel.tsx");

const posts = [];
const streams = [];
const observers = [];

const encoder = new TextEncoder();

/** A 200 response whose body never ends until the panel cancels it. */
function fakeStream() {
  let controller = null;
  let closed = false;
  const body = new ReadableStream({
    start(c) { controller = c; },
    cancel() { closed = true; },
  });
  return {
    response: new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    get closed() { return closed; },
    /** Deliver one SSE frame the way the stream route writes it. */
    emit(payload) { controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)); },
    /** Deliver raw stream bytes, for frames the route does not write as-is. */
    raw(text) { controller.enqueue(encoder.encode(text)); },
    /** What the server does once a shell exits. */
    end() { closed = true; controller.close(); },
  };
}

class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback;
    observers.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() { this.disconnected = true; }
  trigger() { this.callback([], this); }
}

/** Minimal xterm stand-in: records what was written and the keystrokes it got. */
function termKit({ cols = 80, rows = 24 } = {}) {
  const written = [];
  const dataHandlers = [];
  const created = [];
  let proposed = { cols, rows };

  const Terminal = class {
    constructor(options) {
      this.options = options;
      this.cols = 80;
      this.rows = 24;
      created.push(this);
    }
    loadAddon() {}
    open() {}
    write(data) { written.push(data); }
    dispose() { this.disposed = true; }
    onData(cb) { dataHandlers.push(cb); return { dispose() {} }; }
    onResize() { return { dispose() {} }; }
  };
  const FitAddon = class {
    fit() {}
    proposeDimensions() { return proposed; }
  };

  return {
    written,
    created,
    type: (data) => { for (const cb of dataHandlers) cb(data); },
    resizeTo(next) { proposed = next; },
    loadTerminal: async () => ({ Terminal, FitAddon }),
  };
}

beforeEach(() => {
  posts.length = 0;
  streams.length = 0;
  observers.length = 0;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.ResizeObserver = FakeResizeObserver;
  globalThis.fetch = async (url, init) => {
    if (init?.method === "POST") {
      posts.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    const stream = fakeStream();
    streams.push({ url: String(url), source: stream });
    return stream.response;
  };
});

afterEach(cleanup);

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

test("an empty cwd shows the message instead of a dead terminal", async () => {
  render(React.createElement(TerminalPanel, { cwd: null, emptyMessage: "Pick a workspace first" }));
  assert.ok(screen.getByText("Pick a workspace first"));
  assert.equal(streams.length, 0, "no shell is opened for a workspace that does not exist");
});

test("opening the panel asks for the cwd's stream and never for a shell kill", async () => {
  const kit = termKit();
  render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();
  assert.equal(streams.length, 1, "one stream for the cwd");
  assert.match(streams[0].url, /\/api\/terminal\/stream\?cwd=%2Frepo/);
  assert.equal(posts.filter((p) => p.url.includes("/close")).length, 0,
    "opening a tab must not kill the shell it is about to use");
});

test("a replay frame and a later output frame are both delivered verbatim", async () => {
  // The replay frame carries scrollback from before this client connected, the
  // output frames what arrives after. Dropping either shows a shell that looks
  // half-alive after a reload — and a vacuous assertion here would pass against
  // a panel that dropped all three.
  const kit = termKit();
  render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();
  await act(async () => {
    streams[0].source.emit({ type: "replay", data: "welcome\r\n" });
    streams[0].source.emit({ type: "output", data: "$ " });
  });
  assert.deepEqual(kit.written, ["welcome\r\n", "$ "]);
});

test("the payload's type selects the frame, so an SSE event name cannot change it", async () => {
  // The frames are unnamed and the panel reads `type` from the payload. A server
  // that later started naming its events would make an EventSource client go
  // silent; here the name is ignored and the payload still decides.
  const kit = termKit();
  render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();
  await act(async () => {
    streams[0].source.raw('event: custom\ndata: {"type":"output","data":"$ "}\n\n');
  });
  assert.deepEqual(kit.written, ["$ "]);
});

test("an exit frame ends the shell instead of leaving a terminal that silently drops keys", async () => {
  // After `exit` the pty is gone and every later write is a server-side no-op, so
  // a panel that kept waiting would look alive and throw the user's keystrokes
  // away — the exact symptom the registry review called Critical.
  const kit = termKit();
  render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();
  await act(async () => { streams[0].source.emit({ type: "exit", data: "" }); });
  await settle();

  assert.ok(screen.getByText("The shell exited."), "the panel says the shell is gone");
  const before = posts.length;
  await act(async () => { kit.type("ls\r"); });
  assert.equal(posts.length, before, "a keystroke after exit is not posted to a shell that cannot receive it");
});

test("a stream that closes with no exit frame is reported, not waited on", async () => {
  // Idle reaping and a dropped connection both end the stream without an exit
  // frame. Nothing more will ever arrive, so the panel has to say so rather than
  // sit on a terminal that looks live and answers nothing.
  const kit = termKit();
  render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();
  await act(async () => { streams[0].source.end(); });
  await settle();
  assert.ok(screen.getByText("The terminal stream closed. The shell may have been reaped."));
  assert.ok(screen.getByRole("button", { name: "Start a new shell" }), "and offers a way back");
});

test("starting a new shell after an exit opens a new stream", async () => {
  const kit = termKit();
  render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();
  await act(async () => { streams[0].source.emit({ type: "exit", data: "" }); });
  await settle();

  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start a new shell" })); });
  await settle();
  assert.equal(streams.length, 2, "the restarted shell gets its own stream");
  assert.match(streams[1].url, /cwd=%2Frepo/);
});

test("changing cwd closes the old stream and opens a new one", async () => {
  const kit = termKit();
  const view = render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();
  const first = streams[0].source;
  await act(async () => { view.rerender(React.createElement(TerminalPanel, { cwd: "/other", loadTerminal: kit.loadTerminal })); });
  await settle();
  assert.equal(first.closed, true, "the old stream is closed, so its shell can be reaped");
  assert.equal(streams.length, 2, "a second stream for the new cwd");
  assert.match(streams[1].url, /cwd=%2Fother/);
});

test("a 503 tells the user to set a web password and is not retried", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: "no password", code: "terminal_auth_required" }), { status: 503 });
  };
  const kit = termKit();
  let authNotified = 0;
  render(React.createElement(TerminalPanel, {
    cwd: "/repo",
    authRequiredMessage: "Set OMP_WEB_PASSWORD",
    onAuthRequired: () => { authNotified += 1; },
    loadTerminal: kit.loadTerminal,
  }));
  await settle();
  assert.ok(screen.getByText("Set OMP_WEB_PASSWORD"));
  assert.equal(authNotified, 1, "the host is told once, so it can open the password prompt");
  assert.equal(calls, 1, "the answer will not change on a retry");
  assert.equal(kit.created[0].disposed, true, "the terminal that was built to measure the shell is disposed");
});

test("a late auth refusal releases the stream instead of watching a shell it cannot show", async () => {
  // The guard can start refusing mid-session (the server restarted without a
  // password). The guidance replaces the terminal, so the stream has to go with
  // it — otherwise the shell stays attached to a client that can no longer show it.
  const kit = termKit();
  const passthrough = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (init?.method === "POST") {
      return new Response(JSON.stringify({ error: "no password", code: "terminal_auth_required" }), { status: 503 });
    }
    return passthrough(url, init);
  };
  render(React.createElement(TerminalPanel, {
    cwd: "/repo",
    authRequiredMessage: "Set OMP_WEB_PASSWORD",
    loadTerminal: kit.loadTerminal,
  }));
  await settle();
  const source = streams[0].source;
  await act(async () => { kit.type("x"); });
  await settle();
  assert.ok(screen.getByText("Set OMP_WEB_PASSWORD"));
  assert.equal(source.closed, true, "the stream is released, so the shell can be reaped");
});

test("unmounting closes the stream but does not ask the server to kill the shell", async () => {
  const kit = termKit();
  const view = render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();
  const source = streams[0].source;
  view.unmount();
  await settle();
  assert.equal(source.closed, true, "the stream is closed");
  assert.equal(posts.filter((p) => p.url.includes("/close")).length, 0,
    "closing a tab detaches; only an explicit stop kills the shell");
  assert.equal(kit.created[0].disposed, true, "the xterm instance is disposed with the panel");
});

test("a keystroke posts the raw data and no size", async () => {
  // The input route reads cols/rows as a resize, so a keystroke that carried a
  // size would resize the shell on every character.
  const kit = termKit();
  render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();
  await act(async () => { kit.type("git status\r"); });
  const input = posts.filter((p) => p.url.includes("/api/terminal/input"));
  const keystroke = input.find((p) => p.body.data !== undefined);
  assert.deepEqual(keystroke.body, { cwd: "/repo", data: "git status\r" });
});

test("every resize carries cols and rows together, debounced to the final size", async () => {
  // Half a pair is a 400 `terminal_size_invalid`, and a window drag fires the
  // observer dozens of times, so the panel must send one complete pair per size.
  const kit = termKit();
  render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();
  const before = posts.length;

  await act(async () => {
    kit.resizeTo({ cols: 100, rows: 30 });
    observers[0].trigger();
    kit.resizeTo({ cols: 120, rows: 40 });
    observers[0].trigger();
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 250)); });

  const resizes = posts.slice(before);
  assert.equal(resizes.length, 1, "a drag posts once, not once per observer callback");
  assert.deepEqual(resizes[0].body, { cwd: "/repo", cols: 120, rows: 40 });
  assert.ok(posts.every((p) => p.body.data === undefined), "no keystroke was invented by a resize");
});

test("splitSseFrames delivers unnamed data frames and ignores the rest", () => {
  assert.deepEqual(splitSseFrames('data: {"type":"output","data":"a"}\n\n'), {
    frames: ['{"type":"output","data":"a"}'],
    rest: "",
  });
  // Heartbeats arrive as comments and carry no data.
  assert.deepEqual(splitSseFrames(':keepalive\n\n'), { frames: [], rest: "" });
  // A named event is not data; only `data:` lines are, joined per the SSE spec.
  assert.deepEqual(splitSseFrames('event: output\ndata: one\ndata: two\n\n'), {
    frames: ["one\ntwo"],
    rest: "",
  });
});

test("splitSseFrames carries a frame split across two chunks", () => {
  const first = splitSseFrames('data: {"type":"out');
  assert.deepEqual(first, { frames: [], rest: 'data: {"type":"out' });
  assert.deepEqual(splitSseFrames(first.rest + 'put","data":"x"}\n\n'), {
    frames: ['{"type":"output","data":"x"}'],
    rest: "",
  });
});