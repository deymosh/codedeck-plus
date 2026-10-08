# CodeDeck protocol v11 — contributor contract

Two protocols meet in the bridge:

- **the phone wire** — phone ⇄ bridge over Nostr relays. Source of truth:
  `crates/protocol` (`commands.rs`, `events.rs`, `common.rs`). Both sides
  decode at ingest with total decoders (an invalid payload is logged and
  dropped, never thrown). `crates/protocol/fixtures/corpus.json` pins the JSON
  shape of every message.
- **the driver protocol** — bridge ⇄ agent host over a pipe. Source of truth:
  `crates/agent-protocol`; the agent host's TypeScript types are generated
  from it (`packages/agent-host/src/generated/`, CI fails on drift).

This document covers what the types alone cannot tell you: conventions,
invariants, and why.

v11 is a clean break from v10: no compatibility in either direction, and no
v10 data is carried over (a v11 bridge and app are a fresh install).

---

## Part 1 — the phone wire

### Event kinds (storage classes)

| Purpose | Kind | Storage |
|---|---|---|
| Session-list heartbeat (`sessions`) | **30515** | NIP-33 replaceable (d = machine name) — relay keeps exactly one |
| Live output / usage / gsd-state | **24515** | ephemeral — broadcast, never stored; loss is recoverable (sync / re-request) |
| Phone→bridge commands | **4515** | stored, NIP-40 expiry 1 h |
| Bridge→phone responses (sync chunks, acks, lifecycle, pairing) | **4516** | stored, NIP-40 expiry 1 h |

All content is NIP-44 encrypted between the bridge keypair and the phone
keypair — the phone's identity, or a session key it granted (see
[Session keys](#session-keys)). Every event the phone writes is signed by its
identity, and every event for the phone is `p`-tagged to its identity: identity
is ALWAYS the event author's pubkey — payload claims (e.g.
`pair-request.pubkeyHex`) are display-only.

### Traffic-class subscription rules

The phone opens **three separate subscriptions**, one per storage class, with
deliberately different `since` filters:

| Kind | `since` | Why |
|---|---|---|
| 30515 | **none** | Replaceable — the relay always has exactly the current heartbeat; any `since` risks filtering it out and falsely marking the machine offline. |
| 4516 | **`lastStoredSeen − 60s`** | `lastStoredSeen` is a persisted high-water mark advanced ONLY by stored (4516) events. High-frequency live output can never push it past a response the phone still needs. |
| 24515 | **none** | Ephemeral — the relay stores nothing, so `since` filters nothing. |

The stored cursor moves at command/response cadence, not at output cadence —
that is what keeps a burst of output from starving a response.

The bridge subscribes to 4515 from paired authors with
`since = lastSeen − 5s` (crash-gap grace). The relay therefore REPLAYS
recently processed commands after a restart — the bridge persists its dedup
event-id set alongside the cursor so the replay is a no-op.

### The agent catalog

Nothing in the wire names a particular coding agent. The heartbeat carries
`agents: AgentDescriptor[]` — per agent its `id`, `displayName`, `modes[]`,
`efforts[]`, `defaultMode`, `defaultEffort`, `supports {models, usage,
providers, providerModels, gsd, interrupt, commands, plugins, mcp, tasks}`, `credentials[]` status and
`install` (below). Phones build every
picker from it and offer a feature only when the session's agent `supports`
it. Mode, effort and model values are opaque strings the bridge validates
against the catalog.

Defaults are reported, never left implicit: a session created without a mode
or effort records the agent's `defaultMode` / `defaultEffort`, and one created
without a model reports (in the session list) the model the agent runs it on.
The default model is per agent and can change with the agent's own
configuration, so it rides the `models` reply as `defaultModel` rather than
the catalog. The agent refuses a model it does not offer; the session then
fails with that reason.

An agent the bridge has but cannot run here (not configured) is not
advertised; creating a session on it fails with the reason.

