# The bridge

The bridge runs coding agents (Claude Code, OpenCode and the DeepSeek
Harness) on your laptop or VPS and serves them to the CodeDeck+ Android app
over end-to-end encrypted Nostr (NIP-44). No accounts and no central server: the phone and the
bridge pair by scanning a QR code.

It is one binary, `codedeck-bridge` (Rust), plus its **agent host**
(`agent-host/`, a Node program that runs the agents' SDKs). The binary starts
the agent host itself; you never run it directly.

## Install

**Docker** (from the repo root): `docker compose up -d --build`, or
`./codedeck bridge up`. See the root README for the `.env` it reads.

**A release archive** — `codedeck-bridge-vX.Y.Z-linux-<x86_64|aarch64>.tar.xz`
from the [releases](https://github.com/deymosh/codedeck-plus/releases). It
bundles the binary, its agent host and a Node runtime; the agents' own
binaries are installed on first use (see [Agent binaries](#agent-binaries)).
The binary needs glibc 2.35 or newer (Ubuntu 22.04+, Debian 12+).

```sh
tar -xJf codedeck-bridge-vX.Y.Z-linux-x86_64.tar.xz
cd codedeck-bridge-vX.Y.Z-linux-x86_64
./codedeck-bridge run
```

To put it on `PATH`, extract it somewhere stable (e.g. `/opt/codedeck-bridge`)
and symlink the binary: it finds its agent host and Node through the symlink.
Upgrading is extracting the new archive over the old one.

**Windows** — `codedeck-bridge-vX.Y.Z-windows-x86_64.zip`, the same bundle
(`codedeck-bridge.exe`, its agent host, `node.exe`). Extract it and run
`codedeck-bridge.exe run` from a terminal; state lives in
`%USERPROFILE%\.codedeck`. Things that differ from Linux:

- Claude Code's Bash tool needs [Git for Windows](https://git-scm.com/downloads/win)
  (set `CLAUDE_CODE_GIT_BASH_PATH` if its `bash.exe` is not found).
- The state and config files get no extra permission tightening: they rely
  on the user profile folder being private to your account, as it is by
  default.
- An existing OpenCode is found on `PATH` only as `opencode.exe`; npm's
  global install adds just an `opencode.cmd` shim, so point
  `CODEDECK_OPENCODE_PATH` at the real binary (or let auto-start install one).
- There is no service unit: run it in a terminal, or start it at logon with
  Task Scheduler. Under WSL2, the Linux archive works as on Linux.

Claude Code authenticates with `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`,
an existing `claude` login, or a key set from the phone. The DeepSeek Harness
uses `DEEPSEEK_API_KEY` — or a session's provider profile, for a gateway — and
keeps its own state under `<home>/dsh`; see [`DEEPSEEK.md`](DEEPSEEK.md).

### Agent binaries

The archives leave out the agents' own CLI binaries (a couple of hundred MB
each). An agent uses one already on the machine — its path setting, then
`PATH` and the usual install locations — and otherwise the agent host
installs it on first use:

- **Claude Code**: always, the Agent SDK's platform package, at the version
  the SDK is locked to.
- **OpenCode**: when auto-start is on (`CODEDECK_OPENCODE_AUTO_START=1`) and
  no `opencode` is found; a server URL instead needs nothing installed.
- **The DeepSeek Harness**: always, unless `CODEDECK_DEEPSEEK_PATH` names a
  CLI to use instead. It is not one binary but a package tree, so this is the
  bigger download by far — some 600 packages, a few hundred MB.

The download starts in the background as the bridge starts, so the agents
are listed at once and a first session waits for it (about 100 MB for Claude
Code, 60 MB for OpenCode, and a couple of minutes for the harness on a normal
connection). It comes from the npm registry and is checked against the sha512
in this build's `pnpm-lock.yaml`; a mismatch is refused. Binaries live in
`<home>/agents/`, one version per package, and the harness's tree in
`<home>/agents/@deepseek-ai+dsh@<version>/`; an upgrade that moves the pin
installs the new one and removes the old. A failed download (no network) is
retried by the next session.

`CODEDECK_AGENT_HOST_WARM=1` installs everything the enabled agents need and
exits, without serving: a first-run warm-up, and what the image's bundled
build runs at build time.

- Offline machines: install `claude` (or `opencode`) yourself and it is used
  as is, point `CODEDECK_DEEPSEEK_PATH` at a harness you installed, or copy an
  `agents/` directory from another machine.
- A mirror: `CODEDECK_NPM_REGISTRY=https://…` (the sha512 still applies).
- An HTTP(S) proxy for the download: Node reads `HTTPS_PROXY` only with
  `NODE_USE_ENV_PROXY=1` set. The Tor proxy is for relay traffic only and is
  not used here.

The container image works the same way, with the binaries in
`/data/agents` — which the compose file keeps in a volume of Docker's own
(`agents`), not in `./data` — so a container recreated from a newer image
reuses them until the pin moves. A volume rather than the host directory for
two reasons: Docker fills a volume from the image when it is first created
(a host directory it never fills), and on Docker Desktop a host directory is
a file share slow enough to dominate a runtime of hundreds of packages (the
DeepSeek Harness boots in about a second from the volume and in about 25 from
`./data`). `/data/agents/bin` holds each one under a stable name and is on
the container's `PATH`, so `docker compose exec codedeck-bridge claude …` (or
`opencode …`) works once it is installed. For a host without internet access,
build with `CODEDECK_BUNDLE_AGENTS=1` in `.env`: the image then carries all
three agents, and they reach the volume when it is first created; a volume
that already exists keeps the agents already in it.

The links in `<home>/agents/bin` are for people. The agent host never uses
them to find an agent, because after an upgrade they may still point at the
previous version until the new one is installed.

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
`--home` / `CODEDECK_HOME`, default `~/.codedeck` (`/data` in the container
image). [`config.example.json`](../config.example.json) at the repository
root sets every `config.json` key (a test keeps it complete); copy the ones
you need.

| config.json key | env / flag | meaning |
|---|---|---|
| `machineName` | `CODEDECK_MACHINE_NAME` / `--machine-name` | Name shown on the phone (default `<hostname> (cli)`) |
| `relays` | `CODEDECK_RELAYS` / `--relay` | Relay URLs (default: the CodeDeck relays) |
| `workspaceRoots` | `CODEDECK_WORKSPACE_ROOTS` / `--workspace` | Directories sessions may run in (default: `workspaces/` in the bridge home, created on start; pass `--workspace .` to serve the working directory) |
| `torProxyUrl` | `CODEDECK_TOR_PROXY_URL` / `--tor-proxy` | SOCKS5 proxy (e.g. `socks5h://127.0.0.1:9050`) for the relay connections |
| `claudePath` | `CODEDECK_CLAUDE_PATH` / `--claude-path` | A specific `claude` binary instead of the bundled one |
| `openCodeServerUrl`, `openCodeAutoStart`, `openCodePath`, `openCodePort` | `CODEDECK_OPENCODE_*` | The optional OpenCode agent — see [`OPENCODE.md`](OPENCODE.md) |
| `deepseekPath` | `CODEDECK_DEEPSEEK_PATH` / `--deepseek-path` | A DeepSeek Harness CLI to run instead of the one this build installs — see [`DEEPSEEK.md`](DEEPSEEK.md) |
| `relayRegisterEndpoint` / `relayRegisterToken` | `CODEDECK_RELAY_REGISTER_ENDPOINT` / `..._TOKEN` | Register paired phones on a write-restricted relay (https only — the token is an admin secret) |
| `blossomRegisterEndpoint` / `blossomRegisterToken` | `CODEDECK_BLOSSOM_REGISTER_ENDPOINT` / `..._TOKEN` | The same for a Blossom server, so a phone's attachments do not fall back to relay chunking |
| `transcriptKeepLast` | `CODEDECK_TRANSCRIPT_KEEP_LAST` | Entries kept per session transcript (default 5000; 0 keeps all) |
| `agentHostPath`, `nodePath` | `CODEDECK_AGENT_HOST` / `--agent-host`, `CODEDECK_NODE_PATH` | Where the agent host and Node are (defaults: `agent-host/` beside the binary; the `node` beside the binary, else `node` on `PATH`) |
| `direct.listen` | `CODEDECK_DIRECT_LISTEN` / `--direct-listen` | Serve phones directly over `wss://` on this `ip:port` (e.g. `0.0.0.0:7447`); off by default |
| `direct.onionListen` | `CODEDECK_DIRECT_ONION_LISTEN` / `--direct-onion-listen` | A plain `ws://` listener for an onion service to forward to; loopback only (e.g. `127.0.0.1:7448`) |
| `direct.endpoints` | `CODEDECK_DIRECT_ENDPOINTS` / `--direct-endpoint` | The URLs phones dial, in order: `wss://host:port`, or `ws://<name>.onion:port` (default: the `wss://` listener's LAN address; none in a container, which only sees its own) |

When a Tor proxy is set, all Nostr traffic goes through it: relay
connections, file downloads from a Blossom server, and pubkey registration on
the relay's or Blossom server's admin endpoint (loopback endpoints excepted).
Without one those go direct and a `.onion` cannot be reached; `http://` is
accepted only for a `.onion`. The agents' own API calls and provider token
checks never use the proxy.

### Direct link

With `direct.listen` set, phones on the same network (or VPN) talk to the
bridge over its own WebSocket instead of through a relay; the relays keep
carrying everything, so a phone that cannot reach an endpoint simply stays
on them. The listener serves a self-signed certificate made once in
`<home>/direct/`; its SHA-256 rides the heartbeat and the phone pins it, so
private addresses and VPN host names (Tailscale MagicDNS, WireGuard) work
without a CA. Only paired phones get past the handshake. List every address
a phone might use, in the order to try, e.g.
`--direct-endpoint wss://192.168.1.20:7447 --direct-endpoint wss://laptop.tail1234.ts.net:7447`,
or in `config.json` (a nested object; the bridge warns about keys it does
not know):

```json
{ "direct": { "listen": "0.0.0.0:7447", "endpoints": ["wss://192.168.1.20:7447"] } }
```

At start the bridge logs `[Direct] Listening on …` and one
`[Direct] Advertising …` per endpoint, or `[Direct] Off` without a listener.

For a phone on Orbot, run an onion service that forwards to
`direct.onionListen` (Tor: `HiddenServicePort 7448 127.0.0.1:7448`) and add
`ws://<name>.onion:7448` to the endpoints; the phone dials `.onion`
endpoints through Orbot (and skips them without it), and LAN or VPN ones
directly either way. An onion service on another host or container
(the Compose `codedeck-tor` one) cannot reach that loopback listener: point
it at the `wss://` listener instead (`HiddenServicePort 7447
codedeck-bridge:7447`) and advertise `wss://<name>.onion:7447`; the phone
pins the certificate through Tor all the same. See
[`PROTOCOL.md`](PROTOCOL.md#direct-link).

Under Docker Compose the direct link is on by default: the first start
writes `direct.listen` `0.0.0.0:7447` into `data/config.json`, and the
compose file publishes the port. Inside a container the bridge sees only its
own container address, so it advertises none (the certificate pin still rides
the heartbeat): add the host's addresses to `direct.endpoints`, or on the
phone, in the machine's settings. To turn the link off, remove `direct` from
`config.json`.

## Files

In `<home>`:

- `state.json` — the bridge identity key, paired phones, phone-set credentials
  and provider profiles, the session registry. Owner-only (0600, directory
  0700). Keep it private and back it up: losing it means pairing again.
- `sessions/transcripts/<session>.jsonl` — one transcript per session.
- `bridge.lock` — held while a bridge runs, so two never share one identity;
  `bridge.pid` beside it names the process holding it.
- `config.json` — optional; tightened to 0600 when read (it may hold admin tokens).
- `direct/cert.der`, `direct/key.der` — the direct link's certificate and its
  key (0600). Deleting them makes a new one; phones pick up the new pin from
  the next heartbeat.

## Build from source

```sh
cargo build --release -p bridge-runtime            # -> target/release/codedeck-bridge
pnpm install && pnpm --filter @codedeck/agent-host run build
./target/release/codedeck-bridge run --agent-host packages/agent-host/dist/main.js
```

Or with no toolchain at all, `./codedeck check` runs every check in Docker.
