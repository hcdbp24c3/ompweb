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

/**
 * POSTs the *server* received, in the order it received them.
 *
 * Keystrokes reach the pty in that order and in no other, so a request order that
 * differs from the typed order is a scrambled command line. This is kept apart
 * from `posts` — the order the panel *issued* requests — because a panel that
 * fires a burst without waiting answers `fetch` before the next one is issued,
 * and those two orders are not the same thing.
 */
const arrivals = [];
/** Requests issued while held, waiting for the test to deliver them. */
const heldPosts = [];
let postsAreHeld = false;

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
    /** Deliver bytes verbatim, to cut a multi-byte character in half. */
    rawBytes(bytes) { controller.enqueue(Uint8Array.from(bytes)); },
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

/**
 * Minimal xterm stand-in: records what was written, the keystrokes it got, and
 * the geometry every `fit()` was called with.
 *
 * Both fit doubles are deliberately steerable, because the review that found the
 * resize defect also found why no test could see it: `fit()` was an empty no-op,
 * so "the resize path refits" was unfalsifiable — it passed against a panel that
 * never refitted. `proposeDimensions()` used to answer a scripted constant, so
 * the hidden-panel path was never exercised. The two answers the real addon gives
 * are both reproduced here: `undefined` for a 0×0 cell, and a *truthy*
 * `{cols: NaN, rows: NaN}` for a panel hidden with `display: none`, which
 * resolves every used length to `auto` and so parses to NaN.
 */
function termKit({ cols = 80, rows = 24 } = {}) {
  const written = [];
  const dataHandlers = [];
  const created = [];
  const fits = [];
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
    fit() { fits.push(proposed); }
    proposeDimensions() { return proposed; }
  };

  return {
    written,
    created,
    /** One entry per `fit()` call, holding the measurement it was fitted to. */
    fits,
    type: (data) => { for (const cb of dataHandlers) cb(data); },
    /** A panel the user cannot see: the right panel keeps visited views mounted
     *  and hides them with `display: none`, which is what produces the NaN pair. */
    hidden() { proposed = { cols: NaN, rows: NaN }; },
    /** A genuinely 0×0 cell, the addon's `undefined`. */
    collapsed() { proposed = undefined; },
    resizeTo(next) { proposed = next; },
    loadTerminal: async () => ({ Terminal, FitAddon }),
  };
}

const realGetComputedStyle = globalThis.getComputedStyle;

/**
 * jsdom answers "" for every custom property, so the panel's token path would
 * never run in a test — `xtermTheme()` would always be `{}` and every assertion
 * about it vacuous. Delegating to the real implementation keeps React and the DOM
 * working while only the named tokens are answered.
 */
function stubTokens(tokens) {
  globalThis.getComputedStyle = (element, pseudo) => {
    const styles = realGetComputedStyle(element, pseudo);
    return {
      getPropertyValue(name) {
        return Object.hasOwn(tokens, name) ? tokens[name] : styles.getPropertyValue(name);
      },
    };
  };
}