`install` says whether the agent is on the machine: `{state: "ready",
removable?}` (`removable`: CodeDeck installed it and can remove it; absent
means false, and a missing `install` means ready), `{state:
"not_installed"}`, `{state: "installing"}` or `{state: "failed", reason}`.
An agent that is not ready is listed by name only, supports nothing, and
runs no session: creating one on it fails with the reason. A session the
bridge already has (one resuming after an agent host restart) waits while
its agent installs, and starts once it is ready or fails with the install's
reason. A phone changes it with `agent-action {agent,
action}` (`install` or `remove`) → `agent-ack {agent, action, success,
error?}`; the ack says the bridge took it up (or why not), and the install
itself shows in the next session list's `install`. Removing ends the
agent's sessions and deletes only what CodeDeck installed; an agent the
machine has of its own is not removable.

### Sessions

- **`pendingId == sessionId`.** `create-session {agent, …}` →
  `session-pending {pendingId}` → `session-ready {pendingId, session}` /
  `session-failed {pendingId, reason}`. The bridge uses the future sessionId as
  the pendingId; a pending placeholder is also resolved by the session simply
  appearing in a heartbeat's `sessions[]`.
- **Ordering:** each `sessions` list carries `rev`, strictly greater than the
  last one the bridge published (its clock in ms, kept ahead of the stored
  last one, so a restart or a clock set back cannot lower it). The same list
  arrives over every relay and the direct link, and may be re-published or
  replayed, so a phone applies a list only if its `rev` is greater than that
  of the newest one it applied for that machine (kept across restarts); an
  older one changes nothing and announces nothing.
- **Options:** `set-option {sessionId, option: mode|effort|model, value}` →
  `option-confirmed {sessionId, option, value}`. A refused value publishes
  nothing (the phone keeps what it knew); a refused effort or model confirms
  the value still in force. `option-confirmed` is also sent when the agent
  changes its own mode (it entered plan mode, a plan approval switched it).
- **Resume:** every session in the bridge's registry comes back when the
  bridge starts. When its agent dies it is restarted (continuing the agent's
  conversation when it has one) up to twice, each with a `notice` entry.

### Transcript entries

`output {sessionId, seq, entries}` carries a run of consecutive typed
`OutputEntry`s, `entries[i]` being seq `seq + i`. The bridge sends what the
agent wrote in one go as one run, and the entries written while the relay
was still taking the previous event join the next one, up to what one event
holds unfragmented; a quiet session still sends each entry as it comes. Each
entry has a `timestamp`, optional `subagent {label?, parentCallId?}` (`parentCallId`: the
`agent` call that started it, so a client can nest its steps under that call), optional `agentExtras` (the one
sanctioned escape hatch — agent-specific data no client depends on) and a body
tagged by `entryType`:

