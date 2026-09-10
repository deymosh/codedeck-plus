# `client-core` / `client-runtime` — the shared Rust client

Status: **F1 in progress** (migration plan). The Node/TS side (`packages/*`,
`apps/bridge`) is unaffected; `apps/mobile` is frozen and still ships the APK
until Compose reaches parity.

## Why

The "hard" client code — protocol codec, NIP-44, the connection FSM, the sync
client, dedup/epoch guards, tombstone merge, outbox, pairing FSM, chunking,
DM/Marmot orchestration, notification decisions — has identical requirements on
Android and a future Desktop client. Duplicating it (Kotlin + TS) means doing
every protocol change and every sync fix twice. It moves **once**, to Rust, and
both clients consume it: Android via UniFFI, Desktop via `#[tauri::command]`.

## Two crates

| Crate | Contents | Rule |
|---|---|---|
| **`crates/client-core`** | protocol codec + schemas, `crypto`, reducers (`connection`, transcript pin, mode…), `ranges`, `chunking` (framing), stores as pure state machines, `sync` policy, `mergeSessionList`, `outbox` logic, `pairing` FSM, `presentation` model (`displayEntries`, `gsdStages`), notification decision engine. | **No `tokio`, no sockets, no threads, no I/O.** Clock/entropy injected. Deterministic. Every part covered by native vector tests. |
| **`crates/client-runtime`** | tokio reactor, the `Transport` driver, live `ChunkAssembler`, `nostr_client` (epoch guard, dedup, cursor), lifecycle (`start`/`stop`/`pause`/`resume`), all ports wired. Exposes the `Core` handle. | The bindings (UniFFI, `#[tauri::command]`) attach **here**. `client-core` never knows a phone exists. |

`apps/mobile/src-tauri` + its `tauri-plugin-*` crates keep their own build and
are **not** workspace members yet — they join when `apps/android` is built.

## The API surface (`client-runtime`, target shape — plan §2)

- `*_view()` — read-only, plain-data projections by capability: `connection`,
  `machines`, `transcript(id)`, `outbox`, `cards(id)`, `settings`, `pairing`,
  `dm` (feat), `marmot` (feat). A consumer subscribes to the slices it paints.
- `dispatch(Intent)` — one flat closed enum, ~30 variants, one per user action.
  Total; returns `Result<(), CoreError>`. **Zero platform types** (images cross
  as `bytes + mime`).
- `subscribe(listener)` — a small closed `CoreEvent` stream: `StateChanged
  { slice }`, `TranscriptAppended { session, from_seq }`, `PairingSettled`,
  `OutboxSettled`, `ActionFailed { kind }`. **No UI strings.**
- Ports (traits): `Kv`, `SecureStore`, `Transport` (WS + SOCKS5),
  `TranscriptStore`, `Timers`, `Clock`, `Entropy`, `Notifier`, `HttpFetch`.

Size budget: 1 handle + ~9 views + ~30 `Intent` + ~5 `CoreEvent` + ~9 ports.
The API is **stabilised** with the mobile app (F2), **refined** by the first
Compose screen (F3), declared stable after F3, additive thereafter.

## What stays OUT (in each UI, correctly different)

Navigation/layout, gestures/scroll physics, list virtualization, Markdown /
syntax-highlight / diff / card **rendering** (the core gives the model), theming
& scale, keyboard shortcuts, localized date/number formatting, OS file/image
pickers, tray/menus.

## Conventions (from the F0 probes)

- A fielded UniFFI error variant must **not** name a field `message` (collides
  with Kotlin `Throwable.message`; the 0.28 codegen emits no `override`). Use
  `detail` / `reason`.
- A `#[tauri::command]` lives in a submodule, never a library crate root (its
  `#[macro_export]` collides with its own re-export there).
- Wire enums are never modelled exhaustively at the boundary — `#[serde(other)]`
  catch-all, so a newer Bridge's new enum value deserializes instead of failing
  the message.
- `Tristate<T> { Keep, Clear, Set(T) }` for the wire's absent/null/value cases
  (e.g. `set-provider-profile`).
- Leaning on the `nostr` crate (0.44, minimal features) for NIP-44 / NIP-42 /
  event signing is fine — the only heavy transitive is `secp256k1` (C),
  unavoidable.
