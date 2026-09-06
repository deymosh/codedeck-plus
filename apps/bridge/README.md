# @codedeck/bridge

Headless CodeDeck bridge (protocol v10): run Claude Code sessions on a laptop
or VPS and drive them from the CodeDeck Android app over end-to-end encrypted
Nostr (NIP-44). This is the CLI/systemd sibling of the CodeDeck VSCode
extension — same engine (`@codedeck/core`), no editor required.

## Quickstart

This package is **not on the npm registry** — install it from the release
tarball attached to each CodeDeck+ GitHub release:

```sh
npm i -g https://github.com/deymosh/codedeck-plus/releases/download/v0.10.0/codedeck-bridge-0.10.0.tgz

codedeck-bridge run     # run the bridge, serving pairing (Ctrl-C to stop)
codedeck-bridge pair    # pairing window only: terminal QR + pairing URL
```

Requires Node ≥ 20 and the `claude` CLI on PATH (or `--claude-path`). Scan the
QR with the CodeDeck app (or paste the pairing link / bridge npub manually).
Pairing survives restarts; `run` resumes previously known sessions on boot.

## Commands

| Command | What it does |
|---|---|
| `run` | Connect to the relays and serve paired phones (default command) |
| `pair` | Open a 10-minute pairing window: terminal QR + pairing URL |
| `status` | Show config, identity (npub), paired phones, run state |
| `unpair <npub\|hex\|label>` / `unpair --all` | Remove pairings |
| `folders` | List project folders phones can start sessions in |
| `version` / `doctor` | Diagnostics |

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

## VPS / systemd

A hardened unit ships in the package at `deploy/codedeck-bridge.service` —
its header comments are the install runbook (dedicated `codedeck` user,
`/etc/codedeck-bridge/env` for `CODEDECK_*` overrides, pair with the service
stopped because the state-file lock refuses a double run).