beforeEach(() => {
  globalThis.getComputedStyle = realGetComputedStyle;
  posts.length = 0;
  arrivals.length = 0;
  heldPosts.length = 0;
  postsAreHeld = false;
  streams.length = 0;
  observers.length = 0;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.ResizeObserver = FakeResizeObserver;
  globalThis.fetch = async (url, init) => {
    if (init?.method === "POST") {
      const request = { url: String(url), body: JSON.parse(init.body) };
      posts.push(request);
      if (!postsAreHeld) {
        arrivals.push(request);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Promise((resolve, reject) => {
        heldPosts.push({ ...request, resolve, reject });
      });
    }
    const stream = fakeStream();
    streams.push({ url: String(url), source: stream });
    return stream.response;
  };
});

afterEach(cleanup);

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

/** Past the panel's 150 ms resize debounce, with room to spare. */
const pastResizeDebounce = () => act(async () => { await new Promise((r) => setTimeout(r, 250)); });

/**
 * Stop POSTs answering themselves: each one waits for the test to deliver it.
 *
 * This is the half of the double that makes request ordering testable at all.
 * The original one resolved every POST synchronously, so with nothing to wait
 * for each request completed before the next was issued and the arrival order
 * was trivially the typed order — which is why a panel firing one unsynchronised
 * request per keystroke passed every test here and still scrambled the user's
 * typing in the browser.
 */
function holdPosts() {
  postsAreHeld = true;
}

/** Requests issued and not yet delivered — one per request actually in flight. */
const heldCount = () => heldPosts.length;

/** Drain React and the microtask queue, so a chained request can be issued. */
const drain = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/**
 * Deliver the newest held request first: the order that scrambles a burst the
 * panel did not serialise. One at a time, draining in between, so a panel that
 * waits for a response before sending its next keystroke has that request issued
 * — and so queued — before the next delivery, while a panel that fired the whole
 * burst at once has all of them waiting to be handed back reversed.
 *
 * `answer` decides each request's fate; the default is a 200.
 */
async function deliverHeldNewestFirst(answer) {
  while (heldPosts.length > 0) {
    const request = heldPosts.pop();
    arrivals.push(request);
    if (answer) {
      answer(request);
    } else {
      request.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }
    await drain();
  }
}

/** Deliver held requests in the order they were issued: nothing was scrambled. */
async function deliverHeldInIssuedOrder() {
  while (heldPosts.length > 0) {
    const request = heldPosts.shift();
    arrivals.push(request);
    request.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await drain();
  }
}

/**
 * Deliver each part as its own read, so a chunk boundary really falls between
 * them. Without the settle between parts a single reader could be handed both
 * enqueues at once and the test would prove nothing about threading.
 */
async function sendChunks(...parts) {
  for (const part of parts) {
    await act(async () => { streams[0].source.raw(part); });
    await settle();
  }
}

async function sendByteChunks(...parts) {
  for (const part of parts) {
    await act(async () => { streams[0].source.rawBytes(part); });
    await settle();
  }
}

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
  // The stop control exists, so "no kill on open" is a claim about a control that
  // really is on screen and not an assertion about nothing.
  assert.ok(screen.getByRole("button", { name: "Stop shell" }), "the stop control is always visible");
  assert.equal(posts.filter((p) => p.url.includes("/api/terminal/close")).length, 0,
    "opening a tab must not kill the shell it is about to use");
});

