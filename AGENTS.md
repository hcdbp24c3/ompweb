# omp-web - Development Notes

## Quick Start

```bash
npm run dev   # port 30178
```

Typecheck: `node_modules/.bin/tsc --noEmit`  
Lint: `npm run lint`  
**Never run `next build` during dev** — pollutes `.next/` and breaks `npm run dev`.

The dev server needs the `omp` binary installed (on `PATH`, or set `OMP_WEB_OMP_BIN`).
All live-agent features go through it; session browsing works without it.

---

## Architecture

omp-web never imports `@oh-my-pi/*` or `@earendil-works/*` packages (they are
Bun-only and cannot run inside Node/Next). See `DESIGN.md` for the full porting
contract.

```
Browser                Next.js Server                    omp child process
  │                        │                                    │
  ├─ GET /api/sessions ────▶ reads ~/.omp/agent/sessions/       │
  ├─ GET /api/sessions/[id] reads .jsonl file directly          │
  ├─ GET /api/agent/running/events ───▶ running id SSE          │
  │                        │                                    │
  ├─ send message ─────────▶ POST /api/agent/[id]               │
  │                        │   startRpcSession() ── spawn ─────▶│ omp --mode rpc-ui
  │                        │   sendCommand({type:"prompt"}) ───▶│ (NDJSON stdio)
  │                        │                                    │
  ├─ SSE connect ──────────▶ GET /api/agent/[id]/events         │
  │                        │   onFrame() ◀── event frames ──────│
  │◀── data: {...} ─────────│                                    │
```

