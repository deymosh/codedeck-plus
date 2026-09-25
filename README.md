<div align="center">

<img src="docs/logo.png" alt="CodeDeck+" width="112" height="112">

# CodeDeck+

**Control coding agents (Claude Code, OpenCode) running on your laptop or VPS
from your Android phone, over end-to-end encrypted Nostr.** No accounts and no
CodeDeck server: the phone and the bridge pair by scanning a QR code and talk
through ordinary Nostr relays — public ones, or your own.

[![CI](https://github.com/deymosh/codedeck-plus/actions/workflows/ci.yml/badge.svg)](https://github.com/deymosh/codedeck-plus/actions/workflows/ci.yml)
[![latest release](https://img.shields.io/github/v/release/deymosh/codedeck-plus?sort=semver&label=release)](https://github.com/deymosh/codedeck-plus/releases/latest)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

---

## What it does

Two halves exchange NIP-44 encrypted messages through one or more Nostr relays
of your choice. The relays only store and forward ciphertext: they cannot read
your sessions, and no account or CodeDeck-run service sits in between.

- **The bridge** — `codedeck-bridge`, a headless service that runs agent
  sessions on the machine where your code lives and exposes them over encrypted
  Nostr. It ships as a Docker image and as Linux archives
  ([`docs/BRIDGE.md`](docs/BRIDGE.md)).
- **The Android app** — drives those sessions from your phone: review plans,
  approve tool permissions, answer the agent's questions, switch models, and
  chat with several sessions at once ([`docs/CLIENT.md`](docs/CLIENT.md)).

Pairing is a one-time QR scan; it survives restarts on both ends.

- Several concurrent sessions, switchable from one screen
- Plan approval, permission cards and agent questions on the phone
- Transcripts that survive restarts and offline gaps (ranged sync)
- Per-session mode, model and effort, plus custom AI provider profiles (Kimi
  K3, OpenRouter, any Anthropic-compatible endpoint)
- Claude Code and [OpenCode](https://opencode.ai), chosen per session — the
  protocol is agent-neutral, so another agent is one driver away
  ([`docs/PROTOCOL.md`](docs/PROTOCOL.md#adding-an-agent))
- Image attachments, and project/folder management on every paired bridge
- NIP-42 `AUTH` relays, and Tor on both ends (see below)

## About this fork

CodeDeck+ is a community-maintained continuation of **CodeDeck Next** by
[JeroenOnNostr](https://github.com/JeroenOnNostr)
([mobile](https://github.com/JeroenOnNostr/codedeck-next-mobile) ·
[bridge](https://github.com/JeroenOnNostr/codedeck-next-bridge)), consolidated
into one repository and since rebuilt: the protocol, the bridge and the phone's
core are Rust, and the Android app is native. It adds infrastructure the
upstream projects didn't design for:

- **NIP-42 `AUTH`** relays — e.g. a self-hosted
  [Haven](https://github.com/bitvora/haven) relay
- the bridge reaching its relays only over **Tor** (SOCKS5)
- the phone routing through **Orbot** (Android's Tor app)

The original MIT license and attribution are preserved. Upstream is not
tracked mechanically any more: the protocol and both halves have been
rewritten, so ideas from upstream are re-implemented here as ordinary changes.

## Repository layout

```
codedeck-plus/
├── crates/              # the Rust workspace
│   ├── protocol/          #   the phone wire (source of truth) + its conformance corpus
│   ├── agent-protocol/    #   the driver protocol: bridge ⇄ agent host
│   ├── nostr-transport/   #   relay WebSocket + SOCKS5 (Tor) driver, NIP-42 AUTH
│   ├── bridge-core/       #   the bridge engine (pure state machine)
│   ├── bridge-runtime/    #   the codedeck-bridge binary
│   ├── client-core/       #   the phone's core (pure)
│   ├── client-runtime/    #   the phone's async host
│   └── client-ffi/        #   UniFFI surface for the Android app
├── packages/
│   └── agent-host/        # Node sidecar running the agent SDKs (one driver per agent)
├── apps/
│   ├── android/           # the native Android app (Kotlin + the Rust client core)
│   └── mobile/            # the former Tauri app — frozen (future desktop client)
├── docker/              # the bridge image (Dockerfile, entrypoint, helpers)
├── deploy/              # systemd unit for the bridge
├── docs/                # PROTOCOL.md (contract) · BRIDGE.md · CLIENT.md · OPENCODE.md
├── scripts/             # toolchain installer (Linux), shared shell helpers
├── .github/workflows/   # ci.yml · release.yml (tag → release)
├── .claude/             # CLAUDE.md + skills for Claude Code
├── codedeck             # ./codedeck — bridge / Tor / APK / checks wrapper
├── docker-compose.yml
└── data/                # runtime volume (bridge identity, paired phones, sessions)
```

## Relays and Tor

- **NIP-42 relay auth** (`crates/protocol/src/nip42.rs`): the bridge and the
  phone each answer a relay's `AUTH` challenge with their own existing identity
  keypair — no new secret to configure. Just allowlist the bridge's pairing
  npub (and the phone's, if your relay gates reads too) in your relay's ACL.
- **Tor/SOCKS5 for the bridge** (`crates/nostr-transport`): set
  `CODEDECK_TOR_PROXY_URL` and every relay connection routes through it (the
  agents' own API traffic does not). See the optional `codedeck-tor` Compose
  service below.
- **Orbot for the phone**: a settings toggle routes the app's relay and image
  traffic through Orbot's SOCKS5 proxy — off by default.

## Running the bridge with Docker

Other ways to run it (release archives, systemd, from source) are in
[`docs/BRIDGE.md`](docs/BRIDGE.md).

Create a `.env` file in the root directory:

```env
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat...
GITHUB_TOKEN=ghp_...
GIT_USER=your_username
GIT_EMAIL=your_email@example.com
# Comma-separated repositories; cloned under /data/workspaces/<repo-name>
GIT_REPO=https://github.com/your-username/your-repo.git

# Optional — see .env.example for the full explanation of each:
CODEDECK_RELAYS=
CODEDECK_TOR_PROXY_URL=

# Optional — OpenCode, a second agent alongside Claude Code. See docs/OPENCODE.md.
CODEDECK_OPENCODE_SERVER_URL=
CODEDECK_OPENCODE_AUTO_START=
CODEDECK_OPENCODE_PORT=

# Optional — installs gsd-core (github.com/open-gsd/gsd-core) globally on
# startup. Off by default: see .env.example for why.
CODEDECK_GSD_AUTO_INSTALL=
```

Docker Compose reads the root `.env` file as its environment configuration. It
maps `CLAUDE_CODE_OAUTH_TOKEN` and `GITHUB_TOKEN` from that environment into
Docker secrets, mounted in the container at:

- `/run/secrets/claude_code_oauth_token`
- `/run/secrets/github_token`

The bridge exports `CLAUDE_CODE_OAUTH_TOKEN` because Claude Code needs it. It
does not export `GITHUB_TOKEN` into the bridge or Claude environment: Git reads
the GitHub credential through `git-credential-codedeck-secret`, and `gh` reads
it through `gh-codedeck-secret`. Keep real values only in your untracked
`.env` file, use least-privilege tokens, and rotate them if they appear in
logs or source control.

### Start it

1. Build and start the container:
```bash
docker compose up -d --build
```

2. **Optional** — also run the bundled Tor daemon (`lncm/tor`), instead of
   pointing `CODEDECK_TOR_PROXY_URL` at a Tor daemon you already run
   elsewhere:
```bash
docker compose --profile tor up -d --build
# then set CODEDECK_TOR_PROXY_URL=socks5h://codedeck-tor:9050 in .env
```

3. Check the logs to scan the pairing QR code with the CodeDeck+ Android app:
```bash
docker compose logs -f codedeck-bridge
```

## Releases

Pushing a `vMAJOR.MINOR.PATCH` tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml),
which publishes one GitHub Release with every artifact of that version:

| Component | Artifact |
|---|---|
| Android app | `codedeck-vX.Y.Z.apk` — release aarch64 build, signed |
| Bridge for Linux (binary + agent host + Node; glibc ≥ 2.35) | `codedeck-bridge-vX.Y.Z-linux-x86_64.tar.xz`, `…-linux-aarch64.tar.xz` |
| Bridge for Windows (the same, zipped) | `codedeck-bridge-vX.Y.Z-windows-x86_64.zip` |

The archives leave out the agents' own binaries and install them on first use
(see [`docs/BRIDGE.md`](docs/BRIDGE.md)); the container image includes them.
| Bridge container image | `ghcr.io/deymosh/codedeck-plus-bridge:vX.Y.Z` (and `:latest`) |

A tag with a hyphen (`v1.2.3-rc1`) is published as a prerelease and does not move
`:latest`. The version is bumped in the tree in the commit that gets tagged (one
number for the whole monorepo); `workflow_dispatch` runs the same pipeline for a
dry run.

APK signing needs four repository secrets — `SIGNING_KEY` (base64 keystore),
`KEY_ALIAS`, `KEY_STORE_PASSWORD`, `KEY_PASSWORD`. See
[`.claude/skills/cut-release/SKILL.md`](.claude/skills/cut-release/SKILL.md) for
the full runbook.

## More docs

- [`docs/BRIDGE.md`](docs/BRIDGE.md) — the bridge: install, commands, config, files, systemd
- [`docs/CLIENT.md`](docs/CLIENT.md) — the phone: the Rust client core, the Android app, transport rules, building the APK
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — the v11 wire contract, the driver protocol, adding an agent
- [`docs/OPENCODE.md`](docs/OPENCODE.md) — the optional OpenCode session backend: external server vs. bridge-managed, config, Docker setup
- [`.claude/skills/cut-release/SKILL.md`](.claude/skills/cut-release/SKILL.md) — the release runbook

## Upstream

- [codedeck-next-mobile](https://github.com/JeroenOnNostr/codedeck-next-mobile) — upstream Android app
- [codedeck-next-bridge](https://github.com/JeroenOnNostr/codedeck-next-bridge) — upstream headless CLI / VPS bridge
