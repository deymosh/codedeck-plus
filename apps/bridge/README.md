# CodeDeck+ — bridge (CLI)

The headless half of CodeDeck: it runs Claude Code sessions on your laptop or
VPS and exposes them to the [CodeDeck+ Android app](../mobile/README.md) over
end-to-end encrypted Nostr (NIP-44). No accounts and no central server — the
phone and the bridge pair directly by scanning a QR code.

`@codedeck/bridge` is the CLI / systemd connector — same engine (`@codedeck/core`)
as the CodeDeck VSCode extension, no editor required. Protocol **v10**. **Not on
the npm registry**: install from the tarball attached to each
[GitHub release](https://github.com/deymosh/codedeck-plus/releases).

## Quickstart

```sh
npm i -g https://github.com/deymosh/codedeck-plus/releases/download/v0.10.0/codedeck-bridge-0.10.0.tgz

codedeck-bridge run     # run the bridge, serving pairing (Ctrl-C to stop)
codedeck-bridge pair    # pairing window only: terminal QR + pairing URL
```

Requires Node ≥ 20 and the `claude` CLI on `PATH` (or `--claude-path`) — the
bridge does not bundle the Agent SDK binary. Scan the QR with the CodeDeck app
(or paste the pairing link / bridge npub manually). Pairing survives restarts;
`run` resumes previously known sessions on boot.

## Commands

| Command | What it does |
|---|---|
| `run` | Connect to the relays and serve paired phones (default command) |
| `pair` | Open a 10-minute pairing window: terminal QR + pairing URL |
| `status` | Show config, identity (npub), paired phones, run state |
| `unpair <npub\|hex\|label>` / `unpair --all` | Remove pairings |
| `folders` | List project folders phones can start sessions in |
| `version` | Print the bridge version |
| `doctor` | Environment + relay-reachability check |

## Configuration

Precedence: flags > environment > `<home>/config.json` > defaults.
Home directory: `--home` / `CODEDECK_HOME`, default `~/.codedeck`.

| config.json key | env | meaning |
|---|---|---|
| `machineName` | `CODEDECK_MACHINE_NAME` | Name shown on the phone (default `<hostname> (cli)`) |
| `relays` | `CODEDECK_RELAYS` | Relay URLs (default: the CodeDeck relays) |
| `workspaceRoots` | `CODEDECK_WORKSPACE_ROOTS` | Directories sessions may run in (default: cwd) |
| `claudePath` | `CODEDECK_CLAUDE_PATH` | Explicit `claude` binary |
| `relayRegisterEndpoint` / `relayRegisterToken` | `CODEDECK_RELAY_REGISTER_ENDPOINT` / `..._TOKEN` | Auto-register paired phones on a write-restricted relay (https enforced — the token is an admin secret; prefer config/env over the CLI flag, which leaks into `ps`) |
| `blossomRegisterEndpoint` / `blossomRegisterToken` | `CODEDECK_BLOSSOM_REGISTER_ENDPOINT` / `..._TOKEN` | CDX-093: auto-register paired phones on the Blossom media server so image upload does not fall back to relay chunking. Same admin contract, same https enforcement, separate token — the two servers share a KV but not a write policy |
| `nvpnPath`, `meshAdminEnabled`, `adbPath` | `CODEDECK_NVPN_PATH`, `CODEDECK_MESH_ADMIN`, `CODEDECK_ADB_PATH` | Mesh + on-device test tooling (optional) |
| `transcriptKeepLast` | `CODEDECK_TRANSCRIPT_KEEP_LAST` | Per-session transcript retention cap (default 5000 entries; 0 disables) |

Secrets: the bridge identity key and phone-set credentials live in
`<home>/state.json` (mode 0600, dir 0700). `config.json` is chmod'd 0600 on
load because it may hold the relay admin token.

## Run it

**Docker** (from the repo root): `docker compose up -d --build` builds
`docker/Dockerfile` and runs the bridge as a hardened container; `./codedeck
bridge up` / `logs` / `pair` wrap the compose commands. See the root README.

**systemd**: a hardened unit ships in the package at
`deploy/codedeck-bridge.service` — its header comments are the install runbook
(dedicated `codedeck` user, `/etc/codedeck-bridge/env` for `CODEDECK_*`
overrides, pair with the service stopped because the state-file lock refuses a
double run).

## Build from source

No host toolchain is required — the checks run in Docker via the repo-root
`./codedeck` wrapper:

```sh
./codedeck check            # typecheck + test, every package
./codedeck bridge up        # build + run the containerised bridge
```

With a native Node 22 + pnpm toolchain:

```sh
pnpm install
pnpm --filter @codedeck/bridge run test
pnpm build:bridge           # -> apps/bridge/out/main.js
node apps/bridge/out/main.js version
```

The published package is a single esbuild bundle: `@codedeck/core`,
`@codedeck/protocol` and `qrcode` are compiled in, and only the Claude Agent
SDK stays a runtime dependency. `packages/protocol` is the v10 wire contract —
a protocol change has to land there and be understood by both the bridge and
the app together, or they stop talking.

## Related repos

- [deymosh/codedeck-plus](https://github.com/deymosh/codedeck-plus) — this monorepo (bridge + mobile)
- [codedeck-next-bridge](https://github.com/JeroenOnNostr/codedeck-next-bridge) — upstream headless CLI / VPS bridge
- [codedeck-next-mobile](https://github.com/JeroenOnNostr/codedeck-next-mobile) — upstream Android app

## License

MIT. A community continuation of CodeDeck Next by
[JeroenOnNostr](https://github.com/JeroenOnNostr) — original MIT license and
attribution preserved.