**Session browsing** (read-only): pure-Node parsing of omp session `.jsonl`
files via `lib/session-reader.ts` — no child process involved.  
**Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` spawns
`omp --mode rpc-ui` (one process per active session) through
`lib/omp/rpc-process.ts`.

Shared foundations in `lib/omp/`:

- `paths.ts` — Node port of omp's directory resolution (`~/.omp/agent`,
  XDG, session dir slugs).
- `omp-cli.ts` — locate/probe the installed `omp` binary (`resolveOmpBin`,
  `getOmpVersion`).
- `rpc-process.ts` — process + NDJSON protocol layer (`RpcProcess`).

---

## File Map

```
app/api/
  sessions/route.ts               GET  list all sessions
  sessions/[id]/route.ts          GET/PATCH/DELETE session
  sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf
  sessions/[id]/export/route.ts   GET exported HTML for a session
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any RPC command
  agent/[id]/events/route.ts      GET SSE stream
  agent/running/events/route.ts   GET SSE stream of currently-running session ids
  auth/**                         provider list, login/logout, API keys (via RPC)
  cwd/validate/route.ts           POST validate/select a cwd
  default-cwd/route.ts            POST create ~/omp-cwd-YYYYMMDD
  files/[...path]/route.ts        GET file contents for viewer
  github-repo/route.ts            GET ?cwd= — GitHub owner/repo of the checkout (for #N links)
  home/route.ts                   GET user home directory
  models/route.ts                 GET { models, modelList, defaultModel }
  models-config/route.ts          GET/PUT — read/write ~/.omp/agent/models.yml
  models-config/test/route.ts     POST test a configured model/provider
  models-config/discover/route.ts POST discover a provider's model list (throwaway agent dir)
  omp-settings/route.ts           GET/PUT native config.yml settings (allow-listed)
  web-settings/route.ts           GET/PUT omp-web's own server settings (auto-resume)
  mcp/route.ts                    GET/POST/PUT/DELETE project MCP servers
  plugins/route.ts                GET/POST plugin management (shells out to `omp plugin`)
  projects/route.ts               GET registered+discovered projects | POST add | DELETE hide
  projects/clone/route.ts         POST clone a git URL into a new workspace (NDJSON progress) | DELETE cancel
  skills/route.ts                 GET/PATCH loaded skills and disable-model-invocation
  skills/install/route.ts         POST install skills through npx skills add
  skills/search/route.ts          GET/POST skills.sh search
  terminal/stream/route.ts        GET SSE out for a cwd's shell (replay/output/exit)
  terminal/input/route.ts         POST { cwd, data? } keystrokes | POST { cwd, cols, rows } resize
  terminal/close/route.ts         POST { cwd } kill the shell now
  worktrees/route.ts              GET/POST/DELETE git worktrees

lib/
  omp/                 shared omp foundations (paths, CLI probe, RpcProcess)
  agent-client.ts      typed fetch helper for /api/agent commands
  draft-store.ts       local draft persistence helpers
  file-access.ts       allowed file roots for /api/files and worktrees
  file-paths.ts        client/server path encoding helpers
  github-refs.ts       remark plugin linking #N / owner/repo#N + GithubRepoContext
  git-clone.ts         pure clone helpers: URL→directory name (https/ssh only), \r-aware progress log
  github-repo.ts       server: pick the gh-default GitHub remote from git config
  markdown.ts          shared markdown helpers
  npx.ts               npx runner used by skill install
  pi-types.ts          local structural types for agent/RPC objects
  project-ordering.ts  pure project sort/group/activity helpers (client + tests)
  project-registry.ts  on-disk managed-project registry (~/.omp/agent/projects.json)
  rpc-manager.ts       session registry + startRpcSession over RpcProcess
  session-reader.ts    session .jsonl parsing + path cache + buildSessionContext
  session-resume.ts    running-session list for auto-resume after a restart
  ssh-key-material.ts  mkdtemp'd 0o600 ssh key + GIT_SSH_COMMAND (BatchMode, accept-new)
  ssh-known-hosts.ts   owns the shared ~/.omp/agent/known_hosts path
  terminal/            PTY registry, cwd guard, browser-side input queue
  web-settings.ts      omp-web server settings (~/.omp/agent/omp-web-settings.json)
  skills-service.ts    pure-Node skill discovery mirroring omp's providers
  tool-presets.ts      PRESET_NONE/DEFAULT/FULL + getToolNamesForPreset()
  types.ts             shared TypeScript types
  normalize.ts         normalizeToolCalls() — field name mismatch between file format and our types
  word-prediction.ts   pure ghost-text arithmetic (advance/accept) for composer word prediction
  worktree.ts          project/worktree resolution and git worktree operations

components/
  AppShell.tsx        layout + URL state + tab management
  SessionSidebar.tsx  session tree + FileExplorer
  ChatWindow.tsx      chat composition + completion sound wrapper
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  ComposerPanels.tsx  composer-attached todo + subagent panels (collapsible, live states)
  TodoList.tsx        todo phase grid with preview/show-all (used by ComposerPanels)
  SubagentTranscriptDialog.tsx  task + final output summary dialog (wide, screen-adaptive)
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  CommandPalette.tsx  ⌘K/Ctrl+K palette (cmdk): session switch, new session, theme
  ImageLightbox.tsx   click-to-preview lightbox for chat images (ClickableImage)
  BranchNavigator.tsx in-session branch switcher
  ChatMinimap.tsx     scroll minimap alongside the message list
  MarkdownBody.tsx    markdown renderer
  ModelsConfig.tsx    modal for models/auth configuration
  McpConfig.tsx       project MCP server editor (Settings → MCP tab)
  PluginsConfig.tsx   modal for installed plugins
  SkillsConfig.tsx    modal for loaded/search/installable skills
  FileExplorer.tsx    file tree inside sidebar
  FileViewer.tsx      file content in a tab
  GhostMirror.tsx     textarea overlay painting ghost-text word completion
  TabBar.tsx          tab bar (Chat + open file tabs)
  TerminalPanel.tsx   xterm.js shell panel (pinned right-panel tab, SSE + POST)
  ui/                 shared primitives: Dialog/Tooltip/Collapsible, fields, toast

hooks/
  useAgentSession.ts       messages + streaming + SSE + fork/navigate/reconciliation logic
  useAudio.ts              completion sound + browser AudioContext unlock
  useDragDrop.ts           shared drag/drop state
  useIsMobile.ts           responsive breakpoint hook
  usePrefersReducedMotion.ts OS reduce-motion preference (SMIL-safe)
  useTheme.ts              theme state (localStorage key "omp-theme")
  useWordPrediction.ts     debounced omp predict_word ghost text + feedback
```

---

## Key Design Decisions & Traps

### RPC session lifecycle (`lib/rpc-manager.ts`)
- One wrapper per session id, keyed in a `globalThis` registry.
- `globalThis` survives Next.js hot-reload; plain module-level Map does not.
- Idle sessions are disposed after a timeout; concurrent `startRpcSession()`
  calls must share a single start promise.

### Auto-resume after a restart (`lib/session-resume.ts`)
- Off by default (`autoResumeSessions` in `omp-web-settings.json`). When on,
  `notifyRunningChange()` keeps `omp-web-interrupted-sessions.json` in the
  agent dir listing sessions that are mid-run; startup
  (`instrumentation.node.ts`) consumes it, restarts each session and sends
  `RESUME_PROMPT`.
- A service stop signals every process at once, so an omp child can die
  before omp-web's own SIGTERM handler runs. A session whose process died
  therefore stays listed for `EXIT_GRACE_MS`; the shutdown handler freezes the
  list (`markShuttingDown`) so those deaths count as interrupted, while a
  crash with omp-web still up is dropped after the window.
- Only session ids are stored; paths are re-resolved on resume.
- Known limit: resume does not detect a terminal `omp --resume <id>` started
  on the same session while omp-web was down; both would write the file.

### Two kinds of branching — don't confuse them
- **Fork** (Fork button on user message): creates a new independent `.jsonl` file. Shown as a child in the sidebar tree via `parentSession` header field.
- **In-session branch** (Continue button / BranchNavigator): navigates the entry tree within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

### ToolCall field normalization
Sessions store toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in both `session-reader.ts` (file load) and streaming event handling.

### Live tool execution (`tool_execution_start/update/end`)
omp announces a tool the moment it starts, streams the tool's output while it
runs, and only commits the `toolResult` message at the end. The UI must not
wait for that commit:
- `useAgentSession` keeps a `liveToolResults` map keyed by `toolCallId`
  (seeded on `tool_execution_start` with `partial: true`, refreshed on
  `tool_execution_update` — omp sends the FULL accumulated partial result per
  chunk, latest wins — and released on `_end`/the committed toolResult).
  Committed results always win over live entries (`ChatWindow` merges them), so
  a reload never shows a stale snapshot.
- `ToolCallBlock` renders a `partial` result as **running** (spinner, and
  "Running tool…" instead of the "(no output)" marker when nothing has been
  printed yet), and opens the row while it runs when the "Keep tool calls
  collapsed" setting is off — that is what that setting means. `AppShell` must
  pass `toolCallsDefaultCollapsed` into `ChatWindow`; without it the setting is
  inert (the chat then always collapses).
- `tool_execution_update` is coalesced per tool call at display rate in
  `lib/message-update-coalescer.ts` (chatty commands emit ~10-100+ frames/s).
  `message_end` drops the pending `message_update` (the committed message
  supersedes it) but must NOT drop buffered tool updates.
- Live entries are cleared on `agent_start`, terminal `agent_end`, prompt
  send/settlement failure — a tool must never leak into the next run.

### Event protocol differences vs pi
omp emits no `prompt_done` / `prompt_error` / `queue_update` /
`compaction_start` / `compaction_end` events. Completion is `agent_end`
(`isTerminal !== false`), errors surface as failed RPC responses plus `notice`
events, and the queue length comes from `get_state.queuedMessageCount`.
New frame types (`turn_start/end`, `notice`, `todo_reminder`, ...) must be
handled or safely ignored.

### Running state SSE + reconciliation
- The sidebar listens to `/api/agent/running/events`, backed by `subscribeRunningSessions()` in `lib/rpc-manager.ts`, so running badges update without polling.
- `useAgentSession` still treats per-session SSE as primary for chat events, but while a run is active it periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed `agent_end` events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.

### Composer-attached panels (`components/ComposerPanels.tsx`)
- The live todo plan (`TodoList`) and the subagent roster live **pinned above
  the chat input**, not inside the scrollable message list. `ComposerPanels`
  renders both, each independently collapsible via its header row (`chevron`);
  panels start collapsed (headers always show live progress / running-summary).
  Subagent chips carry live state (pulsing dot while `started`, check/alert/ban
  for terminal states) fed by the same `subagent_lifecycle`/`subagent_progress`
  SSE frames; clicking a chip opens the transcript dialog. `TodoList` keeps a
  non-collapsible default (`collapsible` prop) for SSR tests.

### Subagent integration (`lib/subagent-types.ts`, `lib/subagent-history.ts`)
- **Live detail**: `subagent_progress` frames carry the full `AgentProgress`
  object — `lib/subagent-types.ts` parses it defensively into
  `SubagentInfo.progress` (current tool/intent, tokens, cost, context
  gauge, resolved model, retry state, detached flag, agentSource). The
  composer chips surface the current activity + telemetry line; retry
  (`⟳ retrying N/M`) takes precedence over the tool line. `subagent_event`
  frames also feed a bounded per-subagent activity buffer shown in the
  transcript dialog.
- **Roster hydration**: `get_subagents` snapshots (which carry progress)
  rehydrate the roster after SSE reconnect (`refreshSubagentRoster`, wired
  into mount, send, and the reconcile poll). Terminal subagents vanish from
  the RPC registry — history fills that gap.
- **On-disk history** (`lib/subagent-history.ts`, `/api/sessions/[id]/subagents*`):
  omp persists each subagent's transcript to the parent session's sibling
  artifacts dir (`<session-dir>/<subagent-id>.jsonl`) and the parent file's
  task toolResults keep `progress[]`/`results[]` snapshots. omp-web recovers
  the roster from disk (`extractSubagentHistory`, result fields win over the
  mid-run snapshot), so past/finished runs show in the composer panel after a
  reload. The transcript route pages the sibling file byte-wise (mirroring
  `get_subagent_messages`, which is RPC-registry-gated and refuses files it
  doesn't know). The dialog reads only the final output — `<id>.md` via
  `?mode=completion` (bounded tail read that also works for transcripts
  beyond the 16MB paging cap) with a live `get_subagents` snapshot fallback
  for header enrichment; it never pages the raw transcript. Subagent ids are
  `[A-Za-z0-9_-]{1,80}` — the route validates before joining to confine reads
  to the sibling dir.
- **`agent://` links** (`lib/agent-links.ts`): `MarkdownBody` linkifies bare
  handles and inline code that is exactly a handle (remark plugin), keeps the
  `agent:` protocol through rehype-sanitize and `urlTransform`, and opens
  the handle through `AgentLinkContext`, which `ChatWindow` provides with
  `agentLinkTarget` (dotted nested id first, then the base id; unknown ids
  open a disk-backed stub). Without a provider the handle renders as plain
  text. The plugin runs after `remarkGithubRefs` (so `agent://Foo#12` is not an
  issue link) and never links omp's write-only `agent://all`. Because the
  shared sanitizer admits `agent:`, every `ReactMarkdown` host must drop
  rejected hrefs (`defaultUrlTransform(url) || undefined`) — a blank `href=""`
  links to omp-web itself; `FileViewer` does this.
  Tool rows (`ToolCallBlock` in `MessageView`) open an `agent://` `path`
  through the same context.
- **In-message task summary** (`components/MessageView.tsx` TaskResultPanel):
  the session reader allowlists a SIZE-BOUNDED subset of `task` toolResult
  details (telemetry only — no `output`/`stderr`, long text truncated to
  240 chars, `lib/session-reader.ts` `keepTaskToolResultDetails`), and
  expanded `task` tool calls render a per-subagent summary (status, agent,
  task, tokens/cost/duration/model, async marker) above the raw result text.
- **Chip extras**: agent-source labels (`user`/`project`), nested-subagent
  count (`inflightTaskDetails`/`extractedToolData.task` progress), and the
  `⤴` async marker (live `detached` flag or history `details.async`
  presence). Shared formatters live in `lib/subagent-format.ts`.

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so all worktrees for one repo are grouped together in the sidebar.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.

### Managed projects sidebar (`lib/project-registry.ts`, `/api/projects`)
- The sidebar lists **managed projects**: explicitly added directories (registered in
  `~/.omp/agent/projects.json`, written atomically as temp-file + rename) plus
  session-discovered ones — hidden entries excluded. Removing a project only
  marks it hidden (reversible via re-adding); hidden entries suppress session
  re-discovery.
- Registry paths are canonical `projectRoot`s: `POST` resolves worktrees to
  their main repo via `resolveProject`, and `resolveProject` returns the
  symlink-free on-disk form for plain directories so registered and
  session-discovered paths compare equal on Windows casing.
- `GET /api/projects` re-authorizes registered roots with `allowFileRoot()` —
  the in-memory browse allowlist does not survive restarts, and empty managed
  projects derive no root from sessions.
- The client sorts the merged list by most-recently-added (registration
  order), then by path for session-discovered projects
  (`lib/project-ordering.ts`); the order deliberately does NOT depend on
  session activity, so project rows never jump around while sessions refresh.
  Expanded project paths live
  in `localStorage` (`omp-web:expanded-projects`), defaulting to only the
  active/restored project expanded, and stale keys are pruned against the
  current project list (only after the first project fetch — an empty
  still-loading list must never wipe storage).
- Each project's session tree is capped at 5 roots with a show-more toggle;
  project rows are cards matching the session items' height/margins/accent
  treatment, and the active project's worktree selector renders directly
  below its row.

### Clone a repository as a new workspace (`/api/projects/clone`)
- The Add-workspace `DirectoryPicker` takes an optional Git URL; "Clone here"
  clones into `<selected dir>/<repo name>`, then registers that directory
  through the normal `POST /api/projects` path.
- Only `https://`, `ssh://` and scp-like `user@host:path` URLs are accepted
  (`cloneDirectoryName`, and `isSupportedGitUrl` for anything that decides where
  a token may be sent); git also runs with `GIT_ALLOW_PROTOCOL=https:ssh`,
  `GIT_TERMINAL_PROMPT=0` and empty `GIT_ASKPASS`/`SSH_ASKPASS`, so a clone
  fails fast rather than blocking on a prompt. A stored credential answers that
  prompt through `GIT_CONFIG_*` instead — see "Named git credentials" below.
- The POST streams NDJSON (`output` chunks, then one of `done` / `cancelled` /
  `error`). Cancel is `DELETE { id }`: the POST stream stays open until the
  partial clone is deleted, so the UI can confirm the cleanup. A client
  disconnect cancels and cleans up too. An existing target is refused (409).

### Named git credentials (`lib/git-credentials.ts`, `lib/git-credential-resolve.ts`)
- The store holds named PAT/SSH records; `loadGitCredentials()` decrypts and is
  **server-only**. Which record a remote gets is decided by
  `resolveCredential({ url, cwd, credentials })`: host+owner (the remote's owner
  equals the record's `account`) → `isDefaultForHost` → the host's only record →
  an `AmbiguousGitCredentialError` naming the candidates. **Never array order and
  never a usage counter** — re-saving a record would change the identity a clone
  runs as. The clone route turns that error into a 400 *before* `mkdir`, so an
  undecidable store never leaves a directory behind.
- **Candidacy is transport-aware.** An `ssh` record is not a candidate for an
  `https://` remote and a PAT is not a candidate for an `ssh://` one — not
  "weaker candidates", not candidates at all. `parseRemote()` reports
  `transport`, `ResolvedGitCredential` carries it, and `isDeliverable()` answers
  both "which type can authenticate this transport" and "which of its secrets is
  the one that does". A record whose secret cannot be decrypted (`hasToken: true`,
  `token: undefined`) is never a candidate either, and must not manufacture an
  ambiguity. Keep the two questions separate: collapsing them makes the type guard
  dead code that no test can see.
- Delivery goes through **one** entry point, `prepareGitCredential(resolved,
  { signal })`, which returns `{ env, dispose }` — not a plain env object,
  because the ssh branch writes a key to disk. `dispose()` is idempotent and
  `signal` makes removal abort-safe (see "SSH key materialization" below).
  `lib/skill-updates.ts` uses the same call; its URL is https by construction, so
  it disposes unconditionally rather than branching.
- For https, delivery is `GIT_CONFIG_COUNT` + `GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0`
  carrying `http.https://<host>.extraheader` = `AUTHORIZATION: basic
  base64(user:token)`, merged into `hostChildEnv()` overrides. **Env, never argv
  and never the remote URL** — a URL token lands in `.git/config`, in `ps`, and
  in every error message. Exactly **one** header per child: git applies
  extraheader unconditionally, so two for one host means two `Authorization`
  headers and the server picks.
- **No askpass helper exists**, so nothing has to be copied into the image; the
  empties above stay empty and the credential means git never has to ask. If one
  is ever added it must be named through `OMP_GIT_ASKPASS*` and never
  `OMP_WEB_*` — `hostChildEnv()` deletes that whole prefix before the child sees
  it (the `GIT_CONFIG_*` names survive it, which the tests pin).
- `cwd` is optional and means "the repository this belongs to":
  `resolveProject()` maps a linked worktree back to its main root first (a
  worktree is a *sibling* directory, so keying on the worktree path would never
  find the repository). `lib/skill-updates.ts` has only a URL — it must never
  invent a directory.
- Some environments (this dev container among them) inject their own
  `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` **and their own `GIT_SSH_COMMAND`**;
  `hostChildEnv()` keeps all of them. That is why the route and skill-updates
  tests clear the ambient ones before asserting "nothing was added" — otherwise
  the assertion passes for somebody else's value. An inherited `GIT_SSH_COMMAND`
  is deliberately *not* deleted when there is no credential (it is the operator's
  own configuration), but ours **replaces** it wholesale when there is one, so an
  inherited `StrictHostKeyChecking=no` cannot survive into a clone we authenticate.

### SSH key materialization and host keys (`lib/ssh-key-material.ts`, `lib/ssh-known-hosts.ts`)
- A private key reaches `ssh -i` as a **file**, so one is staged per operation:
  `mkdtemp` under the system tmpdir (never a fixed name — a predictable path in a
  shared tmpdir is a symlink-attack surface), directory `0o700`, key `0o600`,
  both stated explicitly rather than left to umask. It is **never** written under
  `getAgentDir()`: that directory is the persisted volume, so a plaintext key
  there outlives the request and survives a container recreate.
- Removal is **abort-safe, not just `finally`-safe**. The clone route cancels
  through an `AbortController` and signals the whole process group, so the child's
  `close` can arrive long after a `finally` around it has run — or never, if a
  grandchild still holds the output pipes. `prepareGitCredential` takes the signal
  and disposes on abort; the route *also* disposes in a `finally`, and on the
  pre-stream 409 path, where there is no stream at all. Both are load-bearing.
- `GIT_SSH_COMMAND` is built in `buildGitSshCommand()` and carries
  `-i <key>`, `-o IdentitiesOnly=yes`, `-o PasswordAuthentication=no`,
  **`-o BatchMode=yes`**, `-o StrictHostKeyChecking=accept-new`,
  `-o UserKnownHostsFile=<shared path>` and `-T`.
- **`BatchMode=yes` is the flag that prevents a hang**, not
  `PasswordAuthentication=no`. Measured: with a passphrase-protected key and no
  `BatchMode`, `ssh` sits on the passphrase prompt until killed (a `script`-driven
  run hit an 8s timeout with exit 124); with it, `ssh` fails immediately with
  `Permission denied (publickey)` and no prompt. The route's `stdio: ["ignore"]`
  + `detached: true` is a second line of defence, not the guarantee.
- **A passphrase-protected key is rejected, not supplied.** `sshpass` would add an
  image dependency and put the passphrase in the child env next to the git
  credential; an askpass helper is the helper task 09 deliberately avoided. A key
  that needs a passphrase therefore fails fast instead of being waited on.
  Detection is *not* attempted — that would duplicate ssh's own private-key parser.
- **`known_hosts` lives in `getAgentDir()` and is shared, and
  `lib/ssh-known-hosts.ts` owns the path.** It holds public host keys only, so it
  is safe on the persisted volume. It has to survive between clones: a per-clone
  temp file (or `/dev/null`) makes every clone a fresh first-time trust and
  removes the ability to detect a change. `ensureKnownHostsFile()` opens it
  **append-only** (truncating would drop every host the user has verified) and
  `chmod`s it `0o600` on every call, because OpenSSH ignores a group/world-writable
  known_hosts outright — a file restored from a backup with loose permissions
  would otherwise fail every clone with "Bad owner or permissions".
- **One design, no prompt: `accept-new`, no interaction channel.** The clone POST
  is a one-way NDJSON stream with no round trip and there is no UI surface, so
  there is nobody to ask. `accept-new` is strictly *safer* than the reference
  product, not differently unsafe: that one probes with `ssh-keyscan`, asks the
  browser, and hard-codes `isKeyChanged: false`, so a changed key arrives as an
  ordinary first-time prompt with no comparison at all. Measured against a real
  OpenSSH client and a real sshd: a first-seen host is recorded; the same key is
  not re-added; a changed key **fails** (`REMOTE HOST IDENTIFICATION HAS CHANGED`,
  known_hosts untouched); an op with no usable identity fails in ~1s with
  `Permission denied (publickey)`.
- **Those measurements are not in the suite.** They need a real sshd, which the
  test image does not have (no `openssh-server`, and the container has no dpkg
  database), so they were taken with a paramiko harness outside the repo. What the
  suite *does* pin is every input that decides the behaviour: `accept-new` present
  and `no`/`off`/`yes`/`/dev/null` absent, the path being the shared one, the
  file persistent and append-only, and the modes. That is the set of ways the
  guarantee could be lost in this repo.

### File access allow-list
- `/api/files` is intentionally not a general filesystem browser. Allowed roots come from session cwds, their resolved project roots, `~/omp-cwd-*`, and roots explicitly added with `allowFileRoot()`.
- `/api/cwd/validate`, `/api/default-cwd`, and `/api/worktrees` call `allowFileRoot()` when they make a new location browsable.

### In-browser terminal (`lib/terminal/`, `/api/terminal/*`, `components/TerminalPanel.tsx`)
- Transport is SSE out (`/api/terminal/stream`) plus POST in
  (`/api/terminal/input`, `/api/terminal/close`). No WebSocket: `bin/omp-web.js`
  runs plain `next start`, so nothing handles an HTTP `Upgrade`.
- **Never POST a keystroke outside `lib/terminal/input-queue.ts`.** The queue
  holds one request in flight and coalesces the tail into it, because the input
  route writes `data` into the pty as each request *arrives*: one un-awaited
  `fetch` per character delivered them in completion order, measured as
  `stty size` typed at speed running as `tyst`.
- **Teardown drops the queue rather than flushing it**, because the input route
  *attaches* — it spawns a shell for a cwd that is not live, so a flush would
  leave one running that nothing is watching.
- **A keystroke must not outlive the stream.** `onData` refuses to post once
  `shellEnded` is set, and every *clean* end of the stream sets it: the `exit`
  frame, and a read loop that returns. A banner is not the guard. Known limit: a
  mid-stream read that *throws* (a dropped socket, `reader.read()` rejecting)
  reaches the `error` banner with the queue still live — fix that with the same
  flag, never by refusing on `error` as a whole, because one refused request also
  sets `error` and the keyboard has to keep working.
- **The cwd allowlist is a starting-directory restriction, not a jail.**
  `guardTerminalCwd` bounds where a shell may *start*; a login shell can `cd`
  anywhere. Do not "fix" this with namespaces or containers.
- `lib/terminal/guard.ts` is not the authentication check — `proxy.ts` owns the
  401 — and the two must not be collapsed into one or trusted separately. The
  guard's own rule is that an instance with no web password gets no shell at all.
- The registry is keyed on cwd, so **two tabs on the same cwd share one shell**
  and their keystrokes interleave: watching is multi-tab, typing is not. It lives
  on a `globalThis` slot for the reason `lib/rpc-manager.ts` does — a module-level
  `Map` is emptied by a hot reload, orphaning every running shell — and idle
  reaping only re-arms once the last listener is released.
- Frames are **unnamed** SSE messages whose payload carries `type` (`replay` /
  `output` / `exit`); naming them would silence an `EventSource` client. The panel
  reads the stream with `fetch`, not `EventSource`, because only `fetch` can see
  the 503 that says a web password is missing. A resize must send `cols` and
  `rows` together — half a pair is a `400 terminal_size_invalid`.
- `package.json` pins `node-gyp` in `overrides` on purpose: `node-pty` ships no
  linux prebuild, so npm compiles it on every install, and its install script
  invokes the bare name `node-gyp`, which npm resolves through
  `node_modules/.bin` — where a transitive dependency had hoisted node-gyp 7. A
  global install loses to that directory, `--ignore-scripts` skips the build
  entirely, and `npm_config_node_gyp` cannot reach a literal command name.

### Session list caching — new sessions must appear immediately
- `listAllSessions()` (sidebar, command palette) is cached twice: a 30s TTL
  list cache in `lib/session-reader.ts` plus an mtime-keyed directory walk in
  `lib/omp/session-files.ts` (`listSessionFiles`).
- The walk cache keys on the **sessions root** mtime. On Windows/NTFS a new
  `.jsonl` inside an existing project subdirectory does NOT bump the root
  mtime, so the walk stays stale indefinitely.
- `invalidateSessionListCache()` (fired on `agent_end`, `session_info_update`,
  compaction, renames) must therefore ALSO clear the walk cache via
  `invalidateSessionFileListCache()` — never add a session-mutation path that
  forgets this. Regression test: `session-reader.test.mjs`.

### Chat scroll-follow
- `useAgentSession` follows the conversation: the effect depends on both
  `messages` (boundaries) and `streamState` (every token batch) and throttles
  to one `requestAnimationFrame` while a run is active (`followScrollFrameRef`).
- A manual scroll-up sets `completionScrollAllowedRef = false` and disables
  following until the next prompt; `scrollUserMsgToTop` handles the
  pending-scroll after sending.
- Programmatic smooth scrolling must respect `prefers-reduced-motion`
  (`usePrefersReducedMotion` in `hooks/usePrefersReducedMotion.ts` — also the
  only way to stop SVG SMIL animations, which CSS cannot).

### MCP configuration (`lib/omp/mcp-config.ts`, `/api/mcp`, `components/McpConfig.tsx`)
- Project MCP config resolution order: `.omp/mcp.json`, `.omp/.mcp.json`,
  `mcp.json`, `.mcp.json` at the git top level (falls back to cwd for
  non-git dirs). Server definitions support `stdio`, `http`, and `sse`;
  exactly one of `command`/`url` is required and validated before any write.
- Writes are atomic (temp file + rename), preserve unrelated top-level keys
  (`disabledServers`, `$schema`, ...), and support rename via `previousName`.
- The MCP settings live in their own Settings tab (`SettingsTabs` id `"mcp"`,
  workspace-gated). Server list rows show a config-derived status dot
  (valid+enabled / disabled / invalid) — no live-connectivity probe exists in
  the RPC protocol, so failures surface as toasts (`toast.error`) from the
  editor actions, not inline text.
- The endpoint is guarded by the same allowed-root rules as `/api/files`.

### Plugins and skills
- `/api/plugins` shells out to the user's `omp plugin` CLI (`list/install/uninstall/enable/disable/upgrade`, `--json` where available) — never the Bun-only SDK.
- `/api/skills` uses `lib/skills-service.ts`, a pure-Node scanner mirroring omp's discovery order: project `.omp/skills` (walk-up), `~/.omp/agent/skills`, then the `.claude` / `.agent(s)` / `.codex` / `.github` compat dirs and managed skills.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent universal`, which installs into the ecosystem-standard `.agents/skills` dirs omp reads; project installs run with the selected cwd.

### Update notifications (`/api/omp-update`, `/api/app-update`)
- Automatic in-app self-updating has been removed in favor of explicit user notifications and manual terminal commands.
- `GET /api/app-update` queries the npm registry for `@kahme247/ompweb` updates, detects the install manager (`bun` vs `npm` via `detectInstallMethod`), and returns `updateAvailable` plus the exact terminal command (e.g. `npm install -g @kahme247/ompweb` or `bun add -g @kahme247/ompweb`).
- `POST /api/omp-update` (`action: "check"`) runs `omp update --check` and returns `updateAvailable` plus `updateCommand: "omp update"`.
- `POST /api/omp-update` (`action: "restart"`) restarts active OMP sessions after a manual CLI update.
- Notifications in `AppShell` and settings cards in `SettingsConfig` present the update notification alongside copyable terminal update commands.

### Auth and model config
- Auth flows go through RPC commands (`get_login_providers`, `login`) against the omp child process; credentials live in omp's `agent.db` (SQLite) which omp-web never touches directly.
- The Models panel reads and writes `models.yml` in the omp agent directory (`~/.omp/agent/models.yml`, `.yaml` fallback).
- API-key status endpoints must never return the raw key.

#### Utility processes must be forced to boot a model (`lib/omp/rpc-utility.ts`)
- omp `process.exit(1)`s when it resolves **zero** models, and that check runs
  *before* the `mode === "rpc"` branch (coding-agent `main.ts:2425`), so the
  child dies before printing its `ready` frame and **no command is ever
  answered**. On a fresh install that made the provider list unreachable: every
  provider-list route (`/api/auth/providers`, `/api/auth/all-providers`) shares
  the one `runUtilityCommand` process, so you could not open the UI that adds
  your first model. Not a transport bug — the process is already gone, it has to
  boot.
- `withBootModelFallback` tries **no selector first** (so a user who already has
  a model gets byte-identical behaviour), then each `BOOT_MODEL_CANDIDATES` id
  in order, stopping at the first success. `isNoModelBootFailure` gates the
  retry on omp's own wording (`No models available` / `Model "…" not found`) so
  a missing binary or a timeout is rethrown untouched; when every candidate is
  rejected the last omp error surfaces verbatim.
- **Only the `--no-session` utility process is forced.** `lib/rpc-manager.ts`
  (real sessions) must keep the model the user picked — passing a selector there
  would break model switching.
- The candidate list is measured, not guessed: the first id resolves on the
  installed catalog, the rest are fallbacks for a future catalog that drops it.
  Ids that do not exist (`openai-codex/gpt-5-codex`) are deliberately excluded,
  and a test pins that.
- `runIsolatedUtilityCommand` (used by `/api/models-config/test` and
  `/api/models-config/discover`) deliberately does **not** retry. A
  discovery-only provider resolves its own model so the guard never fires there,
  and a command *response* may legitimately contain "No models available" text —
  retrying after the send would respawn against a healthy process. Separating
  boot from send would touch the abort/dispose lifecycle; don't do it casually.

#### Model discovery (`/api/models-config/discover`)
- `get_available_models` returns catalog **and** discovered models, so the
  provider editor's "Discover models" button is a plain RPC call. There is no
  discovery-refresh RPC command, and omp-web must not shell out to
  `omp models refresh`, which refreshes the whole catalog instead of one
  provider.
- The route writes the provider under test to a **throwaway `mkdtemp` agent
  dir** with `OMP_PROFILE`/`PI_PROFILE`/`XDG_DATA_HOME` cleared, so the real
  `~/.omp` is never touched. The cost of that isolation is that the child has no
  stored credentials and no cached catalog: a provider whose key lives in omp's
  `agent.db` cannot authenticate here, so discovery needs a `baseUrl` reachable
  without auth (or a key in the environment). Same limitation as
  `/api/models-config/test`.
- omp caches per-provider discovery results in `<agent-dir>/models.db` (a
  `model_cache` table keyed by provider id; default `cacheTtlMs` is 2h in
  18.4.6, revalidated by a `static_fingerprint` — **not** by the models.yml
  mtime). A throwaway agent dir therefore always starts cold, which is exactly
  what keeps the route cheap and side-effect-free.

#### The editor renders only part of the schema — and that is load-bearing
- Editable today: provider `baseUrl`/`api`/`apiKey`/`auth`/`headers`/
  `discovery{type,timeoutMs,injectV1}`/`authHeader`/`disableStrictTools`, and
  model `id`/`name`/`api`/`baseUrl`/`reasoning`/`input`/`contextWindow`/
  `maxContextWindow`/`maxTokens`/`omitMaxOutputTokens`/`tokenizer`/
  `supportsTools`/`premiumMultiplier`/`cost`/
  `thinking{mode,efforts,defaultLevel}`. `authHeader` only appears with an
  `apiKey` and `disableStrictTools` only for `api: anthropic-messages`, and both
  are cleared when the precondition goes away.
- Still round-trip-only (no control — editable in the YAML by hand only):
  `compat`, model-level `headers`, `modelOverrides`, `remoteCompaction`,
  `guardrail*`, `transport`, `requestMetadata`, `promptCache`,
  `preferWebsockets`, `imageInputDecoder`, `contextPromotionTarget`,
  `compactionModel`. They survive on the `[key: string]: unknown` index
  signature, **not** because anything writes them.
- A field survives a write only if it is in the payload the client sends:
  `mergeNode` deletes every map key absent from the value it merges
  (`lib/omp/models-config.ts`). So **adding a type without a control is data loss
  waiting to happen** — the field dies the first time anything rebuilds that
  object. Either add both, or state explicitly that the field is not editable
  from the UI.
- **An editable list of known enum values is not a schema.** `models.yml` is
  hand-written, so any list copied from omp's catalog can be incomplete:
  `DISCOVERY_TYPES` holds 7 values (the docs list 6) and `API_OPTIONS` 11. Both
  data-loss bugs in this editor came from treating such a list as the full value
  set. The pattern is "known values first, then union with whatever the file
  declares" — `thinkingRows` / `orderedThinkingEfforts` in
  `ModelsConfig-types.ts` are the reference (and `authRows` is that pattern
  applied to `auth`). Reuse it for every new enum.
- **Every model surface must show the `id`, not just the `name`.** A display
  name is not an identifier (two models of one provider may share it) and
  `filterModelOptions` already matches name, modelId *and* provider
  (`ChatInput-model-options.ts`), so a name-only surface searches fine and
  still leaves the user unable to tell two rows apart. Use `modelLabel` /
  `modelIdSuffix` (`ModelsConfig-types.ts`) rather than inlining `name || id`;
  `modelIdSuffix` returns null when the id would just repeat the name, because
  omp ships `name === id` for custom providers.
- **A `thinking.defaultLevel` must never name an effort that is not enabled.**
  omp's `clampThinkingLevelForModel` silently snaps such a level down to the
  nearest one it knows (`defaultLevel: max` over `efforts: [low, high]` runs as
  `high`, no warning), so a value that quietly disagrees with itself is worse
  than no value. Server validation does not check the pair, so the editor has
  to: disabling the level the default names drops the default too
  (`toast.info(modelsConfig.defaultLevelCleared)`), and wiping the whole
  thinking block drops it just as silently.
- **omp cannot report "discovery found nothing" — omp-web must interpret it.**
  A provider that declares `discovery` but resolves no models dies in the same
  "No models available" guard as a provider with no model at all, so the route
  re-reads the failure through the shared `isNoModelBootFailure`
  (`lib/omp/rpc-utility.ts`) and answers `200 { models: [], reason:
  "discovery_returned_nothing" }` instead of a 500. Only reuse the shared
  matcher — do not add a second regex here.
- **`auth: "oauth"` is not a keyless mode.** omp's own validator
  (`!apiKey && auth !== "none" && auth !== "oauth"`, readable in the 18.4.6
  bundle) exempts it from needing a key, but `oauth` only forces OAuth-style
  request shaping — omp still feeds `providerApiKey` into the Bearer header
  resolver, so a proxy behind it legitimately carries both. Only `auth: none`
  lands in omp's `keylessProviders`, so only there is a key in `models.yml`
  genuinely dead; `authIsKeyless` is the single predicate for that, and the
  writers that change the mode (`setAuth`, `applyPreset`) are the only ones
  that clear the key. Never widen it — hiding the field is as destructive as
  deleting the value.

### Composer word prediction (`hooks/useWordPrediction.ts`, `components/GhostMirror.tsx`)
- Ghost text comes from omp's `predict_word` RPC (engine = omp's
  `spelling.autocomplete` setting; omp applies the prose gates). Tab or →
  accepts; accept/typed-past outcomes go back as `predict_word_feedback`.
- Keystroke predictions never spawn or replace an omp child: the agent route
  answers `{ suffix: null }` when no process is alive, so sessions that are not
  running show no ghost text until the first send.
- Ghost text paints only when the caret ends its line (the mirror overlay would
  otherwise overlap typed text). Settings → Interface & Behavior → Word
  completion (`lib/composer-prefs.ts`, localStorage `omp-web:word-completion`):
  Auto (default) enables it only when the primary pointer is fine
  (`(pointer: fine)` — mouse/trackpad; browsers cannot detect an on-screen
  keyboard), Enabled/Disabled force it. Also skipped for
  drafts past 20k chars (omp's prose-gate cap); an omp without `predict_word`
  ("Unknown command") pauses requests for a minute.
- Ghost state lives in a small external store (`useSyncExternalStore` in
  `GhostMirror`), not ChatInput state: re-rendering the composer per ghost
  change was the dominant per-keystroke cost.

### Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` and reuses one `AudioContext`.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

## omp Session File Format (v3)

Location: `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"title","v":1,"title":"...","source":"...","updatedAt":"...","pad":"   ..."}   ← fixed 256-byte slot
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"...","modelId":"...","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
```

- Line 1 is a fixed-width 256-byte padded title slot, rewritable in place.
  Old pi files may lack it — the `{"type":"session"}` header is then line 1.
- Entries form a tree via `(id, parentId)`. Additional entry types
  (`title_change`, `session_init`, `mode_change`, `ttsr_injection`, ...) must
  be tolerated by readers.
- Large payloads (images) are externalized to the content-addressed blob store
  at `~/.omp/agent/blobs` and referenced from entries.

`entryIds[]` in `SessionContext` is a parallel array to `messages[]` — maps each displayed message back to its `.jsonl` entry id, used for fork and navigate_tree calls.

---

## Design Tokens & UI Kit (`app/globals.css`, `components/ui/`)

Warm-paper (light) / warm-ember (dark) palettes; every text/background pair is
WCAG AA-verified (measured ratios noted in `globals.css` comments). Components
must consume these variables — no hardcoded colors.

```
color:  --bg --bg-panel --bg-hover --bg-selected --border --bg-subtle
        --text --text-muted --text-dim
        --accent --accent-strong --accent-hover   (links / filled buttons / hover)
        --user-bg --tool-bg
type:   --font-serif (display headings, class .display-serif)  --font-mono
shape:  --radius-control (8) --radius-card (12) --radius-modal (16)
depth:  --shadow-card --shadow-pop --shadow-modal
motion: --dur-fast (150ms) --dur-med (220ms) --dur-slow (320ms) --ease-out-warm
```

`components/ui/` holds the shared primitives (built on `@base-ui/react`):
`primitives.tsx` (Dialog/Tooltip/Collapsible), `field.tsx` (form fields +
ConfirmDialog), `toast.tsx` (`toast.success/error/info`, mounted in AppShell).
Icons come from `lucide-react` — do not add new inline SVGs. The command
palette (`components/CommandPalette.tsx`, ⌘K/Ctrl+K) is built on `cmdk`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
