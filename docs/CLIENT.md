# The phone client

The phone side of CodeDeck+ is a native Android app (`apps/android`, Kotlin +
Jetpack Compose) on top of a Rust core. The UI renders and collects input;
everything else — the wire protocol, encryption, the relay connection,
transcript sync, pairing, notification decisions, persistence — lives in Rust
and is shared by any future client.

## Layers

| Layer | What it holds | Rule |
|---|---|---|
| `crates/protocol` | the phone wire: messages, total codec, kinds, ranges, chunking, NIP-44/NIP-42 | depends on nothing internal; shared with the bridge |
| `crates/nostr-transport` | relay WebSocket + SOCKS5 driver, NIP-42 `AUTH`, publish verdicts | shared with the bridge |
| `crates/client-core` | reducers and stores as pure state machines: connection FSM, machines/sessions merge, outbox, pairing, transcript sync, settings, UI state, notification decisions, presentation (`display_entries`, GSD stages) | **no tokio, no sockets, no I/O**; clock and entropy injected; deterministic tests |
| `crates/client-runtime` | the async host: one tokio event loop composing the core's stores with the transport, the subscription client, timers and the platform ports — the `Core` handle | bindings attach here, never to `client-core` |
| `crates/client-ffi` | the UniFFI surface over `Core`, compiled to the `.so` the app loads | the only crate that knows UniFFI |
| `apps/android` | Compose UI, the foreground service, platform ports (SQLite, notifications, HTTP) | no protocol knowledge |

## The `Core` surface

`client_runtime::Core` is a cheap, cloneable handle; every call is a message to
its event loop.

- **`dispatch(Intent)`** — one closed enum, one variant per user action
  (send input, answer a card, create a session, pair, change a setting, …).
- **`*_view()`** — plain-data read projections: connection, machines, outbox,
  pairing, settings, pending sessions, quick prompts, UI state, transcript
  rows. A consumer reads only the slices it paints.
- **`CoreEvent`** (via `CoreObserver::on_event`) — a small semantic stream:
  `StateChanged { slice }` (re-read that view), `TranscriptAppended`,
  `OutboxSettled`, `PairingSettled`, `ActionFailed`, `FolderAck`, `Ping`. No
  UI strings: the app writes the copy.
- **Ports** the host supplies: `Kv` and `TranscriptStore` (SQLite on Android),
  `Notifier`, `HttpFetch` (Blossom image uploads), the Marmot engine, a clock
  and an entropy source.

`client-ffi` re-exposes this to Kotlin. `CoreEvent` and the view types cross
as the real Rust types; `Intent` crosses as a hand-mapped `UniffiIntent` (a
UniFFI enum derive is all-or-nothing, and several `Intent` payloads are wire
types). The Kotlin bindings under `apps/android/app/src/main/java/uniffi/`
are generated — never hand-edit them; `./codedeck gen-android-bindings`
regenerates them and CI fails on drift.

## The Android app

- `core/CoreHost.kt` owns the generated `Core`, turns its callbacks into
  `StateFlow`s, and re-reads a view when its slice changes.
- `platform/StayConnectedService.kt` is the foreground service that keeps the
  core (and the relay connection) alive while the app is in the background;
  its notification summarizes machines, sessions and relays.
- `platform/` also holds the SQLite-backed ports, the notifier (one channel
  per attention class; a tap opens the session) and the Blossom HTTP client.
- `ui/` is the Compose UI: the sessions list, the session screen and its
  transcript rows, pairing (QR scan), new session, settings.

Pairing is a QR scan of the bridge's `codedeck://pair?…` URL (see
[`PROTOCOL.md`](PROTOCOL.md#pairing)). The identity key is generated on the
phone and stored encrypted with an Android Keystore-backed key.

**Orbot.** A settings toggle routes the relay connections *and* Blossom image
traffic through Orbot's SOCKS5 proxy (`127.0.0.1:9050`); DNS resolves at the
proxy, so `.onion` relays work. The app does not launch or manage Orbot, and
the toggle is fully applied on the next app start (while running it affects
new connections only). Cleartext `ws://` is refused except to `.onion` hosts
(and loopback, for tests).

The release APK is signed and built for aarch64; `minSdk` is 26 (the JNA
runtime the UniFFI bindings use needs it).

**Not in the app yet:** NIP-17 direct messages and Marmot (MLS) group chat are
implemented in the core (`client-runtime`, Marmot behind its `marmot`
feature) but not exposed through `client-ffi` or the UI.

## Transport behaviour

These are the rules the connection code keeps; the subscription filters
themselves are in [`PROTOCOL.md`](PROTOCOL.md#traffic-class-subscription-rules).

- The transport is hand-rolled on `tokio-tungstenite` + `tokio-socks`, not a
  relay-pool library: a pool brings its own idle timeouts and reconnects, and
  collapses the publish outcomes below.
- The transport never reconnects on its own: a dead socket is one close
  event, and the connection FSM owns the backoff — 2 s → 30 s with up to 25%
  jitter, 8 s → 60 s over Tor. Going back online reconnects at once.
- Liveness: a ping every 30 s; a socket silent for 75 s is dropped. If every
  paired machine's heartbeat is older than 150 s (240 s over Tor) while
  "connected", the subscriptions are torn down and reopened.
- A publish settles as `accepted`, `unconfirmed` (written, no `OK` in time —
  not a failure), `rejected` or `unreachable`; only `unreachable` retries, and
  it retries the same signed event.
- An epoch guard drops callbacks from a superseded connection, so a deliberate
  teardown never surfaces as a close.
- `WsTransport` is single-threaded (`!Send` callbacks): the core runs on a
  current-thread runtime inside a `LocalSet` on its own thread.
- `wss://` uses rustls (webpki roots), so the core cross-compiles for Android
  without OpenSSL.

## Conventions

- A UniFFI error variant must not have a field named `message` (it collides
  with Kotlin's `Throwable.message`); use `detail` or `reason`.
- A type must not share its name with the enum variant that carries it (e.g.
  `ActionFailedKind`, not `ActionFailed`): the Kotlin codegen would resolve
  the field to the variant's own subclass.
- The wire's absent / `null` / value cases use `Tristate<T>`
  (`Keep` / `Clear` / `Set`).
- The `nostr` crate is used with minimal features (NIP-44, NIP-59, signing);
  its only heavy dependency is `secp256k1`.

## Build and test

```sh
./codedeck apk                           # debug APK into dist/ (Docker)
apps/android/scripts/build-apk-local.sh  # the same on Linux, no Docker
./codedeck gen-android-bindings          # after changing client-ffi's surface
cargo test -p client-core -p client-runtime -p client-ffi
```

In `apps/android`, `./gradlew testDebugUnitTest verifyPaparazziDebug` runs the
unit and screenshot tests (CI runs them, with the bindings drift check).
