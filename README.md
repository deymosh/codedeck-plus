# CodeDeck+

CodeDeck+ is a community-maintained continuation of CodeDeck Next. The
original work belongs to [JeroenOnNostr](https://github.com/JeroenOnNostr),
whose two upstream projects are:

- [codedeck-next-mobile](https://github.com/JeroenOnNostr/codedeck-next-mobile)
- [codedeck-next-bridge](https://github.com/JeroenOnNostr/codedeck-next-bridge)

This repository, [deymosh/codedeck-plus](https://github.com/deymosh/codedeck-plus),
consolidates both projects into one monorepo. It keeps one shared copy of
`packages/{core,protocol,testkit}` alongside the mobile app, bridge, and
pristine upstream mirrors in `vendor/`, making the combined project easier to
maintain while preserving the original MIT license and attribution.

CodeDeck+ also carries local patches for infrastructure the upstream projects
didn't design for:

- a Nostr relay that requires **NIP-42 `AUTH`** (e.g. a self-hosted
  [Haven](https://github.com/bitvora/haven) relay),
- a bridge that only reaches the network over **Tor** (SOCKS5),
- the phone routing through **Orbot** instead (Android's Tor app).

Docker only builds and runs the **bridge** service — the mobile app lives
here too (for the shared packages, and because it needed its own Tor/Orbot
patch) but is built separately with its own Android/Rust toolchain.

## Repository layout

```
codedeck-plus/
├── vendor/              # pristine git-subtree mirrors of upstream — never hand-edited
│   ├── bridge/           #   codedeck-next-bridge @ main
│   └── mobile/           #   codedeck-next-mobile @ main
├── packages/             # shared workspace packages (the actual, editable code)
│   ├── protocol/          #   wire format + NIP-42 signer, used by both apps
│   ├── core/               #   bridge engine (Node-only: Tor/SOCKS5 transport lives here)
│   └── testkit/
├── apps/
│   ├── bridge/            # the headless CLI/systemd bridge — what Docker builds
│   └── mobile/             # Tauri v2 + React Android app (not built by Docker)
├── docker/
│   ├── Dockerfile
│   └── entrypoint.sh
├── scripts/
│   └── sync-upstream.sh  # pulls upstream into vendor/*, for hand-merging
├── docker-compose.yml
├── pnpm-workspace.yaml
└── data/                 # runtime volume (bridge identity, paired phones, sessions)
```

See `scripts/sync-upstream.sh` for how to pull future upstream changes —
`vendor/*` stays a real `git subtree`, so pulling in new fixes is a real
`git subtree pull`, not a manual re-diff against a tarball. What lands in
`packages/*` and `apps/bridge`/`apps/mobile` after that is still a deliberate,
reviewed merge (they've diverged from `vendor/*` on purpose).

## Local patches on top of upstream

- **NIP-42 relay auth** (`packages/protocol/src/nip42.ts`): the bridge and
  the phone each answer a relay's `AUTH` challenge with their own existing
  identity keypair — no new secret to configure. Just allowlist the bridge's
  pairing npub (and the phone's, if your relay gates reads too) in your
  relay's ACL.
- **Tor/SOCKS5 for the bridge** (`packages/core/src/nostr/transport.ts`):
  set `CODEDECK_TOR_PROXY_URL` and every relay connection routes through it.
  See the optional `codedeck-tor` Compose service below.
- **Orbot for the phone** (`apps/mobile/tauri-plugin-tor-proxy`): a settings
  toggle routes the WebView's relay traffic through Orbot's SOCKS5 proxy via
  `androidx.webkit.ProxyController` — Android-only, off by default.
- Relay reconnection (`BridgePool` / the phone's connection FSM) was already
  solid upstream (epoch-guarded reconnects, exponential backoff) — see the
  code comments in `packages/core/src/nostr/pool.ts` for what's original vs.
  new.

## Environment Variables

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

## Quick Start

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

3. Check the logs to scan the pairing QR code with your CodeDeck app:
```bash
docker compose logs -f codedeck-bridge
```

## Related repos

- [codedeck-next-mobile](https://github.com/JeroenOnNostr/codedeck-next-mobile) — upstream Android app
- [codedeck-next-bridge](https://github.com/JeroenOnNostr/codedeck-next-bridge) — upstream headless CLI / VPS bridge
