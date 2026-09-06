# CodeDeck+ — mobile app

Control Claude Code sessions running on your laptop or VPS from your Android
phone, over end-to-end encrypted Nostr. No accounts and no central server: the
phone and the bridge pair directly by scanning a QR code.

`@codedeck/mobile` is the Tauri v2 Android shell — a React + TypeScript webview
over a small Rust host. Android appId `com.codedeck.plus`; signed
`codedeck-vX.Y.Z.apk` builds are attached to each
[GitHub release](https://github.com/deymosh/codedeck-plus/releases).

## What it does

- Multiple concurrent Claude Code sessions, switchable from one screen
- Plan approval, permission cards and AskUserQuestion prompts on the phone
- Transcripts that survive restarts, offline gaps and reinstalls (ranged sync)
- Per-session model and effort selection, plus custom AI provider profiles
  (Kimi K3, OpenRouter, any Anthropic-compatible endpoint)
- Encrypted Nostr DMs — NIP-17 and Marmot (MLS) side by side
- Project/folder management on every paired bridge host

CodeDeck+ additions on top of upstream:

- **Orbot routing** (`tauri-plugin-tor-proxy`): a Settings toggle sends the
  WebView's relay traffic through Orbot's SOCKS5 proxy via
  `androidx.webkit.ProxyController`. Android-only, off by default.
- **NIP-42 relay auth**: the phone answers a relay's `AUTH` challenge with its
  pairing identity key (implemented in `@codedeck/protocol`).

## You also need a bridge

The app is one half of a pair. Run [`@codedeck/bridge`](../bridge/README.md) —
the headless CLI / systemd connector — on the machine where Claude Code lives
(installed from a release tarball; it is not on npm). Both sides speak protocol
**v10 only**. CodeDeck+ has its own Android appId (`com.codedeck.plus`),
distinct from both the original CodeDeck (`com.codedeck.app`) and upstream
CodeDeck Next (`com.codedeck.next`), so it installs side by side with either —
but pairings, history and settings do not carry over.

## Build from source

No host toolchain is required — the checks and APK builds run in Docker via the
repo-root `./codedeck` wrapper:

```sh
./codedeck check           # typecheck + test, every package
./codedeck apk debug       # fast, unstripped, Android debug keystore
./codedeck apk benchmark   # release-optimized .so, debug-signed so it installs
```

`./codedeck apk` uses the `apps/mobile/docker/` toolchain image (Android SDK +
NDK 28 + Rust `aarch64-linux-android` + `cargo-tauri`) — several GB on first
build. See `apps/mobile/docker/build-apk.sh` for the modes and their
trade-offs.

To iterate on the webview alone (inside the workspace container, or with a
native Node 22 + pnpm toolchain):

```sh
pnpm --filter @codedeck/mobile dev     # Vite dev server at http://localhost:1420
pnpm --filter @codedeck/mobile test
```

`dev` serves the webview in a plain browser — the `isTauri` guards in
`src/platform/*` fall back to stub implementations, so most of the UI is
exercisable without a device. A native APK build additionally needs JDK 21 and
the Rust `aarch64-linux-android` target.

**Signed release APKs** come from CI only: pushing a `vX.Y.Z` tag runs
`.github/workflows/release.yml`, which builds the aarch64 release APK, signs it
with the repository keystore secrets, and attaches it to the GitHub release.
See `.claude/skills/cut-release/SKILL.md`.

The Android `versionName` and `versionCode` both come from `tauri.conf.json`
`version` — Tauri derives `versionCode` as `major·1_000_000 + minor·1_000 +
patch`. Do not pin `bundle.android.versionCode`; bumping `version` is the whole
job.

The mesh engine (`libnostr_vpn_app_core.so`) is cross-compiled from a
`nostr-vpn` checkout beside the repo; without it the Gradle task logs a warning
and the APK ships without mesh support (mesh is a dev/QA remote-testing feature,
off by default — see the root README's Releases section for the optional
`NVPN_REPO` wiring).

## Layout

```
src/core/       stores, connection FSM, bridgeApi, nostrClient, crypto
src/ui/         screens + components + transcript renderers
src/platform/   Tauri seams — every one isTauri-guarded with a browser fallback
src-tauri/      Rust host (marmot.rs = MLS/Marmot DMs, sqlstore.rs = transcript
                SQLite) + tauri-plugin-* (background-relay, tor-proxy,
                codedeck-stt, mesh — Rust + Kotlin)
```

The phone core **does not import `@codedeck/core`** (the bridge engine):
`src/__tests__/layering.test.ts` enforces this, and `src/core/crypto.ts`
deliberately mirrors core's crypto helpers rather than importing them. The only
shared package it depends on is `@codedeck/protocol` — the v10 wire contract. A
protocol change has to land in `@codedeck/protocol` and be understood by both
the app and its bridge together, or they stop talking.

## Related repos

- [deymosh/codedeck-plus](https://github.com/deymosh/codedeck-plus) — this monorepo (bridge + mobile)
- [codedeck-next-mobile](https://github.com/JeroenOnNostr/codedeck-next-mobile) — upstream Android app
- [codedeck-next-bridge](https://github.com/JeroenOnNostr/codedeck-next-bridge) — upstream headless CLI / VPS bridge

## License

MIT. A community continuation of CodeDeck Next by
[JeroenOnNostr](https://github.com/JeroenOnNostr) — original MIT license and
attribution preserved.
