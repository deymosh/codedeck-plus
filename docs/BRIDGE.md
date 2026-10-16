# The bridge

The bridge runs coding agents (OpenCode, Claude Code, the DeepSeek
Harness and Qwen Code) on your laptop or VPS and serves them to the CodeDeck+ Android app
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
binaries are installed when chosen (see [Agent binaries](#agent-binaries)).
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
  `CODEDECK_OPENCODE_PATH` at the real binary (or let the bridge install one).
- There is no service unit: run it in a terminal, or start it at logon with
  Task Scheduler. Under WSL2, the Linux archive works as on Linux.

Claude Code authenticates with `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`,
an existing `claude` login, or a key set from the phone; see
[`CLAUDE-CODE.md`](CLAUDE-CODE.md). The DeepSeek Harness
uses `DEEPSEEK_API_KEY` — or a session's provider profile, for a gateway — and
keeps its own state under `<home>/dsh`; see [`DEEPSEEK.md`](DEEPSEEK.md).

### Agent binaries

The archives leave out the agents' own CLI binaries (a couple of hundred MB
each), and a bridge installs an agent only when someone chooses it. Every
agent the bridge knows is listed on the phone, each in one of four states:

- **ready** — it runs sessions. Either the machine has it of its own (its
  path setting, then `PATH` and the usual install locations; for OpenCode,
  also a server URL) or CodeDeck installed it.
- **not installed** — the phone offers Install, on the machine's page and in
  New session.
- **installing** — no new session starts on it until it is ready; one
  resuming after an agent host restart waits for the install, then starts.
- **failed** — with the reason; the phone offers Retry.

OpenCode is the default agent: a bridge that has none installs it when it
first starts, unless it was removed before. Nothing else is installed until
asked for:

- **Claude Code**: the Agent SDK's platform package, at the version the SDK
  is locked to (about 100 MB).
- **OpenCode**: its `@opencode/cli-<os>-<arch>` build (about 200 MB). A server URL
  (`CODEDECK_OPENCODE_SERVER_URL`) needs nothing installed.
- **The DeepSeek Harness**: not one binary but a package tree — some 600
  packages, a few hundred MB, a couple of minutes on a normal connection.
  `CODEDECK_DEEPSEEK_PATH` names a CLI to use instead.
- **Qwen Code**: a package tree too (`@qwen-code/qwen-code`);
  `CODEDECK_QWEN_PATH` names a CLI to use instead.

Every download comes from the npm registry and is checked against the sha512
in this build's `pnpm-lock.yaml`; a mismatch is refused. Binaries live in
`<home>/agents/`, one version per package, and the harness's tree in
`<home>/agents/@deepseek-ai+dsh@<version>/`; an upgrade that moves the pin
installs the new one and removes the old.

Removing an agent (from the phone, or `codedeck-bridge agents remove`) ends
its sessions and deletes what CodeDeck installed of it. Its own settings and
conversations stay, and an agent the machine has of its own cannot be
removed. A removed default agent is not installed again until someone asks
for it.

- Ahead of time: `codedeck-bridge agents install <agent>…` installs from the
  terminal, into the same cache, before any phone asks.
- Offline machines: install `claude` (or `opencode`) yourself and it is used
  as is, point `CODEDECK_DEEPSEEK_PATH` (or `CODEDECK_QWEN_PATH`) at one you
  installed, or copy an
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
build with `CODEDECK_BUNDLE_AGENTS=1` in `.env`: the image then carries
Claude Code, OpenCode and the DeepSeek Harness (not Qwen Code), and they reach the volume when it is first created; a volume
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
| `agents list` | Every agent and where it stands on this machine: ready (and from where), not installed, or removed. |
| `agents install <agent>…` / `agents remove <agent>…` | Install agents at the version this build pins, or remove what CodeDeck installed of them. A running bridge sees the change once its agent host restarts; the phone's Install and Remove take effect at once. |
| `terminal pending` | The devices that asked for a terminal and were refused, with their id, name and when they were last seen. |
| `terminal allow <id>` / `terminal disallow <id>` | Approve a device for a terminal, or withdraw it (an unambiguous id prefix works). These edit the allowlist file directly, so they work while the bridge runs; a withdrawn device's terminals close at once. |
| `audit verify` | Recompute the terminal audit's hash chain; prints the line count and the head hash (compare it with the syslog copy or a value noted earlier), or the first broken line and exits non-zero. |
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
| `openCodeServerUrl`, `openCodePath`, `openCodePort` | `CODEDECK_OPENCODE_*` | The OpenCode server: an external one, or how the bridge runs its own — see [`OPENCODE.md`](OPENCODE.md) |
| `deepseekPath` | `CODEDECK_DEEPSEEK_PATH` / `--deepseek-path` | A DeepSeek Harness CLI to run instead of the one this build installs — see [`DEEPSEEK.md`](DEEPSEEK.md) |
| `relayRegisterEndpoint` / `relayRegisterToken` | `CODEDECK_RELAY_REGISTER_ENDPOINT` / `..._TOKEN` | Register paired phones on a write-restricted relay (https only — the token is an admin secret) |
| `blossomRegisterEndpoint` / `blossomRegisterToken` | `CODEDECK_BLOSSOM_REGISTER_ENDPOINT` / `..._TOKEN` | The same for a Blossom server, so a phone's attachments do not fall back to relay chunking |
| `transcriptKeepLast` | `CODEDECK_TRANSCRIPT_KEEP_LAST` | Entries kept per session transcript (default 5000; 0 keeps all) |
| `agentHostPath`, `nodePath` | `CODEDECK_AGENT_HOST` / `--agent-host`, `CODEDECK_NODE_PATH` | Where the agent host and Node are (defaults: `agent-host/` beside the binary; the `node` beside the binary, else `node` on `PATH`) |
| `direct.listen` | `CODEDECK_DIRECT_LISTEN` / `--direct-listen` | Serve phones directly over `wss://` on this `ip:port` (e.g. `0.0.0.0:7447`); off by default |
| `direct.onionListen` | `CODEDECK_DIRECT_ONION_LISTEN` / `--direct-onion-listen` | A plain `ws://` listener for an onion service to forward to; loopback only (e.g. `127.0.0.1:7448`) |
| `direct.endpoints` | `CODEDECK_DIRECT_ENDPOINTS` / `--direct-endpoint` | The URLs phones dial, in order: `wss://host:port`, or `ws://<name>.onion:port` (default: the `wss://` listener's LAN address; none in a container, which only sees its own) |
| `terminal.enabled` | `CODEDECK_TERMINAL` / `--terminal` | Run terminals on this bridge — see [Terminal](#terminal) (default: off) |
| `terminal.relays`, `terminal.idleMinutes`, `terminal.maxTerminals`, `terminal.command` | — | Whether a terminal may open over a relay, how long an unattended one lives (default 60, up to 1440 minutes, 0 keeps it), how many run at once (default 4), and a fixed program to run instead of the user's shell |
| `audit.maxDays`, `audit.maxBytes`, `audit.syslog` | — | Terminal recording retention (default 90 days / 1 GiB, 0 = no limit) and whether each audit line is also copied to the system log (default: off) |

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

### Web page

With the direct link listening on `wss://`, the same port serves a web page
for a browser: open `https://<address>:7447/` (the bridge logs it at start,
`[Web] The bridge's web page: …`). The browser gets the same self-signed
certificate as the phone, so it shows a certificate warning; compare the
SHA-256 it shows with the one `[Direct] Listening on …` logs before
accepting it. Plain `http://` on the port redirects to
`https://`; the onion listener serves no page.

A browser signs in with a paired phone: the page shows a code and a QR, and
on the phone the machine's page, "Sign in a browser", scans or types it. The
browser then stays signed in for 30 days (a cookie only the bridge can read,
sent only over HTTPS), and it survives a restart: signed-in browsers are kept
in `<home>/web-sessions.json`, keyed by the cookie's SHA-256 so the file
holds no token a copy could be replayed from. Signing out, or revoking one
from the page, ends it; a pending sign-in is never written. Until signed in
it sees only the sign-in page. The page shows what the heartbeat carries —
the bridge, the direct link, the agents and their credential status, the
sessions — and never a secret.

Signed in, the page also has a few JSON APIs: `GET /api/browsers` lists the
signed-in browsers (each with its id, approver, sign-in and last-seen times,
expiry, address and User-Agent, and which is the caller) and
`POST /api/browsers/sign-out` ends one; `GET /api/devices` shows the paired
identities and their clients (labels and key expiries, never a key);
`GET /api/config` shows the config as it is in effect (a secret only as
set/not set, and each field whether a flag or environment variable overrides
the file) and `POST /api/config` changes the safe set — the machine name,
the relays, the direct endpoints, the transcript retention and the relay /
Blossom registration tokens — validating each and rewriting `config.json`
keeping every other key.

Because a LAN or VPN is not a trusted place, the page refuses a `Host` that
is not an IP address, `localhost` or a host the direct endpoints name,
requires an `Origin` equal to its own on every `POST`, forbids framing,
caching and any script or connection not its own, rate-limits sign-in starts
to 10 a minute per address, and caps pending codes and signed-in browsers.

## Terminal

A phone can open a real terminal on the bridge: a shell in a pseudo-terminal
as the bridge's own user, drawn by the app's terminal emulator, so an editor,
`htop` or `git add -p` work as they would over SSH. It is strictly more than
an agent in its most permissive mode, so it is off until the owner turns it on
and every device must be approved. The full design is in
[`TERMINAL.md`](TERMINAL.md).

**Enable it** with `terminal.enabled` in `config.json`, `--terminal`, or
`CODEDECK_TERMINAL=1`. The bridge then advertises the capability and the phone
shows Terminal. With it off, every terminal message is refused. Terminals take
the direct link by default (LAN, VPN, or an onion endpoint through Orbot);
`terminal.relays: true` also lets them fall back to a relay, at the cost of a
relay seeing each event's size and timing.

**Approve devices.** The identity key is shared by every client of an
identity, so a device is named by the first session key it granted this bridge
(an id that survives rotation) and approved on the machine. When a device that
is not approved asks, the bridge refuses it and records it; the phone shows
the id and name and the command to run:

```sh
codedeck-bridge terminal pending          # refused devices: id, name, last seen
codedeck-bridge terminal allow 1a2b3c4d   # approve (an unambiguous id prefix works)
codedeck-bridge terminal disallow 1a2b3c4d
```

These edit `<home>/terminal-allow.json` (owner-only, written atomically) and
work while the bridge runs: it re-reads the file — cached by its modification
time — on the next terminal message and within a few seconds otherwise.
**Withdrawing a device closes its terminals at once**, the kill switch for a
lost phone.

**What is recorded.** Under `<home>/audit/` (`0700`, files `0600`):

- `terminal.jsonl` — one JSON line per event (opened, attached, takeover,
  resized, closed, exited, refused), each with the device, identity, transport
  and reason. Every line carries `prev`, the SHA-256 of the line before it (the
  first line's is all zeros), so an edited or deleted line breaks the chain:
  `codedeck-bridge audit verify` recomputes it and prints the line count and
  the head (the last line's SHA-256), or the first broken line, exiting
  non-zero. The chain catches an edit or a deletion in the middle; the last
  line and a truncation need the syslog copy or a noted head hash. The honest
  limit: anyone running as the bridge's user can rewrite the whole file, chain
  and all. The chain catches tampering that is not that thorough;
  `audit.syslog: true` also copies each line to the log target `audit`
  (journald / rsyslog, if a handler forwards it), which survives even that.
- `term-<id>.cast` — a full recording of each terminal in asciicast v2
  (replayable with `asciinema play`). Input typed at a password prompt is
  recorded as a byte count, never the bytes.

**Retention** removes the oldest whole recordings under `audit/` when they are
older than `audit.maxDays` (default 90) or while the directory is larger than
`audit.maxBytes` (default 1 GiB); 0 means no limit. `terminal.jsonl` is kept —
it is small and is the record of who opened what.

## Files

In `<home>`:

- `state.json` — the bridge identity key, paired phones, phone-set credentials
  and provider profiles, the session registry. Owner-only (0600, directory
  0700). Keep it private and back it up: losing it means pairing again.
- `sessions/transcripts/<session>.jsonl` — one transcript per session.
- `bridge.lock` — held while a bridge runs, so two never share one identity;
  `bridge.pid` beside it names the process holding it.
- `config.json` — optional; tightened to 0600 when read (it may hold admin tokens).
- `web-sessions.json` — the signed-in browsers of the web page, keyed by the
  cookie's SHA-256 (never a token), 0600. Deleting it signs every browser out.
- `direct/cert.der`, `direct/key.der` — the direct link's certificate and its
  key (0600). Deleting them makes a new one; phones pick up the new pin from
  the next heartbeat.
- `terminal-allow.json` — the devices approved for a terminal, and the ones
  refused (0600). See [Terminal](#terminal).
- `audit/` — the terminal audit: `terminal.jsonl` and the `term-*.cast`
  recordings (0700, files 0600).

## Build from source

```sh
cargo build --release -p bridge-runtime            # -> target/release/codedeck-bridge
pnpm install && pnpm --filter @codedeck/agent-host run build
./target/release/codedeck-bridge run --agent-host packages/agent-host/dist/main.js
```

Or with no toolchain at all, `./codedeck check` runs every check in Docker —
and with no Docker either (Linux), it installs the local toolchain
(`scripts/install-toolchain.sh`) on first use and runs the checks with it.
