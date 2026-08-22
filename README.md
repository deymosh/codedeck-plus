# CodeDeck Next — bridge (CLI)

The headless half of CodeDeck: it runs Claude Code sessions on your laptop or
VPS and exposes them to the [CodeDeck Next Android
app](https://github.com/JeroenOnNostr/codedeck-next-mobile) over end-to-end
encrypted Nostr.

**Current release: v0.9.5** — install from the [releases
page](https://github.com/JeroenOnNostr/codedeck-next-bridge/releases). This is
**not published on npm**, so `npx @codedeck/bridge` does not work.

## Quick start

```sh
npm i -g https://github.com/JeroenOnNostr/codedeck-next-bridge/releases/download/v0.9.5/codedeck-bridge-0.9.5.tgz

codedeck-bridge run
```

`run` serves pairing itself — it prints a QR code in the terminal; scan it
with the app. `claude` must be on `PATH` (the bridge does not bundle the
Agent SDK binary).

```sh
codedeck-bridge version
codedeck-bridge doctor     # environment + relay reachability check
```

For an always-on VPS bridge, a systemd unit ships in `apps/bridge-cli/deploy/`.

## Build from source

```sh
pnpm install
pnpm test
pnpm build
node apps/bridge-cli/out/main.js version
```

The published package is a single esbuild bundle: `@codedeck/core`,
`@codedeck/protocol` and `qrcode` are compiled in, and only the Claude Agent
SDK stays a runtime dependency.

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
