# F0 · probe 2 — NDK / SQLCipher / Marmot in the new workspace layout

> **THROWAWAY.** Delete once the verdict is folded into the plan (or an ADR).

## Verdict: **GO**

The MDK 0.8 / MLS + SQLCipher stack from `apps/mobile/src-tauri` survives the
plan's re-layout — living in `crates/client-core` as a **workspace member** and a
**cdylib**, **alongside the `uniffi` proc-macro stack** — and still
cross-compiles to `aarch64-linux-android`. Feature unification for
`rusqlite` / `openssl-src` holds across the workspace.

## What was proven

| Risk (plan §7 F0-probe-2) | Result |
|---|---|
| `rusqlite` `bundled-sqlcipher-vendored-openssl` unification breaks in a workspace | ✅ holds — `client-core` keeps the direct `rusqlite` dep, `mdk-sqlite-storage`'s `bundled-sqlcipher` unifies up to it, second workspace member (`client-runtime-min`) depends on `client-core` and resolution stays correct |
| SQLCipher + vendored OpenSSL C don't cross-compile for Android | ✅ `libclient_core.so` = **ELF ARM aarch64**, 14.5 MB, SQLCipher + OpenSSL C linked in |
| `secp256k1` C (via `nostr` 0.44) doesn't cross-compile for Android | ✅ linked into the same `.so` |
| `uniffi` proc-macros can't coexist with `openmls` / `mdk-core` in one crate | ✅ `uniffi::setup_scaffolding!()` + `#[uniffi::export]` compile alongside the full MLS stack |
| the MLS code path actually runs (not just links) | ✅ host test: two SQLCipher stores opened, key package minted + verified, 1:1 MLS group created, 2 members; a second test confirms the db file has **no plaintext `SQLite format 3` header** (encryption is real) |

## Findings

- **`cargo-ndk` + NDK r28c needs no `AR_/RANLIB_` env hacks.** The old
  `apps/mobile/docker/Dockerfile` exports
  `RANLIB_/AR_aarch64_linux_android` to NDK llvm tools to work around an
  `openssl-src` GNU-name issue (CDX-012). With `cargo-ndk` driving the build and
  NDK r28c, the arm64 cross-build of `bundled-sqlcipher-vendored-openssl`
  succeeds with **zero** manual toolchain env. The real `apps/android` Gradle
  build should use `cargo-ndk` and can likely drop those exports.
- The lean image (Rust + one NDK + `cargo-ndk`, no Android SDK, no Gradle) is
  enough for a `.so` cross-build — useful for a fast CI `cargo check --target
  aarch64-linux-android` gate before the full APK job.

## Not covered here

- **Running** the `.so` on-device / emulator — that's F0-probe-3 + F3.
- `armeabi-v7a` / `x86_64` ABIs — trivial add (`-t armeabi-v7a -t x86_64`), not
  needed to answer the risk.
- Stripping / final `.so` size budget — an F1/F3 concern (`≤ 50 MB` per plan).

## Versions

NDK r28c (28.2.13676358, matches `apps/mobile/src-tauri`) · rustc 1.98 ·
mdk-core / mdk-sqlite-storage / mdk-storage-traits 0.8 · nostr 0.44.8 ·
rusqlite 0.37 (`bundled-sqlcipher-vendored-openssl`) · uniffi 0.28.3 ·
cargo-ndk (latest)

## Reproduce

`./spike/ndk-marmot-probe/run.sh` (Docker only; first run downloads NDK ~600 MB).

## Delete criteria

Once this GO is recorded in the plan (or an ADR), `rm -rf spike/ndk-marmot-probe/`.