test("stopping the shell posts the cwd to /close once and reconnects", async () => {
  // Idle reaping cannot fire while the panel holds a listener, and the right panel
  // never unmounts a visited view — so without this control the only ways to end
  // a shell are a workspace change or a server restart.
  const kit = termKit();
  render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();
  const stop = screen.getByRole("button", { name: "Stop shell" });

  await act(async () => { fireEvent.click(stop); fireEvent.click(stop); });
  await settle();

  const stops = posts.filter((p) => p.url.includes("/api/terminal/close"));
  assert.equal(stops.length, 1, "a double click must not kill two shells or re-post");
  assert.deepEqual(stops[0].body, { cwd: "/repo" });
  assert.equal(streams.length, 2, "the panel reconnects instead of watching the shell it just killed");
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

test("a frame split across two chunks reaches the terminal intact", async () => {
  // The panel has to thread the parser's `rest` into the next read. A panel that
  // reset its buffer instead would silently drop every frame straddling a chunk
  // boundary — which any output longer than one TCP read produces — and the
  // symptom is shell output missing its middle, not an error.
  const kit = termKit();
  render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();

  await sendChunks('data: {"type":"out');
  assert.deepEqual(kit.written, [], "half a frame is not written out as a broken one");
  await sendChunks('put","data":"split"}\n\n');
  assert.deepEqual(kit.written, ["split"]);
});

test("a keepalive comment sharing a chunk with a real frame does not swallow it", async () => {
  // The route heartbeats every idle period, so a comment and a frame routinely
  // land in one read. Consuming the whole chunk as one frame would eat the frame.
  const kit = termKit();
  render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();

  await sendChunks(':keepalive\n\ndata: {"type":"output","data":"after"}\n\n');
  assert.deepEqual(kit.written, ["after"]);
});

test("CRLF and bare CR frame terminators are both accepted", async () => {
  // SSE allows CR, LF or CRLF. The route writes LF, but a proxy in front of it is
  // free to rewrite the endings, and a parser that only knows LF drops every frame
  // on such a connection — with no error, just a dead terminal.
  const kit = termKit();
  render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();

  await sendChunks('data: {"type":"output","data":"crlf"}\r\n\r\n');
  assert.deepEqual(kit.written, ["crlf"], "CRLF terminator");
  await sendChunks('data: {"type":"output","data":"cr"}\r\r');
  assert.deepEqual(kit.written, ["crlf", "cr"], "bare CR terminator");
});

test("a data line with no space after the colon keeps its whole payload", async () => {
  // Only one space is optional framing. Dropping a fixed six bytes instead would
  // take the payload's first character and the frame would parse as nothing.
  const kit = termKit();
  render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();

  await sendChunks('data:{"type":"output","data":"tight"}\n\n');
  assert.deepEqual(kit.written, ["tight"]);
});

test("a multi-byte character split across two chunks is not corrupted", async () => {
  // Output is chunked at byte boundaries, not character boundaries. Decoding each
  // chunk on its own turns a split `€` into U+FFFD, so the decoder has to be
  // streaming — the panel's buffer is already a string, so only `decode(value,
  // { stream: true })` keeps the half character back for the next chunk.
  const kit = termKit();
  render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();

  const frame = encoder.encode('data: {"type":"output","data":"€✓"}\n\n');
  const euroAt = frame.indexOf(0xe2);
  // € is 0xe2 0x82 0xac; cut between its second and third byte.
  await sendByteChunks(frame.slice(0, euroAt + 2), frame.slice(euroAt + 2));
  assert.deepEqual(kit.written, ["€✓"]);
});

test("xterm is given resolved token values, and an absent token leaves its key out", async () => {
  // xterm paints through canvas fillStyle and font strings, and neither resolves
  // `var(--token)`. A theme of literal `var(--bg-panel)` strings is an invalid
  // fillStyle, so the values have to come from the document — and a token the
  // document cannot answer has to be left out, not filled with the var() text.
  stubTokens({
    "--bg-panel": "#101010",
    "--text": "#f0f0f0",
    "--font-mono": "Fira Mono",
    "--text-sm": "14px",
  });
  const kit = termKit();
  render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();

  const options = kit.created[0].options;
  // `--accent` and `--bg-selected` are deliberately absent from the stub.
  assert.deepEqual(options.theme, { background: "#101010", foreground: "#f0f0f0" });
  assert.equal(options.fontFamily, "Fira Mono");
  assert.equal(options.fontSize, 14, "the size comes from the --text-sm token, not from a literal");
});

test("a token the document cannot answer leaves xterm's own default alone", async () => {
  // Setting a key to a value we could not resolve is worse than not setting it:
  // an explicit undefined fontSize overrides xterm's default with NaN, and then
  // every column measures wrong and the resize posts are all garbage.
  const kit = termKit();
  render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();

  const options = kit.created[0].options;
  assert.deepEqual(options.theme, {});
  assert.equal("fontFamily" in options, false);
  assert.equal("fontSize" in options, false);
});

test("a refused keystroke is shown in the error token, not as neutral text", async () => {
  // The banner carries three outcomes. Only a server refusal is an error; colouring
  // it like the "the shell exited" notice would leave the user with no way to tell
  // a dead server from a dead shell.
  const passthrough = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (init?.method === "POST") {
      return new Response(JSON.stringify({ error: "stream_write_failed" }), { status: 500 });
    }
    return passthrough(url, init);
  };
  const kit = termKit();
  render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();
  await act(async () => { kit.type("x"); });
  await settle();

  assert.equal(screen.getByRole("alert").textContent, "stream_write_failed");
  assert.equal(screen.getByRole("alert").style.color, "var(--status-error)");
});

test("an ended-shell notice stays neutral text", async () => {
  const kit = termKit();
  render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();
  await act(async () => { streams[0].source.emit({ type: "exit", data: "" }); });
  await settle();

  assert.equal(screen.getByRole("alert").style.color, "var(--text-muted)");
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
  // The banner is not the guard. Nothing is arriving any more, so a keystroke is
  // either typed into a shell this panel can no longer show or — because /input
  // *attaches* — into a fresh 80×24 one nobody is watching. A dropped connection
  // is the common way to get here, not a rare one.
  const before = posts.length;
  await act(async () => { kit.type("ls\r"); });
  assert.equal(posts.length, before, "a keystroke after the stream closed is not posted either");
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
  render(React.createElement(TerminalPanel, {
    cwd: "/repo",
    authRequiredMessage: "Set OMP_WEB_PASSWORD",
    loadTerminal: kit.loadTerminal,
  }));
  await settle();
  assert.ok(screen.getByText("Set OMP_WEB_PASSWORD"));
  assert.equal(calls, 1, "the answer will not change on a retry");
  assert.equal(kit.created[0].disposed, true, "the terminal that was built to measure the shell is disposed");
});

test("the auth guidance offers a retry, so it is not a dead end", async () => {
  // The refusal is about this server start, not about the user: the password may
  // already be set, or the panel may simply have been mounted while the guard was
  // mid-restart. A screen with no way back would leave the terminal unusable until
  // the whole page was reloaded.
  const passthrough = globalThis.fetch;
  let refused = true;
  globalThis.fetch = async (url, init) => {
    if (refused) {
      return new Response(JSON.stringify({ error: "no password", code: "terminal_auth_required" }), { status: 503 });
    }
    return passthrough(url, init);
  };
  const kit = termKit();
  render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();
  assert.ok(screen.getByText("The terminal requires a web password"));
  assert.equal(streams.length, 0, "the refused attempt opened no stream");
  // No stop control on this screen, deliberately: /close runs the same guard, so
  // it answers 503 here too and could not kill anything.
  assert.equal(screen.queryByRole("button", { name: "Stop shell" }), null);

  refused = false;
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
  await settle();
  assert.equal(streams.length, 1, "the retry reconnects instead of leaving the guidance up");
  assert.match(streams[0].url, /cwd=%2Frepo/);
});

test("the auth hint shows no literal backticks around the variable name", async () => {
  // The hint is rendered as a plain <div>, not as markdown, so the backticks that
  // mark up `OMP_WEB_PASSWORD` in the locale file reach the user as themselves.
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: "no password", code: "terminal_auth_required" }),
    { status: 503 },
  );
  const kit = termKit();
  render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();

  const hint = screen.getByText(/OMP_WEB_PASSWORD/);
  assert.ok(hint.textContent.includes("OMP_WEB_PASSWORD"));
  assert.equal(hint.textContent.includes("`"), false, "backticks are markup, and nothing here renders markup");
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
  assert.equal(observers[0].disconnected, true, "the resize observer is released with the stream");
  assert.equal(kit.created[0].disposed, true, "the terminal is disposed, not left on a host nobody can show");
});