| `entryType` | What |
|---|---|
| `text` | conversation text; `role: user|agent` |
| `plan` | a proposed plan (markdown) |
| `thinking` | model reasoning; `redacted` when the provider withheld it |
| `tool_call` | `callId`, `toolName` (display only), `kind` (read, edit, delete, move, search, execute, think, fetch, switch_mode, agent — a sub-agent launch —, other), `title`, `locations`, `input` (the whole input as text, bounded; absent for a file change, whose `diff` carries it) |
| `tool_result` | `callId`, `text`, `isError` |
| `diff` | `path`, add/del/context `lines`, `truncated` |
| `todos` | the agent's plan, whole each time: `items[] {text, status: pending|in_progress|completed|cancelled, activeText?}` and the `callId?` that wrote it; the latest one is the plan |
| `background_task` | work left running beside the turn: `taskId`, `kind: shell|agent|other`, `title`, `status: running|completed|failed|stopped`, `callId?` (the call that started it), `summary?`; the latest entry for a `taskId` is where it stands |
| `permission_request` | a card: `requestId`, the tool, and `options[] {id, label, kind: allow_once|allow_always|reject_once|reject_always}`; optional `reason` (why the agent asks, in its words) `hook` (the hook that asked, e.g. `PreToolUse:Bash` — it asks every time, so no "always" option) and `hookPlugin` (the plugin that hook comes from, when exactly one loaded plugin and no settings file declares a matching hook) |
| `question` | one question of an ask: `requestId`, `index`/`count`, `options`, `multiSelect` |
| `plan_approval` | a card: `requestId`, `options[]`; optional `revise` (the option that sends the plan back to revise, which the user's feedback may go with) |
| `resolved` | a card was answered or cancelled: `requestId`, `summary` |
| `notice` | `session_restart`, `session_died`, `session_failed`, `auth_error` |
| `status`, `error`, `turn_complete` | one-line status, an error, the end of a turn |

Clients branch on `entryType` and `kind`, never on tool names.

**Cards.** Every `permission_request`, `question` group and `plan_approval` is
closed by exactly one `resolved` entry with the same `requestId` — answered,
timed out (after an hour), interrupted, or cancelled because the agent died.
Answers: `permission-response {requestId, optionId}`,
`plan-response {requestId, optionId, feedback?}` (`feedback` only with the
card's `revise` option; the bridge records it as the user's message),
`question-response {requestId, index, answer: {kind: options, selected} | {kind: text, text}}`.
Plain `input` while a question is pending answers its first unanswered
question.

### Transcript sync

`sync-request {sessionId, haveRanges}` → `sync-begin {syncId, seqHigh, ranges}`
→ `sync-chunk {range, entries}` (acked with `sync-ack {syncId, ranges}`)
→ `sync-end {deliveredRanges}`.

- The bridge cuts the missing seqs into chunks by the size of their entries,
  up to what one event holds unfragmented: many short entries share a chunk,
  a long one may take one alone. A chunk's `range` may cover seqs it has no
  entry for (pruned), which the phone then has as far as sync goes.
- Each range in a `sync-ack` is exactly one chunk's `range`. One ack may
  cover several chunks: every command is signed by the phone's identity,
  possibly in an external signer, so a phone batches the acks for chunks
  that arrive together instead of signing one per chunk. The bridge waits
  10 s for acks before resending a pass, so a batch must go out well
  within that.

- Seqs are assigned once by the bridge and are **never renumbered**; they
  continue across bridge restarts. A seq that arrives twice with different
  content is a contract violation (phones detect and count it).
- **`sync-begin.ranges` is advisory.** The truth is
  `sync-end.deliveredRanges` — only what the phone acked. Phones re-request
  the difference on the next connect.
- Unacked chunks are resent twice with a doubling wait, then reported
  honestly.

### Input

`input {sessionId, text, inputId?}` → `input-ack {inputId}` or
`input-failed {inputId?, reason}`:

| Reason | Meaning |
|---|---|
| `no-session` | The bridge knows no session with this id. |
| `error` | The session exists but is not running. |
| `busy` | Reserved; not emitted. |
| `expired` | Reserved; not emitted. |

The bridge writes the user's transcript entry itself (agents do not reliably
echo input) and drops an agent's echo of it.

`interrupt {sessionId}` stops the running turn. `stop-task {sessionId,
taskId}` stops one background task, for agents with `supports.tasks`; the
task's next `background_task` entry says it stopped.

### Attachments

With the `files` capability, a phone attaches a file of any kind to a session
with `upload-file {sessionId, filename, mimeType, text, …}` in one of two
shapes: `{hash, url, key, iv, sizeBytes}` for a file it uploaded, AES-256-GCM
encrypted, to the user's own Blossom server (the key travels only in this
message), or `{uploadId, base64Data, chunkIndex, totalChunks}` pieces through
the relays when no server is set (or it failed). The bridge saves the file
under its own name in `<first root>/.codedeck/uploads` and runs `text` with
the path added as the session's next input — an image to be looked at, any
other file named. At most 25 MiB; a relay-only upload must fit 200 chunks.

### Credentials

`set-credentials {agent?, values: {id: secret | null}}` → `credentials-ack
{agent?, success, credentials[] status}`. `agent` scopes the write to that
agent's advertised credentials; absent = the bridge's own (a GitHub token). An
id outside the scope refuses the whole write. A string sets, `null` clears, an
unlisted id is unchanged. A value the bridge's environment provides wins
(`fromEnv`) and the phone cannot clear it. **Secrets ride the wire only on
this message, inbound; status only ever goes out.**

### Custom provider profiles

Phone-managed, bridge-stored profiles of another endpoint: a provider's own
API, or a gateway in front of several. Each is for one `agent` — the
endpoint must speak the API that agent uses, and one that speaks one
agent's need not speak another's. What a profile does is the agent's
catalog entry:

- `supports.providers`: a session can be bound to one of the agent's
  profiles (`create-session.providerId`), which then serves the whole
  session;
- `supports.providerModels`: the agent's profiles add their models to its
  own model list, beside every provider it already has; a session picks one
  as any other model, and is never bound.

Messages:

