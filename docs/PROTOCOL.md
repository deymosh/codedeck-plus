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
keypair. Identity is ALWAYS the event author's pubkey — payload claims (e.g.
`pair-request.pubkeyHex`) are display-only.

#### DM kinds (not bridge protocol, but relay-policy relevant)

| Purpose | Kind | Storage |
|---|---|---|
| NIP-17 gift wrap (DMs + Marmot welcomes ride inside) | **1059** | stored; accepted when a `p`-tag recipient is registered (wrap sigs are ephemeral keys) |
| NIP-17 DM relay list | **10050** | replaceable |
| Marmot/MLS KeyPackage (MDK 0.8 / MIP-00) | **30443** | addressable (`d` tag required) |
| Marmot welcome rumor (only ever travels inside a 1059) | **444** | stored |
| Marmot group message, routed by `h` tag | **445** | stored; signed by MLS-exporter-derived ephemeral keys — accepted without registration (rate-limited per IP) |
| Marmot KeyPackage relay list | **10051** | replaceable |

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
`efforts[]`, `defaultMode`, `supports {models, usage, providers, gsd,
interrupt}` and `credentials[]` status. Phones build every picker from it and
offer a feature only when the session's agent `supports` it. Mode, effort and
model values are opaque strings the bridge validates against the catalog.

An agent the bridge has but cannot run here (not configured) is not
advertised; creating a session on it fails with the reason.

### Sessions

- **`pendingId == sessionId`.** `create-session {agent, …}` →
  `session-pending {pendingId}` → `session-ready {pendingId, session}` /
  `session-failed {pendingId, reason}`. The bridge uses the future sessionId as
  the pendingId; a pending placeholder is also resolved by the session simply
  appearing in a heartbeat's `sessions[]`.
- **Options:** `set-option {sessionId, option: mode|effort|model, value}` →
  `option-confirmed {sessionId, option, value}`. A refused value publishes
  nothing (the phone keeps what it knew); a refused effort or model confirms
  the value still in force. `option-confirmed` is also sent when the agent
  changes its own mode (it entered plan mode, a plan approval switched it).
- **Resume:** every session in the bridge's registry comes back when the
  bridge starts. When its agent dies it is restarted (continuing the agent's
  conversation when it has one) up to twice, each with a `notice` entry.

### Transcript entries

`output {sessionId, seq, entry}` carries one typed `OutputEntry`: a
`timestamp`, optional `subagent {label}`, optional `agentExtras` (the one
sanctioned escape hatch — agent-specific data no client depends on) and a body
tagged by `entryType`:

| `entryType` | What |
|---|---|
| `text` | conversation text; `role: user|agent`; `collapsible` folds it into a tool group |
| `plan` | a proposed plan (markdown) |
| `thinking` | model reasoning; `redacted` when the provider withheld it |
| `tool_call` | `callId`, `toolName` (display only), `kind` (read, edit, delete, move, search, execute, think, fetch, switch_mode, other), `title`, `locations`, `rawInput` |
| `tool_result` | `callId`, `text`, `isError` |
| `diff` | `path`, add/del/context `lines`, `truncated` |
| `permission_request` | a card: `requestId`, the tool, and `options[] {id, label, kind: allow_once|allow_always|reject_once|reject_always}` |
| `question` | one question of an ask: `requestId`, `index`/`count`, `options`, `multiSelect` |
| `plan_approval` | a card: `requestId`, `options[]` |
| `resolved` | a card was answered or cancelled: `requestId`, `summary` |
| `notice` | `session_restart`, `session_died`, `session_failed`, `auth_error`, `screenshot` |
| `status`, `error`, `turn_complete` | one-line status, an error, the end of a turn |

Clients branch on `entryType` and `kind`, never on tool names.

**Cards.** Every `permission_request`, `question` group and `plan_approval` is
closed by exactly one `resolved` entry with the same `requestId` — answered,
timed out (after an hour), interrupted, or cancelled because the agent died.
Answers: `permission-response {requestId, optionId}`,
`plan-response {requestId, optionId}`,
`question-response {requestId, index, answer: {kind: options, selected} | {kind: text, text}}`.
Plain `input` while a question is pending answers its first unanswered
question.

### Transcript sync

`sync-request {sessionId, haveRanges}` → `sync-begin {syncId, seqHigh, ranges}`
→ `sync-chunk {range, entries}` (each acked with `sync-ack {syncId, range}`)
→ `sync-end {deliveredRanges}`.

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

### Credentials

`set-credentials {agent?, values: {id: secret | null}}` → `credentials-ack
{agent?, success, credentials[] status}`. `agent` scopes the write to that
agent's advertised credentials; absent = the bridge's own (a GitHub token). An
id outside the scope refuses the whole write. A string sets, `null` clears, an
unlisted id is unchanged. A value the bridge's environment provides wins
(`fromEnv`) and the phone cannot clear it. **Secrets ride the wire only on
this message, inbound; status only ever goes out.**

### Custom provider profiles

Phone-managed, bridge-stored profiles that point a session at an
Anthropic-compatible backend. Only agents with `supports.providers` accept one.