test("unmounting closes the stream but does not ask the server to kill the shell", async () => {
  const kit = termKit();
  const view = render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();
  const source = streams[0].source;
  // The control that *does* post a stop request is on screen here, so the zero
  // below is a claim about this teardown path and not about the panel having no
  // way to reach the route at all.
  assert.ok(screen.getByRole("button", { name: "Stop shell" }));

  view.unmount();
  await settle();
  assert.equal(source.closed, true, "the stream is closed");
  assert.equal(posts.filter((p) => p.url.includes("/api/terminal/close")).length, 0,
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

/** Render a panel whose POSTs are held, so a test controls their arrival. */
function renderHeldPanel() {
  holdPosts();
  const kit = termKit();
  const view = render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  return { kit, view };
}

/** What reached the shell, as one string, however it was batched into requests. */
const received = () => arrivals
  .filter((r) => r.body.data !== undefined)
  .map((r) => r.body.data)
  .join("");

test("keystrokes reach the shell in the order they were typed", async () => {
  // The panel fired one POST per keystroke and never waited for it, so the bytes
  // reached the pty in whatever order those requests arrived. Measured in a real
  // browser: `stty size` typed 12ms apart ran as `tyst`, and it was corrupted in
  // the shell's echo as well as in its output — write order, not rendering.
  //
  // Delivering the requests newest-first is the order that scrambles an
  // unsynchronised burst, and the assertion is on the concatenation rather than
  // per request, so batching is allowed — arriving out of order is not.
  const { kit } = renderHeldPanel();
  await settle();

  await act(async () => { for (const key of "stty") kit.type(key); });
  await deliverHeldNewestFirst();

  assert.equal(received(), "stty", "the shell received the keystrokes as they were typed");
});

test("a burst is one request in flight, not one per character", async () => {
  // The ordering is the bug, but one unsynchronised request per character is also
  // what filled the in-flight window in the first place: holding a key down at
  // 30/s while each request is a fresh HTTP round trip to a Next route that
  // re-resolves the pty. Queueing the tail is what keeps that window at one.
  const { kit } = renderHeldPanel();
  await settle();

  await act(async () => { for (const key of "stty") kit.type(key); });
  assert.equal(heldCount(), 1, "the three later keystrokes are queued, not in flight");

  await deliverHeldNewestFirst();
  assert.deepEqual(arrivals.map((r) => r.body.data), ["s", "tty"], "queued keystrokes travel together, in order");
});

test("a paste is sent in one request rather than one per character", async () => {
  // xterm delivers a paste in a single onData, so this is already true for the
  // unfixed panel — the case it exists to pin is that coalescing a burst must not
  // turn one delivery into many.
  const { kit } = renderHeldPanel();
  await settle();

  await act(async () => { kit.type("ls -la /tmp\r"); });
  assert.equal(heldCount(), 1);
  await deliverHeldNewestFirst();
  assert.equal(posts.length, 1);
  assert.equal(received(), "ls -la /tmp\r");
});

test("a refused keystroke does not wedge the keyboard", async () => {
  // Serialising must not turn one failure into a dead keyboard: a 400, a 413 on an
  // oversized paste or a route that answers 500 would otherwise leave every later
  // keystroke queued behind a promise that has already rejected.
  const { kit } = renderHeldPanel();
  await settle();

  await act(async () => { kit.type("a"); });
  await deliverHeldNewestFirst((request) => request.resolve(
    new Response(JSON.stringify({ error: "stream_write_failed" }), { status: 500 }),
  ));
  assert.equal(screen.getByRole("alert").textContent, "stream_write_failed", "the failure is still reported");

  await act(async () => { kit.type("b"); });
  await deliverHeldInIssuedOrder();
  assert.equal(received(), "ab", "and the next keystroke still reaches the shell");
});

test("a dropped connection does not wedge the keyboard either", async () => {
  // A rejected fetch — the server restarting mid-command, a proxy cutting the
  // request — reaches the queue as a thrown error rather than a status.
  const { kit } = renderHeldPanel();
  await settle();

  await act(async () => { kit.type("a"); });
  await deliverHeldNewestFirst((request) => request.reject(new TypeError("Failed to fetch")));

  await act(async () => { kit.type("b"); });
  await deliverHeldInIssuedOrder();
  assert.equal(received(), "ab");
});

test("a resize cannot overtake the keystrokes queued in front of it", async () => {
  // /api/terminal/input applies data and a resize in one handler, and its own
  // comment says the two race each other on one stream. A resize issued outside
  // the queue can land between two keystrokes of one line and reflow it mid-type.
  const { kit } = renderHeldPanel();
  await settle();

  await act(async () => { kit.type("a"); });
  await act(async () => { kit.resizeTo({ cols: 120, rows: 40 }); observers[0].trigger(); });
  await pastResizeDebounce();
  assert.equal(heldCount(), 1, "the resize waits behind the keystroke in flight");

  await deliverHeldNewestFirst();
  const order = arrivals.map((r) => (r.body.data !== undefined ? r.body.data : `${r.body.cols}x${r.body.rows}`));
  assert.deepEqual(order, ["a", "120x40"]);
});

test("closing the panel drops queued keystrokes instead of writing them", async () => {
  // /input *attaches*, which spawns when the cwd is not live, so a queue that
  // flushed after teardown would resurrect a shell nobody is watching — into a
  // panel whose terminal has already been disposed.
  const { kit, view } = renderHeldPanel();
  await settle();

  await act(async () => { kit.type("x"); kit.type("y"); });
  assert.equal(heldCount(), 1);

  view.unmount();
  await deliverHeldNewestFirst();
  assert.equal(posts.length, 1, "the queued keystroke was dropped, not posted");
});

test("changing cwd drops the old cwd's queued keystrokes", async () => {
  // A cwd change tears the shell down and starts another one, so a queue left
  // running by the old shell would type into a session the user never chose.
  const { kit, view } = renderHeldPanel();
  await settle();

  await act(async () => { kit.type("x"); });
  await act(async () => {
    view.rerender(React.createElement(TerminalPanel, { cwd: "/other", loadTerminal: kit.loadTerminal }));
  });
  await deliverHeldNewestFirst();

  assert.deepEqual(
    posts.filter((p) => p.body.data !== undefined).map((p) => p.body),
    [{ cwd: "/repo", data: "x" }],
  );
});

test("every resize carries cols and rows together, debounced to the final size", async () => {
  // Half a pair is a 400 `terminal_size_invalid`, and a window drag fires the
  // observer dozens of times, so the panel must send one complete pair per size.
  const kit = termKit();
  render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();
  const before = posts.length;
  const fitted = kit.fits.length;

  await act(async () => {
    kit.resizeTo({ cols: 100, rows: 30 });
    observers[0].trigger();
    kit.resizeTo({ cols: 120, rows: 40 });
    observers[0].trigger();
  });
  await pastResizeDebounce();

  const resizes = posts.slice(before);
  assert.equal(resizes.length, 1, "a drag posts once, not once per observer callback");
  assert.deepEqual(resizes[0].body, { cwd: "/repo", cols: 120, rows: 40 });
  assert.ok(posts.every((p) => p.body.data === undefined), "no keystroke was invented by a resize");
  // The refit shares the debounce for the same reason: a fit redraws the whole
  // canvas, so one per observer callback is a redraw storm on every drag.
  assert.equal(kit.fits.length, fitted + 1, "a drag fits once, to the size it ends at");
  assert.deepEqual(kit.fits.at(-1), { cols: 120, rows: 40 });
});

test("a resize refits the terminal, so the view and the shell stay the same shape", async () => {
  // The panel fitted xterm once, at mount, and then only told the server the new
  // size — so the shell reflowed while the view kept the canvas it opened with.
  // The view is not just cosmetic: it is what covers the Stop-shell button. Below
  // about 950px of window height the screen overflowed the panel, `elementFromPoint`
  // at the button's centre returned `DIV.xterm-screen`, and a real click on the
  // only control that can kill a shell was intercepted.
  const kit = termKit();
  render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();
  assert.equal(kit.fits.length, 1, "the terminal is fitted once when it opens");
  const before = posts.length;

  await act(async () => { kit.resizeTo({ cols: 120, rows: 40 }); observers[0].trigger(); });
  await pastResizeDebounce();

  assert.equal(kit.fits.length, 2, "the resize path refits; without it the view never resizes");
  assert.deepEqual(kit.fits.at(-1), { cols: 120, rows: 40 }, "fitted to the size the shell is told");
  const resizes = posts.slice(before);
  assert.equal(resizes.length, 1);
  assert.deepEqual(resizes[0].body, { cwd: "/repo", cols: 120, rows: 40 });
});

test("a panel shown again after being hidden refits to its real size", async () => {
  // The right panel keeps every visited view mounted and hides it with
  // `display: none`, so switching to another tab and back is the same event the
  // window resize is: the host gets a box again and the observer fires. That
  // callback is the only thing that can put the view back in step.
  const kit = termKit();
  render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();
  const fitted = kit.fits.length;
  await act(async () => { kit.hidden(); observers[0].trigger(); });
  await pastResizeDebounce();
  assert.equal(kit.fits.length, fitted, "and nothing to fit while the panel has no box");

  await act(async () => { kit.resizeTo({ cols: 90, rows: 28 }); observers[0].trigger(); });
  await pastResizeDebounce();
  assert.equal(kit.fits.length, fitted + 1, "showing it again refits it");
  assert.deepEqual(kit.fits.at(-1), { cols: 90, rows: 28 });
});

test("a hidden panel posts nothing, instead of dimensions that serialize to null", async () => {
  // `display: none` resolves every used length to `auto`, `parseInt("auto")` is
  // NaN, `Math.max(2, NaN)` is still NaN, and the addon returns that pair anyway
  // because it is truthy — so the panel passed a check that a guard cannot make
  // and `JSON.stringify` turned it into `null`. Every switch away from a
  // mounted terminal cost a POST that came back 400 terminal_size_invalid.
  const kit = termKit();
  render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();
  const before = posts.length;
  const fitted = kit.fits.length;

  await act(async () => { kit.hidden(); observers[0].trigger(); });
  await pastResizeDebounce();

  // The request that used to be made, spelled out rather than left implicit.
  assert.equal(JSON.stringify({ cols: NaN, rows: NaN }), '{"cols":null,"rows":null}');
  assert.deepEqual(posts.slice(before), [], "a hidden panel has no size to post");
  assert.equal(kit.fits.length, fitted, "and fitting that pair would resize xterm itself to NaN");
});

test("a cell with no area is not a size either", async () => {
  // The addon's other answer is `undefined`, for a host that really is 0×0. A
  // panel that treated that as "nothing happened" is fine; a panel that treated
  // it as a reason to post would post nothing valid, and one that treated it as
  // a reason to fit would call fit() against no viewport at all.
  const kit = termKit();
  render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();
  const before = posts.length;
  const fitted = kit.fits.length;

  await act(async () => { kit.collapsed(); observers[0].trigger(); });
  await pastResizeDebounce();

  assert.deepEqual(posts.slice(before), []);
  assert.equal(kit.fits.length, fitted);
});

test("a panel that mounts hidden neither fits nor claims a size it cannot measure", async () => {
  // A cwd change while the user is on another tab remounts the panel hidden, so
  // this is a reachable mount state and not a corner case. Fitting here would
  // resize the new terminal to NaN, and `cols=NaN` in the query is a size the
  // server quietly replaces with its 80×24 default.
  const kit = termKit();
  kit.hidden();
  render(React.createElement(TerminalPanel, { cwd: "/repo", loadTerminal: kit.loadTerminal }));
  await settle();

  assert.equal(kit.fits.length, 0, "no fit against a viewport that cannot be measured");
  assert.equal(streams.length, 1, "the shell is still opened");
  assert.doesNotMatch(streams[0].url, /NaN|cols=|rows=/, "and the stream falls back to the server's own default");
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