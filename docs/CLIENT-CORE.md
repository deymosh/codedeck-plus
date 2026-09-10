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
- `wss://` uses `rustls` (webpki roots), not `native-tls`, so it cross-compiles
  for Android without OpenSSL. That pulls `ring` (C/asm) — one more heavy
  transitive alongside `secp256k1`; the F1 `.so`-size gate (≤ 50 MB) covers it.
- `WsTransport` is single-threaded: the `SubCallbacks` closures are `!Send`, so
  it runs on a current-thread runtime inside a `LocalSet` (the FG service's
  client thread), every task `spawn_local`. Mirrors the TS `this`-bound model.
- The transport never reconnects on its own (`enableReconnect: false`) — a dead
  socket is ONE `on_close`; the FSM owns backoff and calls
  `WsTransport::ensure_connected`. `publish_confirmed` retries the SAME signed
  event only on `unreachable` (transient); `rejected` from every relay will
  reject it identically, `accepted`/`unconfirmed` mean the bridge has it.

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
| nostr client (epoch guard, filters, dedup, cursor) | `nostrClient.ts` + `poolOptions.ts` | `client_runtime::nostr_client` | ✅ F1 — driven live by `WsTransport` |
| bridge API — policy + ingest pipeline | `apps/mobile/src/core/services/bridgeApi.ts` | `client_core::bridge_api` | ✅ F1 — `kind_for_message`, egress-validated `build_command` (stamp `v`/`caps`, NIP-44, sign, expiry tag), `ingest` (decrypt → `ChunkAssembler` → decode, total), `classify_publish`/`combine_publish` verdicts, folder-ack id tracking |
| bridge API — socket I/O | same | `client_runtime::core` + `transport::ws` | ✅ F1 — `Core::send` builds + publishes, `publish_confirmed` runs the retry loop off-loop. folder-ack timers + full handler dispatch ⏳ F2 |
| NIP-42 relay AUTH signer | `packages/protocol/src/nip42.ts` | `client_core::nip42` | ✅ F1 — `build_auth_event` (kind-22242, identity-signed) |
| relay wire frames (REQ/CLOSE/EVENT/AUTH ↔ EVENT/EOSE/CLOSED/OK/NOTICE/AUTH) | nostr-tools SimplePool internals + `platform/relayTransport.ts` | `client_runtime::transport::frames` | ✅ F1 (pure codec) |
| relay read-loop routing (fan-out EOSE/close, AUTH, publish verdict aggregation) | nostr-tools `subscribeMany` + `raceForAcceptance` | `client_runtime::transport::router` | ✅ F1 (pure) |
| relay socket driver (connect + SOCKS5 + wss, read loop, ping liveness, AUTH, `publish_confirmed`) | `platform/relayTransport.ts` + `poolOptions.ts` | `client_runtime::transport::ws` (`WsTransport`) | ✅ F1 — `tokio-tungstenite` + `tokio-socks`; loopback mock-relay integration tests |
| runtime handle: connection FSM + `nostr_client` + `bridge_api` on one event loop; `start`/`stop`/`pause`/`resume`, CDX-020 watchdog, `CoreObserver` (seed of the F2 `CoreEvent` stream) | `apps/mobile/src/core/createPhoneCore.ts` + `stores/connection.ts` (effect interpreter half) | `client_runtime::core` (`Core`) | ✅ F1 minimal — integration-tested against the mock relay (start→connected, message delivery, drop→backoff→reconnect, stop terminal). Full View/Intent surface = F2 |
| in-process binding | `apps/mobile/src-tauri/src/corebridge.rs` + `platform/nativeCore.ts` + `core/nativeCore.ts` + `createPhoneCore.ts` + `main.tsx` | — | ✅ F1 — `native-core` Cargo feature (off by default → byte-identical build). Rust side: `Core` on a dedicated thread + `core_*` commands + `core://{connection,message,action-failed}` events. WebView side: `createNativeCore` probe → `NativeCoreControl` → `createPhoneCore` routes the bridge protocol through it (DM/Marmot stay on the WebView transport), inbound via `api.dispatchDecoded` + `connection.dispatch`. Known F1 rough edge: WebView + Rust both run a reconnect/CDX-020 loop — Rust is authoritative, the WebView's is a harmless nudge (F2: WebView store becomes a pure mirror in native mode). **`.so` ≤ 50 MB gate: PASS** — `./codedeck apk benchmark --features native-core` cross-compiles `client-core`/`client-runtime`/`tokio-tungstenite`/`tokio-socks`/`tokio-rustls` for `aarch64-linux-android` clean; `libcodedeck_mobile_lib.so` = 34.1 MB (≈ baseline — `ring`/rustls/tokio were already pulled by `reqwest`). **Still owed: emulator/real-device background matrix with the real transport, then delete the TS network path.** |
| `machines` store (whole pure module) | `apps/mobile/src/core/stores/machines.ts` | `client_core::stores::machines` | ✅ F2a — `merge_session_list` (bug-B: absence never deletes, tombstones only, `machineOffline`, stale grace, title guard, per-session extras survive) + `MachinesState` transforms (`apply_session_list` with the CDX-022 spread + resurrection shield, `apply_models` CDX-035 dance, `apply_session_upsert`/`_replaced`, `note_first_user_message`, `user_remove_session`, `dismiss`/`restore`, `apply_usage`/`_gsd`/`_provider_profiles`) + `serialize_machines`/`hydrate_machines` (round-trip can never truncate; `providerProfiles` never persisted). 27 tests incl. the 200×30 property run. Runtime owns `set`/persist. |
| stores (`outbox`, `pairing`, `transcript`/`sync`, `settings`, `ui`, `pendingSessions`, `quickPrompts`, `identity`), `notifications`, `presentation`, dm/marmot | `apps/mobile/src/core/**` | `client_core::**` | ⏳ F2a |
| MDK/MLS engine | `apps/mobile/src-tauri/src/marmot.rs` | `client_core::marmot` (feat) | ⏳ F2a |