- `set-provider-profile {profileId, profile | null}`: upsert or delete (`null`
  deletes). `profile.agent` names an agent with either flag. `profile.authToken`
  is tri-state: absent = keep, `null` = clear, string = set. The base URL must
  be https, or http to this machine (`localhost`, `127.0.0.1`, `[::1]`) or to
  an IP address of the user's own network (10/8, 172.16/12, 192.168/16,
  100.64/10, fc00::/7 — addresses, never names) — the bridge never stores
  another, and refuses to start a session on one written before that rule.
- `profile.modelsFromProvider: true`: the phone lists no models; the agent
  host reads them from the endpoint's `/v1/models` (`/models` when the base
  URL already ends in `/v1`), signing in as the profile's agent does, with
  the profile's token, on every save, and the bridge stores at most 200. No
  redirect is followed, and the save is refused when the list cannot be read
  or is empty. A `defaultModel` the list does not name is dropped. The stored
  profile reports the flag back, so a later save (with the token kept) reads
  the list again. A model read so keeps, when the endpoint says, the
  `provider` a gateway routes it to (the part of the id before its first
  `/`, which stays in the id) and its `contextWindow`; phones group such a
  model under "profile · provider".
- The token is checked by the profile's agent, with the smallest request on
  the API it speaks (`tokenValid` in the ack).
- For an agent with `supports.providerModels`, a save waits on the agent
  taking the new list: a profile it leaves out (its own provider, or an
  older profile, has the name) is not saved — the earlier version stands —
  and the ack carries the agent's reason. A stored profile the agent leaves
  out later (after an operator adds a provider of that name) carries the
  reason as `error` in `provider-profiles`.
- A profile stored before profiles named their agent has an empty `agent`:
  no agent uses it until a save names one.
- `provider-profiles-request` → `provider-profiles {profiles[]}` to the asking
  phone; after every change the bridge broadcasts the new list to all phones.
- `provider-profile-ack {profileId, success, tokenValid?, error?}`;
  `tokenValid` absent = the check could not run.
- `create-session.providerId` binds the session to a profile for its whole
  life. The profile is looked up at every start, so a rotated token reaches
  restarts and a deleted profile ends the session loudly — never a silent
  fallback to the agent's own account.

The token never leaves the bridge: phones see `hasToken` only. No `usage` is
published for provider-bound sessions (the numbers would be priced for the
wrong provider).

### `models`

