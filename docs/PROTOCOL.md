# CodeDeck Protocol v10 — contributor contract

The single source of truth is `@codedeck/protocol` (`packages/protocol/src/`):
every wire message is a zod schema, TS types are `z.infer<>`, and BOTH sides
`safeParse` at ingest (invalid payloads are logged and dropped, never thrown).
This document covers the parts of the contract that are *conventions on top of
the schemas* — the things a schema alone cannot tell you.

## Event kinds (storage classes)

| Purpose | Kind | Storage |
|---|---|---|
| Session-list heartbeat (`sessions`) | **30515** | NIP-33 replaceable (d = machine name) — relay keeps exactly one |
| Live output / usage / gsd-state | **24515** | ephemeral — broadcast, never stored; loss is recoverable (sync / re-request) |
| Phone→bridge commands | **4515** | stored, NIP-40 expiry 1 h |
| Bridge→phone responses (sync chunks, acks, lifecycle, pairing) | **4516** | stored, NIP-40 expiry 1 h |

All content is NIP-44 encrypted between the bridge keypair and the phone
keypair. Identity is ALWAYS the event author's pubkey — payload claims (e.g.
`pair-request.pubkeyHex`) are display-only.

### DM kinds (not bridge protocol, but relay-policy relevant)

| Purpose | Kind | Storage |
|---|---|---|
| NIP-17 gift wrap (DMs + Marmot welcomes ride inside) | **1059** | stored; accepted when a `p`-tag recipient is registered (wrap sigs are ephemeral keys) |
| NIP-17 DM relay list | **10050** | replaceable |
| Marmot/MLS KeyPackage (MDK 0.8 / MIP-00 — **30443**, NOT the 443 the plan guessed; fixed in CDX-012) | **30443** | addressable (`d` tag required) |
| Marmot welcome rumor (only ever travels inside a 1059) | **444** | stored (spec completeness; clients never publish bare) |
| Marmot group message, routed by `h` tag | **445** | stored; signed by MLS-exporter-derived EPHEMERAL keys — accepted without registration (narrow carve-out, rate-limited per IP since CDX-013) |
| Marmot KeyPackage relay list | **10051** | replaceable |

## Traffic-class subscription rules (the bug-A contract)

The phone opens **three separate subscriptions**, one per storage class, with
deliberately different `since` filters:

| Kind | `since` | Why |
|---|---|---|
| 30515 | **none** | Replaceable — the relay always has exactly the current heartbeat; any `since` risks filtering it out and falsely marking the machine offline. |
| 4516 | **`lastStoredSeen − 60s`** | `lastStoredSeen` is a persisted high-water mark advanced ONLY by stored (4516) events. High-frequency live output can never push it past a response the phone still needs. |
| 24515 | **none** | Ephemeral — the relay stores nothing, so `since` filters nothing; a fresh subscription simply starts receiving the live stream. |

This split is what structurally kills the old since-starvation bug: the stored
cursor moves at command/response cadence, not at output cadence.

The bridge subscribes to 4515 from paired authors with
`since = lastSeen − 5s` (crash-gap grace). The relay will therefore REPLAY
recently processed commands after a restart — the bridge persists its dedup
event-id set alongside the cursor so the replay is a no-op.

## `pendingId == sessionId`

Two-phase session creation publishes `session-pending {pendingId}` →
`session-ready {pendingId, session}` / `session-failed {pendingId, reason}`.
**The bridge uses the future sessionId as the pendingId** — they are the same
string. Phones rely on this equivalence: a pending placeholder is resolved not
only by `session-ready` but also by the session simply appearing in a
heartbeat's `sessions[]` (matching `info.id === pendingId`).

## Transcript sync

`sync-request {sessionId, haveRanges}` → `sync-begin {syncId, seqHigh, ranges}`
→ `sync-chunk {range, entries}` (each acked with `sync-ack {syncId, range}`)
→ `sync-end {deliveredRanges}`.

- Seqs are assigned once by the bridge's transcript store at append time and
  are **never renumbered**. A seq that arrives twice with different content is
  a contract violation (phones detect and count it).
- **`sync-begin.ranges` is advisory.** It announces what the bridge *intends*
  to deliver (the complement of `haveRanges` at request time). The truth is
  `sync-end.deliveredRanges` — after retries, the delivered set may be smaller.
  Phones must reconcile against `deliveredRanges` (re-requesting the
  difference on the next connect), never assume `ranges` was fulfilled.
- The phone acks every chunk; the bridge retries unacked chunks a bounded
  number of times, then reports honestly in `deliveredRanges`.

## `models` response — machine correlation

`models-request` / `models` carry **no machine identifier in the payload**, and
they don't need one: the machine is the NIP-44 sender, i.e. the event author's
pubkey. **The rule is: correlate (and dedupe) models by machine pubkey.** Two
bridges on one box (`host: 'cli'` + `host: 'vscode'`) are two pubkeys and keep
two model lists; the `host` field is a UI badge, never identity.

## `input-failed.reason`

| Reason | Meaning |
|---|---|
| `no-session` | The bridge knows no session with this id. |
| `error` | The session exists but rejected the input (runner dead/ended). |
| `busy` | Reserved: the session cannot take input right now. Not currently emitted. |
| `expired` | The command aged out before the bridge processed it. |