- The relay transport is **hand-rolled** on `tokio-tungstenite` + `tokio-socks`,
  not `nostr-sdk` / `nostr-relay-pool`. The port's shape is a thin transport
  *under* the connection FSM; a pool re-introduces the self-timed idle close
  (CDX-020) and the "pool fires its own onclose" trap (CDB-037) the TS spent
  effort defeating, and its publish result collapses `unconfirmed` vs
  `unreachable` — the one distinction CDX-086 exists to keep. The client Nostr
  wire is ~10 frame shapes (`client_runtime::transport::frames`).

## Anti-drift with `packages/protocol`

`packages/protocol` stays the **normative spec** (zod). The Rust `wire` codec
is a mirror. `packages/protocol/fixtures/corpus.json` is the executable
contract: `packages/protocol/src/__tests__/fixtures.test.ts` (vitest) and
`crates/client-core/tests/codec_conformance.rs` (cargo) run the identical
assertions — decode every `valid` entry + semantic round-trip, reject every
`rejected` entry, ignore extra fields on `forwardCompatible` — on the identical
bytes. A schema change mirrored on only one side fails CI there. The `cargo`
job's `core` path filter includes `packages/protocol/fixtures/**`.

## Port-tracking

| Module | From (TS) | To | Status |
|---|---|---|---|
| `crypto` | `packages/core/src/nostr/crypto.ts` | `client_core::crypto` | ✅ F1 |
| kinds | `packages/protocol/src/kinds.ts` | `client_core::wire::kinds` | ✅ F1 |
| capabilities | `packages/protocol/src/capabilities.ts` | `client_core::wire::capabilities` | ✅ F1 |
| `ranges` | `packages/protocol/src/ranges.ts` | `client_core::ranges` | ✅ F1 |
| wire codec + schemas | `packages/protocol/src/{codec,schemas}.ts` | `client_core::wire::{codec,common,commands,events,tristate}` | ✅ F1 |
| `fixtures/` corpus + cross-lang conformance | `packages/protocol/fixtures/corpus.json` | `codec_conformance.rs` + `fixtures.test.ts` | ✅ F1 |
| chunking (framing + assembler) | `packages/protocol/src/chunking.ts` | `client_core::chunking` | ✅ F1 |
| connection reducer + presence/stale helpers | `apps/mobile/src/core/stores/connection.ts` (pure half) | `client_core::connection` | ✅ F1 |
| nostr client (epoch guard, filters, dedup, cursor) | `nostrClient.ts` + `poolOptions.ts` | `client_runtime::nostr_client` | ✅ F1 (real tokio-tungstenite + SOCKS5 transport = next) |
| bridge API — policy + ingest pipeline | `apps/mobile/src/core/services/bridgeApi.ts` | `client_core::bridge_api` | ✅ F1 — `kind_for_message`, egress-validated `build_command` (stamp `v`/`caps`, NIP-44, sign, expiry tag), `ingest` (decrypt → `ChunkAssembler` → decode, total), `classify_publish`/`combine_publish` verdicts, folder-ack id tracking |
| bridge API — socket I/O | same | `client_runtime` | ⏳ publish + `publishConfirmed` retry loop, folder-ack timers, handler dispatch — lands with the real `Transport` |
| NIP-42 relay AUTH signer | `packages/protocol/src/nip42.ts` | `client_core::nip42` | ✅ F1 — `build_auth_event` (kind-22242, identity-signed) |
| relay wire frames (REQ/CLOSE/EVENT/AUTH ↔ EVENT/EOSE/CLOSED/OK/NOTICE/AUTH) | nostr-tools SimplePool internals + `platform/relayTransport.ts` | `client_runtime::transport::frames` | ✅ F1 (pure codec) |
| relay read-loop routing (fan-out EOSE/close, AUTH, publish verdict aggregation) | nostr-tools `subscribeMany` + `raceForAcceptance` | `client_runtime::transport::router` | ✅ F1 (pure); `tokio` socket driver ⏳ |
| stores, sync, outbox, pairing, notifications, presentation, dm/marmot | `apps/mobile/src/core/**` | `client_core::**` | ⏳ F2a |
| MDK/MLS engine | `apps/mobile/src-tauri/src/marmot.rs` | `client_core::marmot` (feat) | ⏳ F2a |

Verify: `cargo test --workspace` + `cargo clippy --workspace --all-targets -- -D
warnings` (CI `cargo` job, `core` filter). No host toolchain needed — run in
`rust:1-bookworm` via Docker like the rest of the repo.