`models-request {agent}` → `models {agent, models[], defaultModel?, error?}`.
Each model is `{id, label?, provider?, efforts?}`: `provider` names who serves it (an
OpenCode provider, a router's channel such as `OpenCode Go`), since the same
model can be offered by more than one. `efforts` are the model's own
reasoning levels, from an agent whose levels differ by model: its catalog
entry lists no `efforts`, the phone offers the session model's instead, and
the bridge leaves checking a level to the agent. An empty list always comes with an `error` saying why, so the phone can tell
"no answer yet" from a lost message. Models are correlated by the machine that
sent them (the event author), never by a payload field.

### `commands`

`commands-request {sessionId}` → `commands {sessionId, commands[], error?}`,
for agents with `supports.commands`. Each command is `{name, description?,
argumentHint?}`; `name` has no leading slash and may be namespaced
(`plugin:command`). The bridge asks the agent every time — a session's
commands change while it runs (plugins, skills) — and answers an unknown,
stopped or command-less session at once. As with `models`, an empty list
always carries an `error`. A command runs by sending `/name args` as plain
`input`; the agent's driver turns it into whatever its agent needs.

### `plugins`

For agents with `supports.plugins`, a phone lists and changes the agent's
plugins on the bridge's machine (all its sessions share them):

- `plugins-request {agent, available?}` → `plugins {agent, installed[],
  marketplaces?, toggles, available?, error?}`. `installed[]` is `{id, name,
  marketplace?, version?, description?, enabled}`; `available` (only when
  asked for) is what the known marketplaces offer and is not installed,
  `{id, name, marketplace, description?, installCount?}`. An agent without
  marketplaces — it installs plugins by package name — sends no
  `marketplaces`; `toggles` says whether a plugin can be switched off without
  uninstalling it. A list that could not be read comes empty, with `error`.
- `plugin-action {agent, action, target}` → `plugin-ack {agent, action,
  target, success, error?, message?}`, then (when done) the new `plugins`, to
  every phone — with the fresh `available` when the change was to a
  marketplace (add, remove or update), since that alters the catalog.
  `action` is `install`, `uninstall`, `enable`, `disable`, `update` (target:
  a plugin `id` — update brings an installed plugin to its marketplace's
  latest version; `install` takes a package name where there are no
  marketplaces) or `add-marketplace` (target: `owner/repo` or a URL),
  `remove-marketplace`, `update-marketplace` (target: its name). The bridge
  refuses a target that is empty, starts with `-` or holds control
  characters. `message` is what was done, in the agent's words, when it says
  (e.g. an update's from/to versions). A change reaches running sessions:
  Claude Code reloads its plugins in place; OpenCode reloads, restarting its
  running sessions.

### `mcp`

For agents with `supports.mcp`, a phone manages the agent's MCP servers on
the bridge's machine and switches them in a running session. The agent's own
configuration is the library — Claude Code's user scope, OpenCode's global
config — so a server added here also works in that agent's terminal, and one
added there shows here. The bridge keeps no MCP state.

A server is `McpServerSpec {name, transport}`: `transport` is `{type:
"stdio", command, args?, env?}`, `{type: "http", url, headers?}` or `{type:
"sse", url, headers?}`. A name is 1–64 letters, digits, `-`, `_` or `.`,
starting with a letter or digit; a command must not start with `-`; a URL is
`http(s)://`. `McpServerSpec::problem` is that rule set, applied by the phone
before sending and by the bridge on receipt.

**Secrets flow one way.** Env and header values (a bearer token, an API key)
ride phone → bridge only, cross the host link as `Secret` (with the args and
the URL), and are written into the agent's config. Nothing sent back carries
them: `McpServerInfo {name, transport, target, envKeys?, headerKeys?,
enabled}` names a stdio server's program (not its args) or a remote server's
URL without user info, query or fragment, and only the names of what is set.
Changing a secret means adding the server again.

- `mcp-request {agent}` → `mcp-servers {agent, servers[], toggles, error?}`.
  `toggles`: a server can be switched off without removing it (OpenCode;
  Claude Code and the DeepSeek Harness have no such switch). A list that could
  not be read comes
  empty, with `error`.
- `mcp-action {agent, action, servers?, names?}` → `mcp-ack {agent, action,
  names, success, error?}`, then (when done) the new `mcp-servers` to every
  phone. `add` takes up to 50 `servers` (a name that exists is replaced);
  `remove`, `enable`, `disable` take `names`. One bad server refuses the
  whole action. Running sessions pick the change up (Claude Code reloads in
  place; OpenCode reloads, restarting them; the harness attaches its servers
  as it starts, so its next process uses the new list).
- `session-mcp-request {sessionId}` and `session-mcp-toggle {sessionId, name,
  enabled}` → `session-mcp {sessionId, servers[], toggles, projectWide,
  error?}`, each server `{name, status, error?, tools?}` with `status` one of
  `connected`, `pending`, `failed`, `needs-auth`, `disabled`. With
  `projectWide` (OpenCode) a switch applies to every session of the agent in
  the same project. A server wanting an OAuth sign-in reports `needs-auth`;
  the sign-in is done on the machine.

Phones also import servers from the JSON other clients use (`{"mcpServers":
…}`, VS Code's `servers`, OpenCode's `mcp`, or a bare name → config map):
`client_core::mcp_import` turns it into specs, reporting each entry it
cannot add.

### Pairing

A pairing window is a time-boxed subscription with **no author filter** — the
only way an unpaired phone reaches the bridge — plus a QR:
`codedeck://pair?npub=…&relays=…&machine=…&token=…`.
Only a `pair-request` echoing the window's one-time token pairs. A successful
`pair-ack` carries `relays` and `host`: the phone keeps the machine's relays
(the pairing's own plus the ack's) and reaches it over them from then on. Rejections (`bad-token`,
`window-closed`) are answered at most five times per ten minutes. A
`pair-request` may carry `sessionKey` to grant the first session key with
the pairing; the `pair-ack` is then already encrypted to that key.

### Session keys

A phone whose identity key lives in an external signer (NIP-55) should not
ask it to decrypt every message. It grants a local key, once:
`session-key {sessionKey: {pubkeyHex, bridgePubkeyHex, expiresAt}}` (or
`sessionKey` on its `pair-request`). `bridgePubkeyHex` names the one bridge
the grant is for; a bridge refuses a grant naming another, so a grant one
bridge saw cannot be replayed to a second. A session key only ever keys NIP-44 payloads; it never
signs. Every event keeps the same parties — the phone signs everything it
publishes (commands, grants, relay AUTH, image-server auth) with its
identity, and the bridge `p`-tags everything to the identity — so allowlists
on relays and image servers only ever see the identity. From the grant on:

- the bridge reads a command's payload encrypted with any of the identity's
  live keys, or with the identity itself;
- it encrypts everything for that phone to its newest live key. The first
  heartbeat after the grant is the phone's confirmation;
- `expiresAt` (seconds) is at most 90 days ahead; a lapsed key is dropped
  and the identity is encrypted to again. The phone grants a new key before
  then; each identity keeps its two newest keys, so commands encrypted with
  the previous one while rotating are still read;
- an event authored by a session key is not heard (only paired identities
  are); a grant naming a key the bridge already knows for anyone (a paired
  identity, another phone's key, its own) is refused.

A phone grants a session key only to a bridge advertising `session-keys`. A
phone that can decrypt a message from a bridge it granted a key only with
its identity learns the bridge has no live key for it, and grants again.

Renewal is rotation: a phone never extends a key's life by granting it
again. Every grant of a key runs until the same `expiresAt`, the key's own;
a month before it, the phone makes a fresh key and grants that to each
bridge (under the key the bridge holds, so the grant itself stays
readable). It keeps the previous key, and keeps encrypting to a bridge with
it, until that bridge confirms the new one by encrypting to it; once every
bridge has, or its grants lapsed, the previous key is deleted.

### Direct link

A bridge may also serve its phones directly, over its own WebSocket (LAN,
VPN, or an onion service), besides the relays. It carries the SAME signed
events, nothing else: no REQ/EOSE, a handshake and then events both ways.
Pairing still happens over the relays, and the bridge keeps publishing
everything there too, so a phone falls back to the relays whenever no direct
endpoint answers. Both sides drop an event they have seen by its id, so one
arriving both ways is handled once. `crates/protocol/src/direct.rs` is the
spec.

- **Discovery.** The heartbeat's `direct {endpoints, certSha256?}` lists
  where to connect, in order. `wss://` endpoints serve a self-signed
  certificate the phone pins by `certSha256` (no CA, any host name: private
  addresses and VPN names work); `ws://` is allowed only for `.onion`. The
  heartbeat is signed by the bridge and encrypted to the phone, so the pin
  is as authentic as the pairing. While the phone routes through Orbot it
  only uses `.onion` endpoints.
- **Frames**, each a JSON array in one text message:
  `["CHALLENGE", c]` (bridge, on connect) → `["HELLO", auth, since]` (phone,
  within a minute:
  `auth` a kind-22242 event signed by its identity, tagged
  `["challenge", c]`, `created_at` within 10 minutes) → `["READY"]` or
  `["CLOSED", reason]`. Then `["EVENT", event]` both ways, each phone event
  answered with `["OK", id, accepted, message]`.
- After `READY` the bridge sends what it published for that identity since
  `since` (seconds; it keeps an hour of it), then everything new. It takes
  only command events (4515) authored by the identity that said `HELLO`.

### Capabilities

The heartbeat carries `protocolVersion` + `capabilities[]`; phones stamp
commands with `v` (+ optional `caps`). What an AGENT can do is catalog data
(`supports`), not a capability. The bridge's capabilities:

- **hard gates** — `files`: the phone shows the attach control only when present;
  `session-keys`: the phone grants a session key only when present;
- **presence markers** — `sync/1`, `folders`: the feature is detected from
  payload data;
- **transport beacon** — `chunked`: advertised on both sides, gated by neither.

### Oversize-event fragmentation (`chunk`)

A bridge→phone message whose encoded JSON would exceed one event's `content`
cap (65535 B) is split into N independently encrypted `chunk` events
(`{cid, i, n, part}`) and reassembled by the receiver *before* decode — `seq`
and every semantic field are identical to the unfragmented form. `chunk` is
not a message type (`crates/protocol/src/chunking.rs`).

### Packed payloads

Before it is fragmented and encrypted, a bridge→phone message of 1 KiB or
more is packed when that makes it smaller: `~` followed by the base64 of
its raw deflate stream (`crates/protocol/src/packing.rs`). Wire JSON repeats
itself, so a packed message is typically several times smaller and takes
fewer fragments. A plain message is a JSON object and starts with `{`, so the
decoders tell the two apart and accept either, in both directions; inflating
is capped at 32 MiB.

### Session-list truthfulness

- Absence from `sessions[]` NEVER deletes on the phone — it marks `stale`.
- Removal happens only via `removedSessions[]` tombstones (or a user delete).
- A clean bridge shutdown publishes the full list with every session
  `state: 'offline'` and `machineOffline: true` — never an empty list.

---

## Part 2 — the driver protocol

The bridge (Rust) runs every agent SDK in one Node process, the **agent host**
(`packages/agent-host`), and talks to it over its stdin/stdout. Its stderr is
log output. The split is what keeps the bridge agent-neutral:

- a **driver** (one per agent, inside the host) owns everything specific to
  its agent — starting it, translating its events into transcript entries,
  what its modes mean, its permission policy (which tool calls ask the user),
  how credentials and provider profiles reach it, detecting a lost
  conversation;
- the **bridge** owns everything the phone sees — sessions and restarts,
  seqs and transcripts, cards and their timeouts, persistence.

### Framing

One JSON object per line (at most 16 MB): `{"v":1, "id"?:string, "kind":…,
"payload"?:…}`. Kinds are kebab-case, payload fields camelCase, enum values
snake_case. Requests carry an `id`; every request gets exactly one reply with
that `id` — its typed reply or `error {message}`. Notifications have no `id`.
The bridge's ids are `b1, b2, …`; the host's are `h1, h2, …`.

### Bridge → host

| Request | Reply |
|---|---|
| `initialize {bridgeVersion}` | `initialized {hostVersion, agents: AgentInfo[]}` |
| `start-session {sessionId, agent, cwd, mode?, effort?, model?, resume?, credentials, env, provider?}` | `ack` once starting (progress follows as events), or `error` |
| `end-session {sessionId}` | `ack`; no `ended` follows |
| `delete-conversation {sessionId, agent, cwd, conversationId}` | `ack` once the agent's own record of a deleted session's conversation is gone (also when there was none), after `sessionId` finished ending; or `error` |
| `prompt {sessionId, text}` | `ack` |
| `interrupt {sessionId}` | `ack` |
| `stop-task {sessionId, taskId}` | `ack` once asked (the task's next `background_task` entry says it stopped), or `error` |
| `set-option {sessionId, option, value}` | `ack` when applied, else `error` |
| `list-models {agent}` | `models {models, defaultModel?}` |
| `get-usage {sessionId}` | `usage {usage?}` |
| `list-commands {sessionId}` | `commands {commands}` |
| `list-plugins {agent, available?}` | `plugins {installed, marketplaces?, toggles, available?}` |
| `plugin-action {agent, action, target}` | `plugins {…}` once done (`available?` after a marketplace change, `message?` saying what was done), or `error` with the agent's reason |
| `list-mcp {agent}` | `mcp-servers {servers, toggles}` |
| `mcp-action {agent, action, servers?, names?}` | `mcp-servers {…}` once done, or `error` with the agent's reason |
| `session-mcp {sessionId}` | `session-mcp {servers, toggles, projectWide}` |
| `session-mcp-toggle {sessionId, name, enabled}` | `session-mcp {…}` once done, or `error` |
| `check-credential {agent, credential, value}` | `credential-checked {valid?}` |
| `check-provider {agent, provider, model}` | `credential-checked {valid?}`: a provider profile's token, checked on the API `agent` speaks |
| `list-provider-models {agent, baseUrl, authToken}` | `provider-models {models}` (never empty; each `{id, label?, provider?, contextWindow?}`), read the way `agent` signs in; or `error` with the reason there is none |
| `install-agent {agent}` | `ack` at once; the install's progress follows as `agent-changed`; or `error` |
| `remove-agent {agent}` | `ack` once removed — after `agent-changed` and the agent's sessions' `ended` — or `error` (e.g. an agent the machine has of its own) |
| `set-providers {agent, providers}` | `providers-set {refused: [{id, reason}]}` once an agent with `supports.providerModels` offers these profiles' models (all of its profiles, oldest saved first, sent after `initialize` and on every change) — all but the refused ones, which it cannot add (a name one of its own providers, or an earlier profile, has); or `error` |

`AgentInfo` is the catalog entry minus credential status (the bridge adds
that), plus `credentials[].envVar` and `unavailableReason`. The host
reports a change to one with the notification `agent-changed {agent:
AgentInfo}` (an install starting, finishing or failing, a removal); the
bridge replaces that entry, and once the agent is no longer installing
starts the sessions that waited on it.

### Host → bridge

Session events are notifications: `session-event {sessionId, event}` with
`event.type`:

| Event | Meaning |
|---|---|
| `ready` | The agent accepts prompts (once per `start-session`). |
| `info` | Changed facts only: `nativeSessionId` (the resume target), `model`, `mode`, `title` (the agent named the session; wins over the bridge's title from the first message and the session-meta topic), `contextWindow`, `contextPercentage`. |
| `entries` | Transcript entries, in order (the bridge assigns seqs). |
| `turn` | `running` / `idle`. |
| `ended` | The session is gone: no `error` = a normal end; `resumeLost` = the conversation to resume no longer exists. The host forgets the session. |

Requests the host makes (the bridge answers each exactly once):

| Request | Reply |
|---|---|
| `request-permission {sessionId, requestId, toolName, kind, title, …, options, reason?, hook?, hookPlugin?}` | `permission-outcome {outcome: selected {optionId} \| cancelled {reason}}` |
| `ask-question {sessionId, requestId, questions}` | `question-outcome {outcome: answered {answers} \| cancelled {reason}}` |
| `request-plan-approval {sessionId, requestId, options, revise?}` | `plan-outcome {outcome: selected {optionId, feedback?} \| cancelled {reason}}` (`feedback` only with `revise`) |

A `cancelled` outcome means nobody chose: the card timed out, the user
interrupted, or the session is ending.

### Supervision

The bridge restarts a host that exits, with a backoff. Every session that was
running is treated as crashed (its cards are cancelled, a restart notice is
written) and is started again, resuming its conversation, once the new host
answers `initialize`. Input sent meanwhile is queued and delivered after the
restart.

### Adding an agent

1. Write a driver in `packages/agent-host/src/drivers/<agent>/` implementing
   `Driver` (`src/sdk/driver.ts`): `info()` advertises the agent (modes,
   efforts, `supports`, credentials); `startSession()` returns a
   `DriverSession` and reports through the `SessionContext` it is handed —
   `emit()` session events, `requestPermission()` / `askQuestion()` /
   `requestPlanApproval()` when the user must decide.
2. Translate the agent's own events into typed `OutputEntry` values in the
   driver — nothing agent-specific may reach the bridge.
   For provider profiles, say in `supports` how the agent uses one
   (`providers`: bound to a session through `StartSession.provider`;
   `providerModels`: added to its models through `setProviders()`), and
   implement `listProviderModels()` and `checkProvider()` with the API the
   agent speaks to an endpoint (`src/sdk/providerApi.ts`).
3. Export a `DriverModule` (`src/sdk/module.ts`) from the folder's
   `module.ts`: the agent's id, how its driver is built from the
   environment, and its runtime (what the machine already has, and how to
   install the pinned one). Add it to the list in `src/host/modules.ts`; it
   is enabled through `CODEDECK_AGENT_HOST_DRIVERS`.
4. Test it beside the driver, in `src/drivers/<agent>/__tests__/`, like
   `drivers/claude/__tests__/claudeDriver.test.ts` and
   `drivers/opencode/__tests__/opencodeDriver.test.ts` do, with the
   recording `SessionContext` in `src/sdk/__tests__/context.ts`. Everything
   the driver owns — its permission policy included — lives in that folder
   too. A driver imports only `src/sdk/`, `src/install/`, `src/generated/`
   and its own folder; `src/host/__tests__/layout.test.ts` enforces it.

The bridge and the phone need no change: the new agent appears in the
catalog, and its entries render through the typed vocabulary above. Only a
genuinely new *kind* of interaction needs a protocol change — in
`crates/protocol` (phone wire) or `crates/agent-protocol` (driver protocol),
then regenerate the host's types with
`cargo test -p agent-protocol --test gen_ts_bindings -- --ignored`.
