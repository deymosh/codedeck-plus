# The bridge

The bridge runs coding agents (Claude Code, and optionally OpenCode) on your
laptop or VPS and serves them to the CodeDeck+ Android app over end-to-end
encrypted Nostr (NIP-44). No accounts and no central server: the phone and the
bridge pair by scanning a QR code.

It is one binary, `codedeck-bridge` (Rust), plus its **agent host**
(`agent-host/`, a Node program that runs the agents' SDKs). The binary starts
the agent host itself; you never run it directly.

## Install

**Docker** (from the repo root): `docker compose up -d --build`, or
`./codedeck bridge up`. See the root README for the `.env` it reads.

**A release archive** — `codedeck-bridge-vX.Y.Z-linux-<x86_64|aarch64>.tar.gz`
from the [releases](https://github.com/deymosh/codedeck-plus/releases):

```sh
tar -xzf codedeck-bridge-vX.Y.Z-linux-x86_64.tar.gz
cd codedeck-bridge-vX.Y.Z-linux-x86_64
./codedeck-bridge run
```

It needs Node 22 or newer on `PATH` (for the agent host). The Claude Code
binary is included; it authenticates with `ANTHROPIC_API_KEY`,
`CLAUDE_CODE_OAUTH_TOKEN`, an existing `claude` login, or a key set from the
phone.

**systemd:** `deploy/codedeck-bridge.service` — its header comments are the
install runbook.

## Commands

| Command | What it does |
|---|---|
| `run` | Connect to the relays and serve paired phones (the default). While no phone is paired it keeps a pairing window open and prints its QR. |
| `pair` | Open one 10-minute pairing window: terminal QR + pairing URL. |
| `status` | Config, identity (npub), paired phones, whether a bridge is running. |
| `unpair <npub\|hex\|label>` / `unpair --all` | Remove pairings (with the bridge stopped). |
| `folders` | The project folders a phone can start sessions in. |
| `version` | The bridge version and protocol version. |

`--test-mode` (or `CODEDECK_TEST_MODE=1`) makes the agents answer canned
commands (`/test-message`, `/test-tool`, `/test-plan`, `/test-question`) with no
API key — for trying the phone flows.

## Configuration

Precedence: flags > environment > `<home>/config.json` > defaults. Home:
`--home` / `CODEDECK_HOME`, default `~/.codedeck`.

| config.json key | env / flag | meaning |
|---|---|---|
| `machineName` | `CODEDECK_MACHINE_NAME` / `--machine-name` | Name shown on the phone (default `<hostname> (cli)`) |
| `relays` | `CODEDECK_RELAYS` / `--relay` | Relay URLs (default: the CodeDeck relays) |
| `workspaceRoots` | `CODEDECK_WORKSPACE_ROOTS` / `--workspace` | Directories sessions may run in (default: the working directory) |
| `torProxyUrl` | `CODEDECK_TOR_PROXY_URL` / `--tor-proxy` | SOCKS5 proxy (e.g. `socks5h://127.0.0.1:9050`) for the relay connections |
| `claudePath` | `CODEDECK_CLAUDE_PATH` / `--claude-path` | A specific `claude` binary instead of the bundled one |
| `openCodeServerUrl`, `openCodeAutoStart`, `openCodePath`, `openCodePort` | `CODEDECK_OPENCODE_*` | The optional OpenCode agent — see [`OPENCODE.md`](OPENCODE.md) |
| `relayRegisterEndpoint` / `relayRegisterToken` | `CODEDECK_RELAY_REGISTER_ENDPOINT` / `..._TOKEN` | Register paired phones on a write-restricted relay (https only — the token is an admin secret) |
| `blossomRegisterEndpoint` / `blossomRegisterToken` | `CODEDECK_BLOSSOM_REGISTER_ENDPOINT` / `..._TOKEN` | The same for the image server, so uploads do not fall back to relay chunking |
| `nvpnPath`, `meshAdminEnabled`, `adbPath` | `CODEDECK_NVPN_PATH`, `CODEDECK_MESH_ADMIN`, `CODEDECK_ADB_PATH` | Mesh onboarding and on-device test tools (optional) |
| `transcriptKeepLast` | `CODEDECK_TRANSCRIPT_KEEP_LAST` | Entries kept per session transcript (default 5000; 0 keeps all) |
| `agentHostPath`, `nodePath` | `CODEDECK_AGENT_HOST` / `--agent-host`, `CODEDECK_NODE_PATH` | Where the agent host and Node are (defaults: `agent-host/` beside the binary, `node` on `PATH`) |

The Tor proxy carries relay traffic only; the agents' own API calls and the
bridge's HTTP checks go direct.

## Files

In `<home>`:

- `state.json` — the bridge identity key, paired phones, phone-set credentials
  and provider profiles, the session registry. Owner-only (0600, directory
  0700). Keep it private and back it up: losing it means pairing again.
- `sessions/transcripts/<session>.jsonl` — one transcript per session.
- `bridge.lock` — held while a bridge runs, so two never share one identity.
- `config.json` — optional; tightened to 0600 when read (it may hold admin tokens).

## Build from source

```sh
cargo build --release -p bridge-runtime            # -> target/release/codedeck-bridge
pnpm install && pnpm --filter @codedeck/agent-host run build
./target/release/codedeck-bridge run --agent-host packages/agent-host/dist/main.js
```

Or with no toolchain at all, `./codedeck check` runs every check in Docker.