- `set-provider-profile {profileId, profile | null}`: upsert or delete (`null`
  deletes). `profile.authToken` is tri-state: absent = keep, `null` = clear,
  string = set. The base URL must be https (http only on loopback) — the
  bridge never stores an insecure profile, and refuses to start a session on
  one written before that rule.
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
An empty list always comes with an `error` saying why, so the phone can tell
"no answer yet" from a lost message. Models are correlated by the machine that
sent them (the event author), never by a payload field.

### Pairing

A pairing window is a time-boxed subscription with **no author filter** — the
only way an unpaired phone reaches the bridge — plus a QR:
`codedeck://pair?npub=…&relays=…&machine=…&token=…[&netid=…&meshadmin=…]`.
Only a `pair-request` echoing the window's one-time token pairs. A successful
`pair-ack` carries `relays` and `host`, so a phone that paired from a bare
npub learns where the bridge lives. Rejections (`bad-token`,
`window-closed`) are answered at most five times per ten minutes.

### Capabilities

The heartbeat carries `protocolVersion` + `capabilities[]`; phones stamp
commands with `v` (+ optional `caps`). What an AGENT can do is catalog data
(`supports`), not a capability. The bridge's capabilities:

- **hard gate** — `images`: the phone shows image attach only when present;
- **presence markers** — `sync/1`, `folders`, `device-actions`: the feature is
  detected from payload data;
- **transport beacon** — `chunked`: advertised on both sides, gated by neither.

### Oversize-event fragmentation (`chunk`)

A bridge→phone message whose encoded JSON would exceed one event's `content`
cap (65535 B) is split into N independently encrypted `chunk` events
(`{cid, i, n, part}`) and reassembled by the receiver *before* decode — `seq`
and every semantic field are identical to the unfragmented form. `chunk` is
not a message type (`crates/protocol/src/chunking.rs`).

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
| `start-session {sessionId, agent, cwd, mode?, effort?, model?, resume?, credentials, env, provider?, hostTools, denySecretPaths}` | `ack` once starting (progress follows as events), or `error` |
| `end-session {sessionId}` | `ack`; no `ended` follows |
| `prompt {sessionId, text}` | `ack` |
| `interrupt {sessionId}` | `ack` |
| `set-option {sessionId, option, value}` | `ack` when applied, else `error` |
| `list-models {agent}` | `models {models, defaultModel?}` |
| `get-usage {sessionId}` | `usage {usage?}` |
| `check-credential {agent, credential, value}` | `credential-checked {valid?}` |

`AgentInfo` is the catalog entry minus credential status (the bridge adds
that), plus `credentials[].envVar` and `unavailableReason`.

### Host → bridge

Session events are notifications: `session-event {sessionId, event}` with
`event.type`:

| Event | Meaning |
|---|---|
| `ready` | The agent accepts prompts (once per `start-session`). |
| `info` | Changed facts only: `nativeSessionId` (the resume target), `model`, `mode`, `contextWindow`, `contextPercentage`. |
| `entries` | Transcript entries, in order (the bridge assigns seqs). |
| `turn` | `running` / `idle`. |
| `ended` | The session is gone: no `error` = a normal end; `resumeLost` = the conversation to resume no longer exists. The host forgets the session. |

Requests the host makes (the bridge answers each exactly once):

| Request | Reply |
|---|---|
| `request-permission {sessionId, requestId, toolName, kind, title, …, options}` | `permission-outcome {outcome: selected {optionId} \| cancelled {reason}}` |
| `ask-question {sessionId, requestId, questions}` | `question-outcome {outcome: answered {answers} \| cancelled {reason}}` |
| `request-plan-approval {sessionId, requestId, options}` | `plan-outcome` (as permission) |
| `call-host-tool {sessionId, tool, args}` | `host-tool-result {text, isError}` |

A `cancelled` outcome means nobody chose: the card timed out, the user
interrupted, or the session is ending. Host tools are tools the bridge
implements and offers to a session (the device-test tools); the host exposes
them to its agent under an MCP server named `codedeck`.

### Supervision

The bridge restarts a host that exits, with a backoff. Every session that was
running is treated as crashed (its cards are cancelled, a restart notice is
written) and is started again, resuming its conversation, once the new host
answers `initialize`. Input sent meanwhile is queued and delivered after the
restart.

### Adding an agent

1. Write a driver in `packages/agent-host/src/drivers/<agent>/` implementing
   `Driver` (`src/driver.ts`): `info()` advertises the agent (modes, efforts,
   `supports`, credentials); `startSession()` returns a `DriverSession` and
   reports through the `SessionContext` it is handed — `emit()` session
   events, `requestPermission()` / `askQuestion()` / `requestPlanApproval()`
   when the user must decide, `callHostTool()` for bridge tools.
2. Translate the agent's own events into typed `OutputEntry` values in the
   driver — nothing agent-specific may reach the bridge.
3. Register it in `src/main.ts` (it is enabled through
   `CODEDECK_AGENT_HOST_DRIVERS`).
4. Test it like `src/__tests__/claudeDriver.test.ts` and
   `opencodeDriver.test.ts` do, with the recording `SessionContext` in
   `src/__tests__/context.ts`.

The bridge and the phone need no change: the new agent appears in the
catalog, and its entries render through the typed vocabulary above. Only a
genuinely new *kind* of interaction needs a protocol change — in
`crates/protocol` (phone wire) or `crates/agent-protocol` (driver protocol),
then regenerate the host's types with
`cargo test -p agent-protocol --test gen_ts_bindings -- --ignored`.
