# F0 · probe 1 — UniFFI binding ergonomics

> **THROWAWAY.** This whole `spike/` tree exists only to answer, with running
> code, migration plan §7 **F0-probe-1**. Delete it once the verdict below is
> folded into the plan (or an ADR).

## Verdict: **GO**

A UniFFI-generated API for the future Rust `client-core` is idiomatic from
Kotlin/Compose and clean to consume from Tauri. Every hard case — foreign
callbacks, `async` commands, typed errors, object lifecycle with a background
task, and concurrency — works at runtime through the real FFI. Proceed with the
planned split: `client-core` (pure Rust) → `client-runtime` (async) → **UniFFI**
for `apps/android`, **`#[tauri::command]`** for `apps/desktop`.

## What was exercised

| Risk (plan §7 F0-probe-1) | How | Result |
|---|---|---|
| Foreign-implemented callback trait | Kotlin `class Collector : CoreListener`, Rust bg task calls `on_event` from its own thread | ✅ callbacks land on the Kotlin object |
| `async fn` command → Kotlin `suspend fun` | `Core::dispatch` is `#[uniffi::export(async_runtime = "tokio")]`; called from `runBlocking` / `async{}` | ✅ real `suspend fun dispatch(intent: Intent)` |
| Typed error across the boundary | `CoreError` / `CryptoError` enums → `sealed class CoreException : Exception()` | ✅ `assertFailsWith<CoreException.Rejected>`, `.reason` readable |
| Object lifecycle + bg task, no leak | `start()` spins a `tokio::runtime::Runtime` + task; `stop()` aborts + `shutdown_background()` | ✅ no events after `stop()`; `Core : AutoCloseable` |
| Concurrency | 50 concurrent `suspend` dispatches while the bg task emits to a Kotlin listener | ✅ exactly 50 `StateChanged`, ≥1 `TranscriptAppended`, no loss/dup/deadlock |
| Real NIP-44 v2 over FFI (plan risk #13) | `nostr` crate `nip44`, `String` in/out | ✅ round-trips; footprint measured (below) |
| Same API from Tauri | `tauri-consumer` crate: `#[tauri::command]` async + typed error + `emit` event stream | ✅ `cargo check` clean |

## Evidence (all green)

- **Native:** `client-core-probe/tests/native.rs` — 3 `cargo test`, `cargo clippy -D warnings` clean.
- **Through the FFI:** `kotlin/src/test/kotlin/ProbeTest.kt` — 4 JUnit tests via JNA against the real `libclient_core_probe.so`.
- **Tauri:** `tauri-consumer/` — `#[tauri::command] { dispatch (async), snapshot, start, stop }` + `wire_events` (`CoreListener` → `AppHandle::emit`) compile.
- **Compose shape:** `kotlin/src/main/kotlin/ProbeViewModel.kt` — the intended `ViewModel` over the bindings compiles: sealed `CoreEvent` folds into a `StateFlow`, `dispatch` in a coroutine, `CoreException` subclasses caught normally. ~45 LOC of glue, **zero domain logic**.

Reproduce: `./spike/uniffi-binding-probe/run.sh` (Docker only — no host toolchain).

## Generated Kotlin — ergonomics assessment

The `uniffi-bindgen` output (`kotlin/bindings/…/client_core_probe.kt`) is what a
Compose app would import:

```kotlin
suspend fun dispatch(intent: Intent)                 // real coroutine suspend, @Throws(CoreException)
sealed class CoreEvent { data class StateChanged(val slice: String) : CoreEvent(); … }   // exhaustive when
sealed class Intent    { data class SendInput(val session: String, val text: String) : Intent(); … }
sealed class CoreException : kotlin.Exception() { class Rejected(val reason: String) : CoreException(); … }
data class ProbeView(var running: Boolean, var seq: ULong, var listenerCount: UInt)
open class Core : Disposable, AutoCloseable { … }    // use {} / .destroy(), Cleaner fallback
interface CoreListener { fun onEvent(event: CoreEvent) }
```

Rust `///` docs are carried through to KDoc. Nothing here needs a wrapper layer
to be pleasant in Compose.

## Findings to fold into the real `client-core` (both are trivial conventions)

1. **A fielded UniFFI error variant must not name a field `message`.** It
   collides with Kotlin's `Throwable.message` and the 0.28 codegen does not emit
   `override` → the generated `.kt` won't compile. Convention: error fields are
   `detail` / `reason` / domain-specific — never `message`. Cheap to enforce in
   the planned anti-drift lint.
2. **`#[tauri::command]` functions go in a submodule, never a library crate's
   root** — the macro's `#[macro_export]` collides with its own local re-export
   there. `apps/desktop` will have a `commands` module regardless, so this is a
   non-issue in practice; noted so the real code starts that way.

## Data — `nostr` crate footprint (plan risk #13: hand-roll vs `nostr`)

`nostr 0.44` with `default-features = false, features = ["std", "nip44"]` pulls,
at depth 1: `base64 bech32 bitcoin_hashes chacha20 hex secp256k1 serde
serde_json url`. The only heavy item is **`secp256k1`** (vendored C) — and secp
ECDH is unavoidable for NIP-44 whether hand-rolled (`k256`/`secp256k1`) or not.

**Conclusion:** leaning on `nostr` for NIP-44 in F1 is fine and not bloated. A
hand-roll would only shave `serde_json` + `url` off the leaf — revisit only if
`.so` size becomes a real constraint.

## Also confirmed

- **`uniffi` + `serde` derives compose on the same type** → one definition of a
  boundary type (`Intent`, `CoreEvent`, `ProbeView`, `CoreError`) serves both the
  Kotlin (UniFFI) and the Tauri (serde/JSON) binding. No DTO duplication.
- The async bridge (`async_runtime = "tokio"`) coexists with the `Core`'s own
  owned `Runtime` for the bg task — two runtimes, no clash.
- `Runtime::shutdown_background()` (not `drop`) is the safe teardown from a sync
  FFI method.

## Not covered here — follow-ups

- **F0-probe-2** (NDK / SQLCipher / Marmot cross-compile in the new workspace) — needs `aarch64-linux-android` + NDK 28.
- **F0-probe-3** (background reliability on real Samsung/Xiaomi/Pixel) — needs hardware; the maintainer runs it.
- **F0-probe-4** (Markdown/Compose transcript parity) — independent.
- **arm64 Android build** of these bindings (`.so` per ABI) — F3 scaffolding.
- **Coroutine cancellation** of an in-flight `suspend dispatch` → Rust future drop — worth an explicit check in F1.

## Versions pinned in this probe

rustc 1.98.1 · uniffi 0.28.3 · nostr 0.44.8 · tokio 1.53 · tauri 2.11 ·
Gradle 8.14.3 · Kotlin 2.1.0 · JNA 5.15.0 · kotlinx-coroutines 1.9.0 · JDK 17

## Delete criteria

Once this GO is recorded in the plan (or an ADR), `rm -rf spike/`.