Verify: `cargo test --workspace` + `cargo clippy --workspace --all-targets -- -D
warnings` (CI `cargo` job, `core` filter). No host toolchain needed — run in
`rust:1-bookworm` via Docker like the rest of the repo.

## F1 status

| Gate | State |
|---|---|
| Layer 1 native vector tests (codec corpus, chunking, ranges, connection reducer, `nostr_client`, `bridge_api`, `nip42`, transport `frames`/`router`, `Core` on a mock relay) | ✅ 167 Rust tests, `clippy -D warnings` clean |
| `./codedeck check` (TS unaffected) | ✅ |
| `.so` ≤ 50 MB | ✅ 34.1 MB (`./codedeck apk benchmark --features native-core`) |
| Real-device basic parity (benchmark APK, `native-core`): app opens, pair to a bridge, send + receive over the in-process runtime | ✅ |
| Background matrix (screen-off 1h · forced Doze · WiFi↔cell · airplane blip · reconnection) on real Samsung/Xiaomi, with the complete transport | ⏳ owner's manual real-device test |
| Transport parity checklist (plan §8) | ✅ — see below |
| Delete the TS network path | ⏳ after the background matrix |

### Transport parity checklist (plan §8)

| # | Requirement | Rust | Covered by |
|---|---|---|---|
| 1 | 3 filters by traffic class: 30515 no-`since`; 4516 `since = cursor − 60s` (omitted on first run); 24515 no-`since`; `authors` = paired + candidate, `#p` = phone | `nostr_client::build_phone_filters` | `builds_exactly_three_filters`, `heartbeat_and_live_never_carry_since`, `response_filter_resumes_from_cursor_minus_grace_and_omits_on_first_run` |
| 2 | Epoch guard (CDB-037): (re)connect bumps `epoch`; superseded callbacks ignored; teardown bumps `epoch` **before** closing; a deliberate teardown never emits `socket-close` | `nostr_client::{teardown_inner, connect}` + per-sub epoch check | `epoch_guard_deliberate_teardown_never_surfaces_as_close`, `events_from_a_superseded_epoch_are_dropped`, `real_subscription_death_reports_exactly_one_close_and_tears_the_epoch_down` |
| 3 | EOSE = socket-open only when **every** current-epoch sub has EOSEd | `nostr_client` `on_eose` (`eose_count == filter_count`) | `connect_opens_three_subs_and_reports_open_after_all_eose`, `with_no_machines_connect_reports_a_vacuous_open` |
| 4 | Dedup: `seenIds` cap 2000 FIFO; relays replay stored on reconnect | `nostr_client::SeenIds` | `dedups_replayed_event_ids_across_resubscribes` |
| 5 | Cursor: `lastStoredSeen` = max `created_at` over 4516 + 30515; persisted | `nostr_client::handle_event` → `host.note_stored_seen` | `tracks_stored_cursor_and_ignores_ephemeral`, `reconnect_resumes_response_filter_from_the_persisted_cursor`. ⚠️ F1 keeps it in memory (`HostBridge.cursor`); the `Kv`-backed persist is F2 |
| 6 | Backoff `2s→30s` +25% jitter; Tor variant `8s→60s`; `online` after offline/waiting-retry = reconnect now, `attempt=0`; visibility debounce 500 ms never tears a healthy socket; `resume` with a live socket → refresh only | `connection::{connection_reducer, backoff_delay_ms, DEFAULT_RECONNECT_CONFIG, TOR_RECONNECT_CONFIG}`; `Core` picks the config from `tor` | `reconnect_storm_backs_off_monotonically_and_converges_at_the_cap`, `jitter_adds_at_most_25pct_never_negative`, `offline_closes_and_cancels_online_reconnects_fresh`, `visibility_flip_storm_produces_no_socket_churn`, `resume_while_connected_is_cheap_refresh_no_churn` |
| 7 | CDX-020 dead-sub: `connected` + every machine heartbeat + `last_connected_at` older than 150 s → force `socket-close` | `connection::heartbeats_all_stale`; `Core` `StaleWatchdog` (30 s tick) | `all_stale_while_connected_past_grace_is_true`, `one_fresh_heartbeat_keeps_it_false`, `fresh_reconnect_gets_a_full_stale_window_of_grace`, `never_true_in_any_non_connected_status` |
| 8 | `idleTimeout` neutralised / `enablePing` / `enableReconnect:false` | `WsTransport` has **no** idle timer (hand-rolled — the nostr-tools bug does not exist); `PING_EVERY 30s` + `DEAD_AFTER 75s` liveness; `ensure_connected` only redials, the FSM owns reconnect | `ws` loopback tests |
| 9 | `publishConfirmed` 4-way: `accepted` / `unconfirmed` (frame written, no OK in the timeout — **not** failure) / `rejected` (`rate-limited:`/`blocked:`/`pow:`) / `unreachable` (`connection failure:` string); retry the **same** signed event within a budget | `bridge_api::{classify_publish, combine_publish}`; `transport::router` (settle on first `accepted`); `WsTransport::publish_confirmed` | `classify_publish_decodes_each_relay_outcome`, `combine_publish_takes_the_softest_verdict`, `publish_settles_immediately_on_first_acceptance`, `publish_timeout_settles_unconfirmed_for_the_silent_relays`, `publish_confirmed_maps_the_relay_ok_verdict`. Note: F1 retries only on `unreachable` (a `rejected` from every relay rejects the identical event identically) — deliberate |
| 10 | NIP-42 AUTH answered with the identity key; one allowlisted pubkey per side | `nip42::build_auth_event`; `WsTransport` `answer_auth` on `AUTH`, `ResubAfterAuth` on `CLOSED: auth-required` | `nip42::*` (3), `router::auth_challenge_is_surfaced`, `router::auth_required_closed_asks_for_a_resub_not_a_close`, `ws::answers_nip42_auth_with_an_identity_signed_event` |
| 11 | SOCKS5 per connection (`tokio-socks`); cleartext `ws://` only for `.onion` | `WsTransport::dial` — `proxy` set → `Socks5Stream::connect` (DNS at the proxy, so `.onion` resolves); `wss://` → rustls | ⚠️ the `ws://`-only-for-`.onion` **rejection** is an app-level settings check (as today), not enforced in the transport |