`input-ack {inputId}` / `input-failed {inputId?}` drive the phone outbox
(pending → published → confirmed / failed). `inputId` is echoed verbatim.

## `pair-ack` extras

A successful `pair-ack` carries `relays` (the bridge's relay list) and `host`.
This exists for the **manual-npub pairing fallback**, whose input carries no
relay list — the phone merges `relays` into its settings (deduped) so it can
actually reach the bridge afterwards. QR pairing already carries relays in the
URL; the ack's list is merged the same way.

## Custom provider profiles (CDX-062)

Phone-managed, bridge-stored profiles that point a session at any
Anthropic-compatible backend (Kimi K3, OpenRouter, …). Four messages plus one
field:

- `set-provider-profile {profileId, profile | null}` (phone→bridge): upsert or
  delete one profile. `profile: null` deletes the whole profile.
  `profile.authToken` is tri-state: **undefined = keep** the stored token,
  **null = delete** it, **string = set** it.
- `provider-profiles-request` (phone→bridge): ask for the stored-profile list.
- `provider-profiles {machine, profiles[]}` (bridge→phone, **4516**): the
  redacted list. No `error` field — unlike `models`, it is always answerable
  straight from bridge storage. Audience: a `provider-profiles-request` is
  answered to the REQUESTING phone only; after every `set-provider-profile`
  change (upsert or delete) the bridge broadcasts the fresh list to ALL paired
  phones, so every device converges on the same profile set.
- `provider-profile-ack {machine, profileId, success, tokenValid?, error?}`
  (bridge→phone, **4516**): per-set ack. `tokenValid` is tri-state like
  `credentials-ack.keyValid` — absent means the probe could not run.
- `create-session.providerId?`: binds the session to a profile for its whole
  lifetime (provider is chosen ONLY at creation, like the model).

**Redaction rule: the auth token never leaves the bridge.** It rides the wire
exactly once — inbound, on `set-provider-profile.authToken` — and is stored in
the host's secret storage. Everything bridge→phone carries `hasToken: boolean`
only; phones persist zero secrets and zero profile copies.

**Capability gating is two-directional on `custom-providers`.** The bridge
advertises it on the heartbeat ("I store profiles and honor
`create-session.providerId`"); the phone must gate ALL provider UI and sends
on it — an old bridge's zod silently strips the unknown `providerId` field and
would run the session on Anthropic (wrong provider, wrong account's bill).

**Usage withholding:** the bridge publishes NO `usage` for provider-bound
sessions. `total_cost_usd` uses Anthropic's price table and the 5h/7d windows
are Anthropic-subscription concepts — showing nothing beats showing wrong
numbers. Phones render no cost/subscription figures for these sessions.

## Output entry vocabulary

`entryType`: `text` | `tool_use` | `tool_result` | `system` | `error` |
`progress` | `thinking`.

- `thinking` is the model's extended-thinking block, emitted as its own entry
  (phones render it collapsed). `metadata.redacted: true` marks
  `redacted_thinking` blocks, whose `content` is empty.
- Interaction cards ride `system` entries with `metadata.special`:
  `permission_request`, `plan_approval`, `ask_question`, plus lifecycle
  markers (`session_restart`, `session_died`, `session_failed`, `auth_error`
  on `error` entries).

## Capability negotiation

The bridge advertises `protocolVersion` + `capabilities[]` on every heartbeat;
phones stamp commands with `v` (+ optional `caps`). Gate features on
**capability strings** (`sync/1`, `folders`, `gsd`, `images`, `device-actions`,
`usage`, `models`, `diff`, `custom-providers`, `chunked`), never on version
comparisons.

Not every string is a runtime gate — see the three-tier note at the top of
`packages/protocol/src/capabilities.ts`:

- **HARD GATE** — behaviour changes when the string is absent: `images` and
  `custom-providers` (phone gates on the bridge heartbeat), `diff` (bridge
  gates diff-entry emission on every heard-from phone's command `caps`).
- **PRESENCE MARKER** — the feature is unconditional in v10; real detection is
  on payload data (`folders[]`/`roots[]`, `gsd.available`, the `usage`/`models`
  responses) or the feature just always runs (`sync/1`). `device-actions` too:
  implemented on the bridge, but no phone UI sends `create-session.testSession`.
- **TRANSPORT BEACON** — `chunked`: advertised on both sides, gated by neither.

## Oversize-event fragmentation (`chunk`)

A bridge→phone message whose encoded JSON would exceed one Nostr event's
`content` cap (65535 B) is split into N independently NIP-44-encrypted `chunk`
events (`{cid, i, n, part}`) and reassembled by the receiver *before* decode —
`seq` and every semantic field are byte-identical to the un-fragmented form.
This lives below the semantic layer: `chunk` is deliberately NOT a member of
`bridgeToPhoneSchema`, and neither side consults the `chunked` capability. See
`packages/protocol/src/chunking.ts`.

## Session-list truthfulness (the bug-B contract)

- Absence from `sessions[]` NEVER deletes on the phone — it marks `stale`.
- Removal happens only via `removedSessions[]` tombstones (or a user delete).
- A clean bridge shutdown publishes the full list with every session
  `state: 'offline'` and `machineOffline: true` — never an empty list.
