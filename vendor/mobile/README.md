# CodeDeck Next — mobile app

Control Claude Code sessions running on your laptop or VPS from your Android
phone, over end-to-end encrypted Nostr. No accounts and no central server: the
phone and the bridge pair directly by scanning a QR code.

**Current release: v0.9.5** — Android `com.codedeck.next`, available on
[Zapstore](https://zapstore.dev/apps/com.codedeck.next) or as a signed APK on
the [releases page](https://github.com/JeroenOnNostr/codedeck-next-mobile/releases).

## What it does

- Multiple concurrent Claude Code sessions, switchable from one screen
- Plan approval, permission cards and AskUserQuestion prompts on the phone
- Transcripts that survive restarts, offline gaps and reinstalls (ranged sync)
- Per-session model and effort selection, plus custom AI provider profiles
  (Kimi K3, OpenRouter, any Anthropic-compatible endpoint)
- Encrypted Nostr DMs — NIP-17 and Marmot (MLS) side by side
- Project/folder management on every paired bridge host

## You also need a bridge

The app is one half of a pair. Run one of these on the machine where Claude
Code lives:

- headless CLI / VPS —
  [codedeck-next-bridge](https://github.com/JeroenOnNostr/codedeck-next-bridge)
  (install from its release tarball; it is not on npm)
- the VSCode extension
  ([codedeck-next-bridge-vscode](https://github.com/JeroenOnNostr/codedeck-next-bridge-vscode))

Both speak protocol **v10 only**. This is a clean break from the original
CodeDeck (`com.codedeck.app`): different Android appId, so the two install
side by side, but pairings, history and settings do not carry over.

## Build from source

Requires Node 22, pnpm, Rust with the `aarch64-linux-android` target, JDK 21
and Android NDK 28.

```sh
pnpm install
pnpm test                      # full suite
pnpm --filter @codedeck/mobile build     # web assets only

# signed release APK (needs src-tauri/gen/android/keystore.properties)
./scripts/build-release-apk.sh
```

The mesh engine (`libnostr_vpn_app_core.so`) is cross-compiled from a
`nostr-vpn` checkout beside this repo; without it the Gradle task logs a
warning and the APK ships without mesh support.

## Repo layout

```
apps/<app>/          the app
packages/protocol/   wire types, kinds, ranges — the v10 protocol contract
packages/core/       bridge-side engine: nostr layer, SDK facade, transcripts
packages/testkit/    in-memory relay + phone simulator used by the tests
```

`packages/` is shared source, vendored identically into each of the three
CodeDeck Next repos. Treat it as one unit: a protocol change has to land in
all of them together or the app and its bridge stop understanding each other.

## Related repos

- [codedeck-next-mobile](https://github.com/JeroenOnNostr/codedeck-next-mobile) — Android app
- [codedeck-next-bridge](https://github.com/JeroenOnNostr/codedeck-next-bridge) — headless CLI / VPS bridge
- [codedeck-next-bridge-vscode](https://github.com/JeroenOnNostr/codedeck-next-bridge-vscode) — VSCode extension bridge

## License

MIT — see [LICENSE](./LICENSE).
