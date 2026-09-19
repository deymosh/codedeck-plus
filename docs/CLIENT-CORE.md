# `client-core` / `client-runtime` — the shared Rust client

Status: **F2b complete — the stop-point** (migration plan). The Node/TS side
(`packages/*`, `apps/bridge`) is unaffected. `apps/mobile/src-tauri`'s
`native-core` feature is now the **default** (field-tested on a real device;
see the port-tracking table's last rows) and exposes the full plan §2
View/Intent/CoreEvent surface as Tauri commands over real SQLite persistence
and every `CorePorts` real: OS notifications (with working CDX-026c
cancellation), Blossom HTTP, and Marmot/MLS — `NoMarmot` is no longer
reachable from a default build. `apps/mobile/src/core` — the pre-F2b,
WebView-driven local composition (`createPhoneCore.ts`, the local FSM/
persistence half of every store, `services/nostrClient.ts`,
`platform/relayTransport.ts`, `deleteController.ts`, `notifications.ts`,
`selectionPersistence.ts`, `defaultSessionMode.ts`) is **deleted** (see git
history on `claude/native-android`) — `createPhoneCoreNative.ts`
(`apps/mobile/src/core/createPhoneCoreNative.ts`, eleven `stores/native*.ts`
adapters + `services/nativeBridgeApi.ts`) is the sole `PhoneCore` composition
now, and `main.tsx` fails loudly at boot rather than falling back to a local
path if a Tauri build somehow lacks the feature — there is no fallback left
to fall back to. Plain-browser dev (`pnpm dev` without Tauri) no longer boots
the app at all; UI iteration requires a Tauri build. Every UI test that used
to fixture itself against the local composition (~20 files) was migrated to
a shared fake-`NativeCore` helper
(`apps/mobile/src/core/__tests__/nativeCoreFixture.ts`) instead. All three
gaps this pass originally found — plus three more (`Notifier`/cancellation,
`HttpFetch`, `Marmot`) it surfaced along the way — are closed:
`Intent::RemoveMachine`, the `main.tsx` capability check, `SessionScreen.tsx`'s
native image-send branch (`PhoneCore.sendSessionImageNative`),
`TauriNotifier`, `ReqwestHttpFetch`, and `MarmotEngineImpl`. Verified end to
end: a real `native-core` benchmark APK builds, installs, and pairs on a real
device — that pass also surfaced and fixed one more bug (the undo toast never
clearing itself once its window expired, see the port-tracking table). Two
things touched along the way were originally recorded as separate, known
gaps rather than fixed in that pass — both later closed (see the
port-tracking table): the Tor toggle now hot-reconfigures a running
native-core transport and HTTP client live (`WsTransport::set_proxy`,
`ReqwestHttpFetch::set_proxy`), and the attention chime (`ping`) now has a
`CoreEvent::Ping` seam the WebView plays `platform/pingSound.ts`'s tone
through — the pure `decide_ping` logic already existed, the router just never
enabled it (`Router::new`'s `ping_available` default was never overridden).
One-QR mesh auto-join (`Intent`'s `mesh_join`) still has no platform port
wired for native-core — expected this early, since mesh is its own F6 Kotlin
phase in the plan, not an F2b concern. `platform/torProxy.ts` (the
WebView `PROXY_OVERRIDE` toggle) and its Tauri plugin (`tauri-plugin-tor-proxy`)
had become dead code with no remaining call site once native-core started
dialing its own SOCKS5 directly — both are now deleted; the `torProxyEnabled`
setting and its Settings toggle stay, since they still drive `CoreConfig.proxy`/
`tor` at `core_init`.

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
| `outbox` store | `apps/mobile/src/core/stores/outbox.ts` | `client_core::stores::outbox` | ✅ F2a — `OutboxState` send lifecycle (`new_input`/`begin_publish`/`settle_publish` verdict-wins/`confirm`/`fail`/`mark_retry`/`sweep`), CDX-013 retention (evict oldest resolved), `serialize`/`hydrate` total. 13 tests. |
| `pairing` store | `apps/mobile/src/core/stores/pairing.ts` | `client_core::stores::pairing` | ✅ F2a — `parse_pairing_url` (strict decode, relay cap CDX-013) + `parse_manual_pair` + `pairing_reducer` FSM with `PairingEffect`s (CDX-028/040/041). 26 tests. |
| `transcript`/`sync` store | `apps/mobile/src/core/stores/transcript.ts` | `client_core::stores::transcript` | ✅ F2a — `TranscriptState` sync client (coverage from storage, not a row cache), bounded backoff, `seq_conflicts`, `on_reconnect` reset, `SyncEffect`s. bug-B killer. 14 tests. |
| `settings` store | `apps/mobile/src/core/stores/settings.ts` | `client_core::stores::settings` + `wire::relays` | ✅ F2a — `SettingsData` + tolerant `hydrate_settings` (CDX-021/042 legacy-default lift), relay dedup → `RelaysChanged` effect, clamped `ui_scale`. 8 tests. |
| `pendingSessions` store | `apps/mobile/src/core/stores/pendingSessions.ts` | `client_core::stores::pending_sessions` | ✅ F2a — two-phase create placeholders (`apply_pending`/`resolve`/`apply_failed` ghost-safe/`dismiss`/`sweep` stale-`Pending`-only), `pending_for` oldest-first. Not persisted. 7 tests. |
| `quickPrompts` store | `apps/mobile/src/core/stores/quickPrompts.ts` | `client_core::stores::quick_prompts` | ✅ F2a (CDX-049) — CRUD with trim + empty-field rejection, garbage-tolerant `hydrate_quick_prompts`, `serialize` round-trip; runtime owns id gen + KV. 3 tests. |
| `notifications` decision engine | `apps/mobile/src/core/{notifications,notificationsCoordinator}.ts` | `client_core::notifications` | ✅ F2a — `decide_notify`/`decide_ping`, `NotificationCoordinator` shared cooldown, `classify_output_entry`, CDX-026c tags / CDX-048 toggle / CDX-053. 11 tests. |
| mode / default-mode controllers | `apps/mobile/src/core/{modeCycle,defaultSessionMode}.ts` | `client_core::{mode_cycle,default_session_mode}` | ✅ F2a — `ModeCycle` FSM with `ModeCycleEffect` revert-timer seam (CDX-046), `DefaultModeApplier` once-per-session (CDX-047). 7 tests. |
| `deleteController` | `apps/mobile/src/core/deleteController.ts` | `client_core::delete_controller` | ✅ F2a — pure `DeleteController` FSM: `request_delete`/`undo`/`timer_fired` emit `DeleteEffect`s (dismiss+remove+clear-unread+deselect / arm+toast / one `SendCloseSession` per committed delete, second delete commits the first). Undo restores the exact snapshot. 6 tests. |
| `selectionPersistence` (CDX-054) | `apps/mobile/src/core/selectionPersistence.ts` | `client_core::selection_persistence` | ✅ F2a — `encode`/`decode_selection` tolerant, `is_restorable` bounded both sides (a future-stamped record from a backward RTC correction is not fresh). Runtime owns the KV + timestamp refresh. 3 tests. |
| `sessionNeedsAttention` | `apps/mobile/src/core/sessionNeedsAttention.ts` | `client_core::session_needs_attention` | ✅ F2a — the one attention predicate (waiting-on-user OR unread), waiting branch independent of unread. 3 tests. |
| `ui` store | `apps/mobile/src/core/stores/ui.ts` | `client_core::stores::ui` | ✅ F2a — `UiState`: selection + `panel_mode`, `unread_sessions` (visible-gated clear on select), `responded_cards`/`plan_approval_choices` (optimistic), the credentials / device-config / provider-profile ack slices, `undo_toast`. CDX-026c `onSessionViewed`/`onDmOpened` are `UiEffect`s; `visible` passed per call. All transient. 9 tests. |
| `identity` store | `apps/mobile/src/core/stores/identity.ts` | `client_core::stores::identity` | ✅ F2a — `load_or_create_identity` (reuse a valid stored hex secret / regenerate on absent or corrupt, `needs_persist` flag for the runtime) + `IdentityState` holder. KV read/write is the runtime's. 3 tests. |
| `gsdStages` | `apps/mobile/src/ui/gsd/gsdStages.ts` | `client_core::presentation::gsd_stages` | ✅ F2a — `phase_stages` (disk-status → Discuss/Plan/Execute triple + the reachable-action fallback), `strip_summary` (drops unresolved parts), `situation_label`, `recommended_action` (id → flag → first), `execution_line`, `recovery_chips`. Pure over the v10 `GsdState`. 5 tests. |
| `displayEntries` | `apps/mobile/src/ui/transcript/displayEntries.ts` | `client_core::presentation::display_entries` | ✅ F2a — `build_display_entries` (flat `seq`+`OutputEntry` → grouped rows: user/assistant/tool_group/diff/error/system/lifecycle/plan_approval/question(_group)/permission_request), CDX-085 thinking folded into the action group, CDX-050 diff standalone, answered-card detection via `tool_result` match, `is_hidden_system_entry` noise filter, `find_pending_permission` (latest unanswered, un-responded). 15 tests. |
| `imageChunks` (CDX-029) | `apps/mobile/src/core/imageChunks.ts` | `client_core::image_chunks` | ✅ F2a — `chunk_base64` (35 KB relay-safe pieces, lossless), `base64_to_bytes` (Blossom upload input), `blossom_hash_from_url`. Pure; the inter-chunk publish delay is the runtime's. Adds `base64` (already in the workspace tree via `nostr`). 5 tests. |
| `dmAttachments` parse/build half | `apps/mobile/src/core/dmAttachments.ts` | `client_core::dm_attachments` | ✅ F2a — `parse_dm_content` (line-based text / `image` / `imageUrl` split, malformed refs stay text), `build_image_ref`, `preview_text`. The AES-256-GCM crypto + BUD-02 signed upload + download stay for `client-runtime` (need `aes-gcm` + `HttpFetch` port + deadline/abort). 6 tests. |
| `dm` store (state machine) | `apps/mobile/src/core/stores/dm.ts` | `client_core::stores::dm` | ✅ F2a — `DmState`: structural dedup (`id` then sender+content window), conversation upsert + unread accounting (active conversation never counts), `ingest_dm_rumor` (self-copy peer via `p` tag, status), `dm_since_cursor` (newest − 48 h), `parse_peer_input` / `truncate_peer_label` / `ordered_conversations` / `build_dm_filter`, profile cache TTL, `hydrate_dm` tolerant. The `nip59` unwrap, transport sub + epoch guard, 10050 publish and profile fetch stay in `client-runtime` (that layer carries the `dm` feature gate — the pure state machine is dep-free). 14 tests. |
| `marmot` store (state machine) | `apps/mobile/src/core/stores/marmot.ts` | `client_core::stores::marmot` | ✅ F2a — `MarmotState`: id-only dedup with the Failed→Sent promotion on the relay echo, conversation upsert (known-peer / prior-activity preference), unread gating, `apply_welcome` (stage + CDX-030 KP-consumed flag), `on_welcome_accepted` (join + welcomer backfill + returns the h tag), the VEIL-029 bounded unjoined-445 buffer + `take_buffered_for`, `should_mint_key_package` (CDX-030 mint-once), `unified_conversations` (Phase 6 list), `marmot_since_cursor`, `peer_of_group`, tolerant `hydrate_marmot`. The MDK/MLS engine calls, transport sub + epoch guard, KP + 10051 publish stay in `client-runtime` (that layer carries the `marmot` feature gate). 13 tests. |
| `deadline` (cancel / budget / with_deadline) | `apps/mobile/src/core/deadline.ts` | `client_runtime::deadline` | ✅ F2b — `remaining_budget`, `with_deadline` (tokio timeout), `CancellationToken` cancel, `StageError` taxonomy. |
| runtime ports | `apps/mobile/src/core/ports.ts` | `client_runtime::ports` | ✅ F2b — `Kv` / `TranscriptStore` / `Notifier` traits + `MemoryKv` / `MemoryTranscriptStore` / `RecordingNotifier`. `Clock` / `Entropy` in `rt::core`. `HttpFetch` in `rt::attachments`. |
| store bundle + persistence | `apps/mobile/src/core/createPhoneCore.ts` (hydrate) | `client_runtime::stores` | ✅ F2b — `CoreStores` (every `client_core` state machine), `hydrate` (KV + transcript-coverage rehydrate + identity), `Persister`. |
| message routing (`bridgeApi.handlers`) | `apps/mobile/src/core/createPhoneCore.ts` handlers | `client_runtime::dispatch::Router` | ✅ F2b — every `BridgeToPhone` family → `RouteResult` (persist / sends / notifies / heartbeat / pair-deadline / resubscribe). |
| read projections | `apps/mobile/src/core` selectors | `client_runtime::view` | ✅ F2b — `Connection` / `Machines` / `Outbox` / `Settings` / `Pairing` / `Dm` / `TranscriptSync` + `Core::*_view()`. |
| user actions | scattered store methods | `client_runtime::intent` | ✅ F2b — `Intent` enum + `apply` (session cmds, outbox send/retry lifecycle, delete + undo, full pairing flow, DM send/start, settings). `Core::dispatch(Intent)`. |
| semantic event stream | store subscriptions | `client_runtime::core::CoreEvent` | ✅ F2b — `StateChanged{slice}` / `OutboxSettled` / `PairingSettled` / `ActionFailed` via `CoreObserver::on_event`. |
| composed `Core` loop | `createPhoneCore.ts` | `client_runtime::core::Core` | ✅ F2b — async `spawn` (hydrate), Router + Intent + View + CoreEvent on one event loop; retry / vis / stale / pair / undo timers. |
| NIP-17 DM runtime | `nostrService` DM path + `dmStore` I/O | `client_runtime::core` (1059 sub) + `client_runtime::giftwrap` | ✅ F2b — kind-1059 subscription (epoch + catch-up cursor + kind-10050 publish), `wrap_dm` / `unwrap_gift_parts` (NIP-59), `Intent::SendDm`, `DmReceived` notification. |
| `dmAttachments` crypto / upload | `apps/mobile/src/core/dmAttachments.ts` | `client_runtime::attachments` | ✅ F2b — AES-256-GCM blob + SHA-256 id, `HttpFetch` port, BUD-02 signed upload with a retry budget, download+decrypt. |
| Session image upload (CDX-029, Blossom + chunk fallback) | `apps/mobile/src/ui/imageFile.ts` `sendSessionImage` | `client_runtime::core` (`send_session_image`) | ✅ F2b — `Intent::SendSessionImage(SessionImageSend { machine, session_id, text, image, filename, mime_type })` (bytes + mime, no platform type, plan §2.2). Two independent stages, same shape as the TS port: stage 1 uploads to Blossom (`attachments::upload_encrypted_image`); on success stage 2 publishes `upload-image` Blossom and returns — a rejection there is a hard failure (the bytes are already on the server, so no chunk retry). On a stage-1 failure only, stage 3 falls back to `client_core::image_chunks::chunk_base64` (35 KB pieces, 200 ms inter-chunk delay, ≤200 chunks, 55 s chunk-assembly budget paired with the bridge's window, 120 s overall) publishing one `upload-image` Chunk command per piece at a single publish attempt each. No outbox item, no local echo — the image lands in the transcript once the bridge injects it, like any other output; any unresolved failure surfaces as `ActionFailed::PublishRejected`. |
| Marmot runtime (445 sub, 444-welcome route, MDK seam) | `dmStore`/`marmotStore` I/O | `client_runtime::core` + `client_runtime::marmot` | ✅ F2b — `MarmotEngine` port (`NoMarmot` stub / `MarmotEngineImpl` behind feat `marmot`) in `CorePorts`. On (re)connect `Core` runs the full start sequence (mirrors `marmotStore.start()`): engine `init` → reconcile joined groups from `list_groups` → apply pending welcomes → CDX-030 mint-once KeyPackage + publish + the kind-10051 KP relay list → open the kind-445 subscription over the joined groups' `h` tags (epoch guard + catch-up cursor, torn down when no group is joined or the engine is absent). Each 445 goes through `marmot_engine.ingest`: a decrypted kind-9 rumor folds into `MarmotState` (unread + `DmReceived` notify), a not-joined verdict buffers the event verbatim (VEIL-029). kind-444 welcomes still ride the 1059 sub → routed to the same engine. `Intent::AcceptMarmotWelcome` joins the group, re-feeds the buffered 445s for its `h` tag in order, then reopens the sub; a welcome the engine can never accept (VEIL-117, a stale KeyPackage) drops the card instead of retrying forever. `Intent::SendMarmotMessage` encrypts + publishes then adds the plaintext locally (optimistic, `sent`). `Intent::StartMarmotChat` opens a 1:1 chat: an existing conversation with the peer is reused, never duplicated; otherwise a one-shot kind-30443 subscription fetches their newest KeyPackage (`KEY_PACKAGE_FETCH_TIMEOUT_MS`, `None` on timeout/absence — never errors), the engine's `create_group` builds the MLS group + welcome, and the welcome is published — a missing KeyPackage, an engine failure, or a publish rejection all surface as `ActionFailed` with no half-created group left behind. `Intent::SelectMarmotGroup` / `MarkMarmotRead` are pure store ops. `MarmotView` + `Core::marmot_view()`. |
| MDK/MLS engine relocation | `apps/mobile/src-tauri/src/marmot.rs` + `sqlstore.rs` | `client_core::marmot_engine` (feat `marmot`, SQLCipher) + `client_runtime::marmot::MarmotEngineImpl` | ✅ F2b — the MDK 0.8 / MLS + `rusqlite bundled-sqlcipher-vendored-openssl` engine moved verbatim into `client_core` behind feat `marmot` (off → `client-core` stays pure nostr+serde). `apps/mobile/src-tauri` now depends on `client-core` with `features = ["marmot"]` (same transitive stack, shared) and keeps only the Tauri command wrapper. CI builds + tests both `marmot` on and off. |
| `tools/contract-harness/` (Node devtool) | new | `tools/contract-harness` | ✅ F2b — a real `BridgeCore` + `FakeSdkFacade` fronted by a genuine `ws://127.0.0.1:<port>` relay (`relayServer.ts`, a thin wire adapter over `@codedeck/testkit`'s `InMemoryRelay`), driven by a documented stdin/stdout JSON control protocol (`get-relay-url` / `open-pairing-window` / `emit-sdk-message` / `get-bridge-transcript` / `restart-bridge` / `drain-logs` / `shutdown` — see its `README.md`). `restart-bridge` shuts the current `BridgeCore` down and starts a fresh one with the same identity/storage/state dir — a real process-restart scenario, not a reset. Process + socket, no FFI shim, matching the plan's rejection of one. Wired into the pnpm workspace (`tools/*`); its own `typecheck`/`test`/`build` run under the existing recursive scripts, `./codedeck check` green. |
| Rust integration test against the harness — Scenario A, in full (Layer 2 Go/No-Go gate) | `phoneCore.contract.test.ts` Scenario A | `crates/client-runtime/tests/contract_harness.rs` | ✅ F2b — spawns `node tools/contract-harness/out/main.js` as a real subprocess, speaks its stdin/stdout control protocol, and drives a real `client_runtime::Core` against it over an actual `ws://` socket, end to end: connect → `open-pairing-window` → `Intent::BeginPairing` → `pairing_view().phase == "paired"` → `Intent::CreateSession` → the harness's `list-sdk-sessions` names the spawned session → `emit-sdk-message` (init) → the session is visible in `machines_view()` → `emit-sdk-message` (assistant text) → rows land in the injected `MemoryTranscriptStore` → `Intent::SendInput` → the outbox item reaches `OutboxItemState::Confirmed` via a real `input-ack` → `restart-bridge` (the harness hands the resumed session a FRESH `FakeSdkFacade`, same as a real bridge restart killing the old SDK subprocess) → `BridgeCore`'s own resume-on-boot re-spawns the SAME session id → the bridge produces output while the phone is dark → `core.set_online(false)`/`set_online(true)` (the phone's own connectivity, independent of the bridge) → the FSM reconnects on its own, no manual nudging → sync gap-refill catches the phone's transcript up → asserted byte-identical to the bridge's own store, seq for seq. No FFI shim — process + socket, exactly as the plan calls for. `#[ignore]`d by default (needs Node + the harness build; `cargo test -p client-runtime --test contract_harness -- --ignored`), so `cargo test --workspace` needs no JS toolchain. Verified passing consistently across repeated runs (~0.5s each). |
`Intent` / `CoreEvent` get a stable JSON shape | — (new) | `client_runtime::intent::Intent`, `client_runtime::core::CoreEvent` | ✅ F2b — both gained `Serialize`/`Deserialize` (`Intent`) and `Serialize` (`CoreEvent`, `SliceId`, `ActionFailed`): externally tagged, camelCase throughout (`{"sendInput":{"machine":...,"sessionId":...}}`, bare `"undoDelete"` for a unit variant) — needs BOTH `rename_all` (variant names) and `rename_all_fields` (struct-variant field names), a one-line-easy-to-miss serde gotcha caught by a dedicated round-trip test on each. Every field type either already touched the wire codec (`PermissionModifier`, `EffortLevel`, `PhoneToBridge`, …) or is a plain type serde handles natively, so this was additive — no `Intent::apply` or `Core` loop behavior changed. Per plan §2.5 the shape is stabilized, not frozen, until F3. |
| Real persistent `Kv`/`TranscriptStore` for the native `Core` | `apps/mobile/src/platform/sqlite.ts` | `apps/mobile/src-tauri/src/native_ports.rs` | ✅ F2b — `KvSqlite` + `TranscriptStoreSqlite`, one shared `rusqlite::Connection`, opened INSIDE the core's own dedicated thread (`Connection` isn't `Send`; every `client_runtime` port lives behind an `Rc`). Deliberately schema-compatible with the WebView's existing migrations — same `codedeck.db` file, same `kv(key, value)` / `transcript(machine_pubkey, session_id, seq, kind, json, created_at)` tables — so an install upgrading onto the native path keeps its pairing, sessions, and transcript history. `corebridge.rs`'s `core_init` resolves `app_config_dir()` on the main thread (needs the `AppHandle`) then passes the bare path into the thread closure. Replaces F1's `CorePorts::default()` (fully in-memory — lost every store on every restart). |
| `corebridge.rs` exposes the full View/Intent/CoreEvent surface | `createPhoneCore.ts` | `apps/mobile/src-tauri/src/corebridge.rs` | ✅ F2b — `core_dispatch(intent: Intent)` (one command for all ~30 actions, `Intent`'s own JSON shape, no hand-rolled decoding) + `core_machines_view` / `core_settings_view` / `core_outbox_view` / `core_pairing_view` / `core_dm_view` / `core_marmot_view` (each a thin wrapper over the matching `Core::*_view()`; `core_connection_status` from F1 already covers `ConnectionView`'s ground) + `TauriObserver::on_event` forwarding the full semantic `CoreEvent` stream as a new `core://event` Tauri event (additive to F1's three hand-mapped events). All `native-core`-gated; the default build is untouched. |
| Real `Notifier` for the native `Core` | `apps/mobile/src/platform/notifier.ts` | `apps/mobile/src-tauri/src/corebridge.rs`'s `TauriNotifier` | ✅ F2b — `corebridge.rs`'s `CorePorts` used `..CorePorts::default()` for `notifier`, i.e. `NullNotifier`: a native-core boot would have silently delivered ZERO OS notifications (DMs, turn-finished, permission prompts) — found while wiring the `main.tsx` cutover, not part of the original 3 documented gaps. `TauriNotifier` calls `tauri-plugin-notification`'s Rust API (`AppHandle::notification().builder().title(..).body(..).show()`) directly from the core's own thread — the same plugin the WebView path drives over its JS bindings, no new IPC surface needed. `cancel` stays the trait's own default no-op: the plugin's remove-by-id call is exposed to the JS side (`removeActive`) only, and duplicating the WebView notifier's per-tag id bookkeeping just to auto-dismiss a resolved permission-request notification isn't worth it yet — a resolved card's notification lingers until swiped away, but nothing is ever silently dropped. |
| `MachineView.provider_profiles` — fix `#[serde(skip)]` | — (bugfix) | `client_core::stores::machines` | ✅ F2b — the field was skipped in EVERY serialization, not just `serialize_machines`'s KV-persistence path, so it would have silently never reached the live `MachinesView` an IPC consumer reads. Now carries `skip_serializing_if` instead, and `serialize_machines` strips it explicitly before persisting — the one place CDX-062 actually needs it gone. |
| `MarmotView` — add `available` + `pendingWelcomes` | — (bugfix) | `client_runtime::view::MarmotView` | ✅ F2b — `client_core::stores::marmot::MarmotState` already tracked both (the engine-ready flag and the pending-welcome map an accept-welcome UI needs), but `MarmotView::from_stores` dropped both on the floor: a native-core phone would have permanently hidden "start a Marmot chat" and made every incoming welcome invisible, with the underlying transport already working end to end. Added `MarmotWelcomeInfo`'s missing `Serialize`/`Deserialize`. |
| `QuickPromptsView` (new) | `apps/mobile/src/core/stores/quickPrompts.ts` (read side) | `client_runtime::view::QuickPromptsView` | ✅ F2b — `client_core::stores::quick_prompts::QuickPromptsState` already backed the CRUD `Intent`s end to end, but had no view at all. Thin over `quick_prompts.prompts`, `Core::quick_prompts_view()`, `core_quick_prompts_view` Tauri command. Also split `SliceId::QuickPrompts` out of the `StoreId::QuickPrompts → SliceId::Settings` mapping it shared before this view existed — quick prompts changing no longer needs a settings re-fetch to notice. |
| `PendingSessionsView` (new) + `Intent::DismissPendingSession` | `apps/mobile/src/core/stores/pendingSessions.ts` (read + dismiss) | `client_runtime::view::PendingSessionsView` | ✅ F2b — `client_core::stores::pending_sessions::PendingSessionsState` already applied every `session-pending`/`session-ready`/`session-failed` message via the `Router`, but nothing surfaced that state: no view, and no mutation ever fired a `CoreEvent` (this store is deliberately never persisted, so a `stateChanged` is the ONLY way a consumer learns to re-fetch). Added `pending_sessions_changed` to both `RouteResult` and `IntentResult` (the same non-persisted-but-notify-worthy pattern the `Cards` slice already uses for `r.notifies`), a dedicated `SliceId::PendingSessions`, and `Intent::DismissPendingSession` for the one user-facing mutation (a failed card's dismiss button) that had no way to reach the store at all. |
| `UiView` (new) + `Intent::SetPlanApprovalChoice` | `apps/mobile/src/core/stores/ui.ts` (read + the 4 user-facing mutators) | `client_runtime::view::UiView` | ✅ F2b — `UiState` (F2a) already ported the full selection + optimistic interaction-card bookkeeping, but had no view and most of its mutation points never fired a `CoreEvent`. `UiView` is `UiState` verbatim — NOT the plan §2.1 `CardsView` (a different, larger, per-session projection of actual card *content* that lands with the transcript-view work); this is only the flat bookkeeping around cards. Added `ui_changed` to both `RouteResult` and `IntentResult`, wired at every low-frequency mutation site (`SelectSession`/`SelectDmPeer`/`SelectMarmotGroup`, `RespondPermission`'s card-responded mark, `SendInput`'s unread-clear, the delete-controller's undo-toast/deselect effects, the three bridge-ack handlers) but deliberately NOT the high-frequency per-output-chunk unread-clear path (would spam refetches for a low-stakes dot on nearly every streamed token). `Intent::SetPlanApprovalChoice` closes the one piece of `UiState` with no existing Intent at all. |
| `TranscriptRowsView` (new) + `CoreEvent::TranscriptAppended` | `apps/mobile/src/core/stores/transcript.ts` (read side) | `client_runtime::view::TranscriptRowsView` | ✅ F2b — the one view backed by I/O (`TranscriptStore`, SQLite on device) rather than a synchronous snapshot: reads `1..=local_high` via the same `read_range` the write path already used and combines it with the in-memory sync/coverage state. `TranscriptAppended { machine, sessionId }` is a dedicated per-session event (not a generic `StateChanged{Transcript}`) fired on every `Output`/`SyncChunk` — deliberately NOT throttled like `ui_changed`, since a transcript view's whole purpose is to look live. |
| `BridgeApiLike` (new) + `createNativeBridgeApi` | `apps/mobile/src/core/services/bridgeApi.ts` | `apps/mobile/src/core/services/nativeBridgeApi.ts` | ✅ F2b — `PhoneCore.api` was typed as the concrete `BridgeApi` class; widened to an interface (`BridgeApi` now declares `implements BridgeApiLike`, zero behavior change) so a second implementation could dispatch `Intent`s instead of building/signing/publishing commands itself. Covers every method that has an `Intent` (all of them, after `SetCredentials`/`SetProviderProfile`/`SetDeviceConfig`/`CreateFolder`); `diagnostics` stays a zeroed inert field (nothing here ever decrypts/decodes a wire message). `ingest`/`input`/`dispatchDecoded` — the F1 in-process-runtime branch these existed for — were later found to have zero production callers at all and were deleted outright, not kept as no-ops. `createFolder` now has a real correlated-response path: `Intent::CreateFolder` → bridge `folder-ack` → `CoreEvent::FolderAck` matched by `request_id`. `uploadImageBlossom`/`uploadImageChunk` stay deliberate, documented rejections — their two-stage shape is already ONE step inside `Intent::SendSessionImage`, so shimming them individually would double-upload. |
| `Intent::RemoveMachine` (new) | `apps/mobile/src/core/createPhoneCore.ts`'s `removeMachine` | `client_runtime::intent::Intent::RemoveMachine` | ✅ F2b — purely local (no wire message: the bridge has no concept of "unpaired", it just stops hearing from a phone that stopped listening). Gathers the machine's session ids from `MachineView.sessions` (same source the TS version reads), drops the machine, clears each session's unread dot, deselects if it was selected, and queues each session for transcript-row removal — added `transcript_removed` to `IntentResult` (mirroring `RouteResult`'s tombstone-driven field) and cleared `TranscriptState`'s in-memory coverage via `remove_session` alongside the row-store delete, or a stale `local_high` would make `TranscriptRowsView` report rows that were already gone. `resubscribe` drops it from the authors filter. `createPhoneCoreNative.ts`'s `removeMachine` now dispatches this instead of being a no-op. |
| Real `HttpFetch` for the native `Core` | `apps/mobile/src-tauri`'s `plugin-http`-backed WebView escape hatch (CDX-029) | `apps/mobile/src-tauri/src/native_http.rs`'s `ReqwestHttpFetch` | ✅ F2b — `corebridge.rs`'s `CorePorts` used `..CorePorts::default()` for `http`, i.e. `NoHttpFetch`: every Blossom upload/download would have failed under native-core (found wiring the `SessionScreen.tsx` image-send branch, not part of the original 3 documented gaps). Reuses `tauri-plugin-http`'s OWN `reqwest` (re-exported as `tauri_plugin_http::reqwest`) rather than adding a second HTTP stack — the WebView path already depends on this exact crate as its CORS escape hatch. SOCKS5-aware: `core_init`'s `InitConfig::proxy` (the same `host:port` the WS transport dials when Tor is on) configures an identical `reqwest::Proxy`, so a Blossom upload never bypasses Orbot while the relay sockets don't either — the `socks` feature is forwarded onto `tauri-plugin-http` only via the `native-core` Cargo feature (`tauri-plugin-http/socks`), never unconditionally, so the default build's dependency graph is untouched. `set_proxy` rebuilds the client (proxies bake in at build time — no in-place update) when `Intent::SetTorEnabled` fires, same live-toggle wiring as the WS transport below. |
| `PhoneCore.sendSessionImageNative` + the `SessionScreen.tsx` native branch | `apps/mobile/src/ui/screens/SessionScreen.tsx`'s `sendWithImage` | `apps/mobile/src/core/createPhoneCoreNative.ts` | ✅ F2b — the one `PhoneCore` method the native composition defines that the local one does not (optional on the interface): `Intent::SendSessionImage` already does the whole Blossom-upload-then-chunk-fallback as one step in Rust, so there is no way to plug that into `BridgeApiLike`'s `uploadImageBlossom`/`uploadImageChunk` shape without either double-uploading or silently breaking the documented fallback (see `createNativeBridgeApi`'s doc). `SessionScreen.tsx` checks for the method's presence and, when native, decodes the staged file's base64 to raw bytes (`base64ToBytes`, already used elsewhere) and dispatches directly — no `BridgeApi` calls, no fine-grained upload progress (the spinner covers the one dispatch), no true cancellation of an in-flight send (the same outer `withDeadline` backstop applies, but a timeout only stops the spinner, not a send already handed to Rust). |
| `main.tsx` capability check | `apps/mobile/src/main.tsx`'s `boot()` | same file, `bootNative` | ✅ F2b — landed as a `bootNative` / `bootLocal` split (a single `createNativeCore()` probe deciding the whole composition, not just the transport) while `native-core` was still opt-in. Once it became the default feature and `src/core`'s local composition was deleted, `bootLocal` and the probe's fallback branch went with it: `boot()` now calls `createNativeCore()` once and THROWS if it comes back null (no Tauri, or a Tauri build without the feature) instead of falling back to anything — there is no local path left to fall back to. The stay-connected foreground service and connectivity wiring are unchanged; the WebView-only `attachTorProxy` (`PROXY_OVERRIDE`) call site is gone from `main.tsx` entirely (native-core's transport dials its own SOCKS5 at `core.init`), leaving `platform/torProxy.ts` itself dead code — see the top status note. |
| `CoreEvent`/`IntentResult::ui_effects` actually cancels notifications | `notificationsCoordinator.ts` (CDX-026c) | `client_runtime::core::Core::interpret_intent` | ✅ F2b bugfix — `Intent::SelectSession`/`SelectDmPeer` already returned the correct `UiEffect::SessionViewed`/`DmOpened` (proven by the `intent` module's own tests), but `interpret_intent` never read `r.ui_effects` at all: opening a session/DM the user was notified about left its OS notification sitting in the tray under native-core. Now maps each effect to `session_notify_tag`/`dm_notify_tag` (`client_core::notifications`, the same helpers `emit_notify` already used for delivery) and calls `self.notifier.cancel(tag)`. Found by re-auditing every `// … needs a … seam (F2b)` comment in `core.rs` after being asked "are there more gaps" — not part of the original 3, or of the `Notifier`/`HttpFetch` pair found earlier in this same pass. |
| The undo toast never cleared on window expiry | `deleteController.ts` (via `notificationsCoordinator`) | `client_runtime::core::Core::on_undo_timer` | ✅ F2b bugfix — reported from a real device running the native-core benchmark APK: closing a session and never tapping undo left the banner up forever. `on_undo_timer` correctly cleared `stores.ui.undo_toast` (`delete_controller::commit`'s `HideUndoToast` effect) but emitted `StateChanged(Cards)` at the end instead of `StateChanged(Ui)` — `commit()` never produces a card effect at all, so nothing told a `UiView` consumer to re-fetch and notice the toast was gone. Tapping undo itself was unaffected (that path already goes through `apply_delete_effects`, which sets `ui_changed` correctly). Regression test pairs a machine, lists a session, deletes it, lets the real ~4s window elapse without ever dispatching `UndoDelete`, and asserts both the toast is gone and a `StateChanged(Ui)` fired for it — confirmed failing on the pre-fix code. |
| Real `Notifier::cancel` for the native `Core` | `platform/notifier.ts`'s per-tag id bookkeeping | `apps/mobile/src-tauri/src/corebridge.rs`'s `TauriNotifier` | ✅ F2b — `TauriNotifier::cancel` was the trait's default no-op (a deliberate scope cut when `TauriNotifier` was first added). Now mirrors the JS notifier exactly: assigns an id per delivery (`.id(id)` on the builder, needed because `tauri-plugin-notification`'s mobile-only `remove_active` call removes by id, not tag), remembers ids per cancellation tag (capped, same as the JS side), and removes them on `cancel`. Desktop has no `remove_active` equivalent at all (`#[cfg(mobile)]`-gated; a no-op on desktop, matching the JS notifier's own graceful fallback). |
| Real `Marmot` for the native `Core` | `platform/marmot.ts` + `stores/marmot.ts` | `apps/mobile/src-tauri/src/corebridge.rs` + `Cargo.toml` | ✅ F2b — `CorePorts.marmot` was the last field still defaulting to a stub (`NoMarmot`): the runtime-side wiring (`Core`'s full start sequence, `Intent::AcceptMarmotWelcome`/`SendMarmotMessage`/`StartMarmotChat`, see the two rows above) was already complete and tested, but `corebridge.rs` never constructed a real engine, so every Marmot chat would have failed outright under native-core. Fix was two lines of substance: forward `client-runtime`'s own `marmot` feature (already just `["client-core/marmot"]`) through the `native-core` feature list — `client-core`'s `marmot` feature was ALREADY unconditionally on for this crate (the WebView path's own `marmot.rs` Tauri commands need it), so this adds zero new compiled dependencies — then construct `MarmotEngineImpl::new(marmot_db_path)`. `marmot_db_path` resolves to the SAME `app_data_dir()/marmot.db` the WebView path's `marmot_init` command already opens, deliberately — an install switching between the two compositions must keep its MLS group state; losing it is unrecoverable (every chat needs a fresh invite). Found the same way as the notification-cancel fix above: this pass's own `..CorePorts::default()` comment ("`marmot` stays in-memory-default") was the tell. |
| Re-point `apps/mobile` at the Rust `Core` + delete `src/core` | `createPhoneCore.ts` consumers | `apps/mobile/src/core/createPhoneCoreNative.ts` | ✅ F2b (composition, cutover, AND deletion landed) — `createPhoneCoreNative` assembles all eleven native store adapters (`createNative{Outbox,Settings,Pairing,Machines,Dm,Marmot,QuickPrompts,PendingSessions,Ui,Connection,Transcript}Store`) + `createNativeBridgeApi` into the `PhoneCore` shape `phoneCore.ts` now declares directly (relocated out of the deleted `createPhoneCore.ts`), so `usePhoneCore()` and every screen need zero changes to run against it. `identity.ts` needs no adapter (the TS side always owns loading/generating the persisted secret locally — it is the `core_init` *argument*, not something Rust exposes back). `PhoneCore.client` is gone entirely (nothing in production UI read it) and `sendSessionImageNative` is required, not optional, now that it is the only composition; `PhoneCore.api` is typed as `BridgeApiLike`. All 3 originally-documented gaps are closed (rows above), as are the 3 more this pass found (`Notifier`/cancellation, `HttpFetch`, `Marmot`). Verified with a real native-core benchmark APK build, not just `cargo`/`vitest`. `apps/mobile/src/core`'s local composition (`createPhoneCore.ts`, every store's local FSM/persistence half, `services/nostrClient.ts`, `platform/relayTransport.ts`, `deleteController.ts`, `notifications.ts`, `selectionPersistence.ts`, `defaultSessionMode.ts`, ~24 tests exercising them) is deleted; each surviving store file keeps only its shared types + pure helper functions native adapters or UI still call directly (`parsePairingUrl`, `sessionKeyOf`, `unifiedConversations`, `hydrateSettings`, …). `main.tsx` now has one boot path — no `bootLocal`, plain-browser dev no longer starts the app — and the `native-core` Cargo feature is `default = ["native-core"]`. The ~20 UI test files that used to fixture themselves against the local composition were migrated to a shared `fakeNativeCore()`/`buildFakePhoneCore()` helper (`core/__tests__/nativeCoreFixture.ts`) that scripts `NativeCore.dispatch` to behave like a real `client_runtime::Core` would, rather than re-implementing any Rust behavior in the fixture itself. |

**F2a status: complete** — the whole pure `client-core` layer.

**F2b status: the composed `Core` runs the full bridge protocol + NIP-17 DMs +
Marmot group messaging in Rust.** `client_runtime::Core` hydrates the store
bundle from the `Kv` port, folds every decoded `BridgeToPhone` through the
`Router`, exposes the `View` / `Intent` / `CoreEvent` surface (plan §2), and
drives the 1059 DM subscription, the Marmot start sequence (engine init →
group reconcile → KeyPackage/10051 publish), the kind-445 group subscription
(receive, send, accept-welcome + VEIL-029 re-feed), and the Blossom-first /
chunk-fallback session image upload, and the `StartMarmotChat` KeyPackage
fetch + group creation — proven end-to-end against the mock relay. The
MDK/MLS engine is relocated into `client_core::marmot_engine` behind feat
`marmot`; `client_runtime::marmot` carries the `MarmotEngine` port and its
`MarmotEngineImpl`. ~423 workspace tests (marmot off) + 317 `client-core` lib
tests with `--features marmot`, `clippy -D warnings` clean both ways.
`tools/contract-harness/` (Node) exists and Scenario A — the F2b Layer 2
Go/No-Go gate — passes in full from the Rust side:
`crates/client-runtime/tests/contract_harness.rs` spawns it as a real
subprocess and drives a real `client_runtime::Core` through pairing, session
creation, live output landing in the transcript, an input reaching
`Confirmed` via a real `input-ack`, a bridge restart with resume-on-boot, the
phone's own FSM reconnecting on its own, and a sync gap-refill leaving the
phone's transcript byte-identical to the bridge's — all over a genuine
socket, no FFI shim. `Intent` and `CoreEvent` now carry a stable, tested JSON
shape, and `apps/mobile/src-tauri`'s `native-core` feature exposes the full
surface as Tauri commands (`core_dispatch` + six `core_*_view` queries + the
`core://event` stream) over REAL persistence (`native_ports.rs`'s SQLite-backed
`Kv`/`TranscriptStore`, schema-compatible with the WebView's existing
`codedeck.db` so an upgrading install keeps its data), real OS notifications
(`TauriNotifier`), and real Blossom HTTP (`ReqwestHttpFetch`, SOCKS5-aware) —
replacing F1's in-memory-only ports. `apps/mobile/src` now runs on that
surface exclusively (`main.tsx`'s single boot path, `createPhoneCoreNative.ts`)
— see the port-tracking table's last rows. `apps/mobile/src/core`'s local
composition is deleted and `native-core` is the default Cargo feature: this
is the F2b stop-point the plan describes, reached and verified (`./codedeck
check` + `cargo test`/`cargo clippy` both green, a real device smoke pass
done by the maintainer). Whether the project continues into F3 (the first
Compose screen) is a separate decision, tracked in the plan document, not
this one.

**Aside — a regression caught along the way:** the MDK-engine relocation
earlier in F2b had removed `rusqlite` from `apps/mobile/src-tauri`'s direct
dependencies (its own need for it, unrelated to MDK's, moved with it by
mistake), which broke that crate's build entirely, in every feature
configuration, undetected because verifying it needs the Tauri Linux system
deps that a plain Rust container doesn't have and no PR had run it through
CI yet. Fixed; see the git history for `apps/mobile/src-tauri/Cargo.toml` if
this surfaces again after a future dependency shuffle — the lesson is that
`cargo check` on the `crates/` workspace alone does NOT cover `apps/mobile/
src-tauri`, which needs its own verification pass.

Verify (`crates/`): `cargo test --workspace` + `cargo clippy --workspace
--all-targets -- -D warnings` (CI `cargo` job, `core` filter). No host
toolchain needed — run in `rust:1-bookworm` via Docker like the rest of the
repo.

Verify (`apps/mobile/src-tauri`, default (native-core) and
`--no-default-features` both): `cargo test` / `cargo build
--no-default-features` (CI `cargo` job, `rust` filter). This needs the Tauri
Linux system deps (`libwebkit2gtk-4.1-dev libgtk-3-dev
libayatana-appindicator3-dev librsvg2-dev patchelf`) installed into the same
`rust:1-bookworm` image — a plain `crates/`-only container does NOT cover
this crate at all (see the regression note above).

## F1 status

| Gate | State |
|---|---|
| Layer 1 native vector tests (codec corpus, chunking, ranges, connection reducer, `nostr_client`, `bridge_api`, `nip42`, transport `frames`/`router`, `Core` on a mock relay) | ✅ 167 Rust tests, `clippy -D warnings` clean |
| `./codedeck check` (TS unaffected) | ✅ |
| `.so` ≤ 50 MB | ✅ 34.1 MB (`./codedeck apk benchmark`, native-core now default) |
| Real-device basic parity (benchmark APK, native-core default): app opens, pair to a bridge, send + receive over the in-process runtime | ✅ |
| Background matrix (screen-off 1h · forced Doze · WiFi↔cell · airplane blip · reconnection) on real Samsung/Xiaomi, with the complete transport | ⏳ owner's manual real-device test |
| Transport parity checklist (plan §8) | ✅ — see below |
| Delete the TS network path | ✅ — `apps/mobile/src/core` (the whole local composition, not just the transport half) is deleted |

### Transport parity checklist (plan §8)

| # | Requirement | Rust | Covered by |
|---|---|---|---|
| 1 | 3 filters by traffic class: 30515 no-`since`; 4516 `since = cursor − 60s` (omitted on first run); 24515 no-`since`; `authors` = paired + candidate, `#p` = phone | `nostr_client::build_phone_filters` | `builds_exactly_three_filters`, `heartbeat_and_live_never_carry_since`, `response_filter_resumes_from_cursor_minus_grace_and_omits_on_first_run` |
| 2 | Epoch guard (CDB-037): (re)connect bumps `epoch`; superseded callbacks ignored; teardown bumps `epoch` **before** closing; a deliberate teardown never emits `socket-close` | `nostr_client::{teardown_inner, connect}` + per-sub epoch check | `epoch_guard_deliberate_teardown_never_surfaces_as_close`, `events_from_a_superseded_epoch_are_dropped`, `real_subscription_death_reports_exactly_one_close_and_tears_the_epoch_down` |
| 3 | EOSE = socket-open only when **every** current-epoch sub has EOSEd | `nostr_client` `on_eose` (`eose_count == filter_count`) | `connect_opens_three_subs_and_reports_open_after_all_eose`, `with_no_machines_connect_reports_a_vacuous_open` |
| 4 | Dedup: `seenIds` cap 2000 FIFO; relays replay stored on reconnect | `nostr_client::SeenIds` | `dedups_replayed_event_ids_across_resubscribes` |
| 5 | Cursor: `lastStoredSeen` = max `created_at` over 4516 + 30515; persisted | `nostr_client::handle_event` → `host.note_stored_seen`, which now also fires `Msg::NoteStoredSeen` to `Persister::save_last_stored_seen` | `tracks_stored_cursor_and_ignores_ephemeral`, `reconnect_resumes_response_filter_from_the_persisted_cursor`, `a_stored_kind_event_persists_the_cursor_to_kv`. The hydrate-side read (`LAST_STORED_SEEN_KEY`) and the `Persister` write already existed; only the live `note_stored_seen` → `Kv` wire was missing — a restart replayed the peer's entire stored history every time until this closed it |
| 6 | Backoff `2s→30s` +25% jitter; Tor variant `8s→60s`; `online` after offline/waiting-retry = reconnect now, `attempt=0`; visibility debounce 500 ms never tears a healthy socket; `resume` with a live socket → refresh only | `connection::{connection_reducer, backoff_delay_ms, DEFAULT_RECONNECT_CONFIG, TOR_RECONNECT_CONFIG}`; `Core` picks the config from `tor` | `reconnect_storm_backs_off_monotonically_and_converges_at_the_cap`, `jitter_adds_at_most_25pct_never_negative`, `offline_closes_and_cancels_online_reconnects_fresh`, `visibility_flip_storm_produces_no_socket_churn`, `resume_while_connected_is_cheap_refresh_no_churn` |
| 7 | CDX-020 dead-sub: `connected` + every machine heartbeat + `last_connected_at` older than 150 s → force `socket-close` | `connection::heartbeats_all_stale`; `Core` `StaleWatchdog` (30 s tick) | `all_stale_while_connected_past_grace_is_true`, `one_fresh_heartbeat_keeps_it_false`, `fresh_reconnect_gets_a_full_stale_window_of_grace`, `never_true_in_any_non_connected_status` |
| 8 | `idleTimeout` neutralised / `enablePing` / `enableReconnect:false` | `WsTransport` has **no** idle timer (hand-rolled — the nostr-tools bug does not exist); `PING_EVERY 30s` + `DEAD_AFTER 75s` liveness; `ensure_connected` only redials, the FSM owns reconnect | `ws` loopback tests |
| 9 | `publishConfirmed` 4-way: `accepted` / `unconfirmed` (frame written, no OK in the timeout — **not** failure) / `rejected` (`rate-limited:`/`blocked:`/`pow:`) / `unreachable` (`connection failure:` string); retry the **same** signed event within a budget | `bridge_api::{classify_publish, combine_publish}`; `transport::router` (settle on first `accepted`); `WsTransport::publish_confirmed` | `classify_publish_decodes_each_relay_outcome`, `combine_publish_takes_the_softest_verdict`, `publish_settles_immediately_on_first_acceptance`, `publish_timeout_settles_unconfirmed_for_the_silent_relays`, `publish_confirmed_maps_the_relay_ok_verdict`. Note: F1 retries only on `unreachable` (a `rejected` from every relay rejects the identical event identically) — deliberate |
| 10 | NIP-42 AUTH answered with the identity key; one allowlisted pubkey per side | `nip42::build_auth_event`; `WsTransport` `answer_auth` on `AUTH`, `ResubAfterAuth` on `CLOSED: auth-required` | `nip42::*` (3), `router::auth_challenge_is_surfaced`, `router::auth_required_closed_asks_for_a_resub_not_a_close`, `ws::answers_nip42_auth_with_an_identity_signed_event` |
| 11 | SOCKS5 per connection (`tokio-socks`); cleartext `ws://` only for `.onion` (or loopback, for the mock-relay test rig) | `WsTransport::dial` — `proxy` set → `Socks5Stream::connect` (DNS at the proxy, so `.onion` resolves); `wss://` → rustls; a cleartext `ws://` to any other host is now refused before dialing at all | `dial_refuses_cleartext_to_a_public_host`, `dial_does_not_refuse_cleartext_to_onion_on_scheme_grounds`, `dial_does_not_refuse_cleartext_to_loopback`. No TS-side equivalent check exists (checked: neither the phone nor the bridge ever validated a relay URL's scheme) — this transport-level refusal is now the only enforcement, and the only one needed |
| 12 | Toggling Tor live redials every relay through the new proxy setting, no app restart needed | `WsTransport::set_proxy` (redials every open connection); `NostrClient::set_proxy`; `Loop::tor_proxy_address` remembers the SOCKS5 address independent of on/off state, since `Intent::SetTorEnabled` only carries a bool; `ReqwestHttpFetch::set_proxy` does the same for Blossom uploads (rebuilds the client — `reqwest` bakes its proxy in at construction) | `set_proxy_updates_what_the_next_dial_uses_and_closes_every_live_connection`, `set_proxy_swaps_the_client_live_in_both_directions`. Previously both were "known gaps" (`r.tor_changed` was computed and then dropped on the floor) — closed by having the phone always send the real SOCKS5 address in `InitConfig.proxy` (not nulled out when starting with Tor off) so `Loop` has something to switch back to |
