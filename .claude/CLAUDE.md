# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Project identity

CodeDeck+ is a community-maintained continuation of CodeDeck Next: run coding
agents (Claude Code, OpenCode, DeepSeek Harness, Qwen Code) on a laptop/VPS ("the bridge") and drive them
from an Android phone over end-to-end-encrypted Nostr. It started as a merge of
the two upstream projects (`codedeck-next-bridge`, `codedeck-next-mobile`) and
has since been rebuilt: the protocol, the bridge and the phone's core are Rust;
the only TypeScript left runs the agent SDKs. It adds infrastructure the
upstream did not design for:

- a Nostr relay that requires **NIP-42 `AUTH`** (e.g. a self-hosted Haven relay),
- a bridge that only reaches its relays over **Tor** (SOCKS5),
- the phone routing through **Orbot** instead (Android's Tor app).

### Non-negotiable structure

- **No upstream tracking.** The protocol and both halves have been rewritten,
  so upstream changes are not pulled in mechanically; an idea worth taking from
  upstream is re-implemented here as an ordinary change.
- The **editable** code is `crates/*`, `packages/agent-host` and `apps/android`.
  `apps/mobile` (the Tauri app) is frozen on protocol v10, outside the pnpm
  workspace and CI; it is kept as the base of a future desktop client.
- **`crates/protocol` is the single source of truth for the phone wire**, and
  **`crates/agent-protocol` for the driver protocol** (bridge ⇄ agent host).
  Decoders are **total** (they return a result, never panic or throw).
  Protocol v12 is a **clean break** — no compatibility with earlier peers, no
  version-ladder logic; gate new features on capability strings or on the
  agent catalog's `supports` flags. `crates/protocol` depends on nothing else in
  the workspace, so any client can treat it as the spec.
- **Nothing outside a driver knows a particular agent.** Agent-specific
  behaviour (SDK translation, modes, permission policy, credential and provider
  mapping) lives in `packages/agent-host/src/drivers/<agent>/`; the bridge and
  the phone work from the catalog the host reports. See `docs/PROTOCOL.md`,
  "Adding an agent".

## Commands

**Two supported ways to get a toolchain, pick by host OS — never assume
`pnpm`/`node`/`cargo`/`java` are already on `PATH` without checking which
applies. `./codedeck doctor` answers what this machine has right now.** Every
command below runs on both engines: Docker when its daemon answers, otherwise
the vendored toolchain — the caller does not choose, and does not need to know.

- **Windows (the maintainer's usual host):** no toolchain on the host at
  all. Everything runs through Docker via the `./codedeck` script (Git Bash).
  The commands that hold a container open (`dev`, `android`, `live`) keep ONE
  long-lived container and sync the tree into it, so nothing re-tars the repo
  per command — that is what makes them fast enough for a loop of edits.
  A git worktree gets a `dev`/`live` container of its own
  (`codedeck-dev-<worktree>`, caches shared), so checkouts never take turns.
- **Linux (e.g. inside a container that doesn't itself have Docker-in-Docker,
  or any bare Linux machine):** `scripts/install-toolchain.sh` installs the
  toolchain into `./toolchain/` (gitignored), independent of anything already
  on that machine: a JDK, Rust (+ the Android targets), Node.js with the exact
  pinned pnpm, the Android SDK/NDK, and a Zig host-`cc` shim (active only when
  the machine has no C compiler). It takes the components a command needs —
  `node`, `rust`, `android` or `java` — so a host that works on one part of
  the repo never downloads the rest (the SDK and NDK alone are a few GB); no
  argument installs everything. `source toolchain/env.sh` puts whatever is
  installed on `PATH`. A docker binary that is present but whose daemon is
  down is an error to fix, not a trigger for the local path.

```bash
# What exists right now — Docker, images, volumes, containers, the agent
# cache, the Android SDK. Start here when something looks wrong.
./codedeck doctor

# Workspace verification, in throwaway containers (nothing installed locally
# is required). A change is not done until `check` is green.
./codedeck check         # agent host typecheck + test, cargo clippy + test (every crate)
./codedeck typecheck     # typecheck / clippy only
./codedeck test          # tests only

# The loop between checks: one long-lived container, tree synced in, caches warm.
./codedeck dev <cmd…>    # run <cmd> in it, at the repo root (bare: a shell)
                         # without a terminal it stops after 30 min (--timeout S, 0 = never)
./codedeck dev vitest …  # the agent host's test files, run once
./codedeck android test  # the app's unit tests, then the counts and failures
./codedeck android lint  # lintDebug, then what the report says
./codedeck live opencode # one real agent session, everything the host reports
./codedeck live claude-code --fake-model --prompt /tool
                         # the same session against a local model server:
                         # no account, no network, fixed replies (see below)

# The deployed bridge service (Docker Compose)
./codedeck bridge up     # build if needed and start
./codedeck bridge logs   # follow logs
./codedeck bridge pair   # print the most recent pairing QR/URL
./codedeck bridge down

# The Android app — Windows: Docker (its own toolchain image, several GB
# first run); Linux: scripts/install-toolchain.sh once, then the -local script.
./codedeck apk                               # debug APK into dist/ (Docker)
./codedeck apk --target aarch64-linux-android # ...for an arm64 device only:
                                             # dist/codedeck-plus-<rev>-debug-arm64-v8a.apk
apps/android/scripts/build-apk-local.sh      # debug APK, Linux/local path
./codedeck gen-android-bindings              # regenerate the UniFFI Kotlin bindings
```

Narrower loops run in the dev container, which keeps its node_modules and the
caches between commands: `./codedeck dev cargo test -p <crate>`,
`./codedeck dev vitest run <file>` (the agent host's own tests). Tests marked
`#[ignore]` need Node and a built agent host: the driver-protocol spawn test
(`./codedeck dev cargo test -p agent-protocol --test agent_host -- --ignored`)
and the bridge end-to-end test (`-p bridge-runtime --test e2e`) — the host
bundle is `./codedeck dev pnpm --filter @codedeck/agent-host run build`. After
changing a driver-protocol type, regenerate the host's types with
`./codedeck dev cargo test -p agent-protocol --test gen_ts_bindings -- --ignored`.

### Asking an agent a question — three tiers, cheapest first

A run costs what its model costs, so pick the tier by what needs proving.
Tiers one and two spend nothing; tier three is where a subscription or a
balance is at stake, so pass `--model` and never borrow the bridge's
credentials (`--env` is for the agent's own paths, not its keys).

1. **`live fake`** — the scripted test agent: the driver protocol's own
   plumbing, with no SDK and no model at all.
2. **`live <agent> --fake-model`** — a real agent (claude-code, opencode,
   deepseek-harness, qwen-code) against a local model server
   (`packages/agent-host/tools/fake-model.mjs`). The session is real, the
   model is not: each prompt is a scenario — `/tool` (a tool call; OpenCode
   asks permission for it), `/question` (a question form), `/plan-approval`
   (a plan card), `/error` (an API failure), `/long` (a long answer and a
   large context) — and anything else is echoed. Nothing reaches an account,
   and CI runs the same thing for claude-code
   (`src/drivers/claude/__tests__/claudeFakeModel.test.ts`).
3. **A real model** — OpenCode on its free Zen models
   (`--model opencode/cat-jam-free`) for fidelity, since only a real model
   chooses its own tool arguments and writes prose. Everything else on
   claude-code, deepseek-harness or qwen-code spends the account. The
   commands for each tier are in the verify-changes skill.

### CI and releases

- `.github/workflows/ci.yml` runs on every push to `master` and every PR: the
  agent host's typecheck + test + build; cargo test + clippy for every crate;
  the driver-protocol drift check, host spawn test and bridge end-to-end test;
  the bridge crates, agent host tests and end-to-end test again on Windows;
  and the Android unit/screenshot tests with the UniFFI bindings drift check.
  A `changes` job path-filters every other job, so an untouched area costs no
  runner; only `master` runs save the Rust caches (a PR's cache is scoped to
  that PR and would only crowd the 10 GB quota).
- `.github/workflows/release.yml` runs on a `vMAJOR.MINOR.PATCH` tag: it builds
  and publishes one GitHub Release with the signed APK, the bridge for Linux
  x86_64 and aarch64 and for Windows x86_64 (archives: binary + agent host +
  Node; the agents' own binaries are installed on demand, pinned to
  pnpm-lock.yaml's sha512),
  and the bridge container image (`ghcr.io/<owner>/codedeck-plus-bridge`). A
  tag with a hyphen (`v1.2.3-rc1`) is a prerelease. See the `cut-release`
  skill.

## Workflow

- **Branch + PR, never direct commits to `master`.** Start from an up-to-date
  `master`, create `<type>/<short-kebab-slug>` with the conventional type the
  work's commits would use — `fix/`, `feat/`, `ci/`, `build/`, `test/`,
  `perf/`, `docs/`, `chore/` — do all of a request's commits there (one branch
  per request, not per commit), then open a PR with `gh pr create` and a real
  summary. Leave the PR open for the user to merge
  unless they explicitly say to merge it. Small doc/config housekeeping the user
  is directing turn-by-turn may go straight to the working branch they name.
- **Multi-part requests: one task at a time.** Implement, verify with
  `./codedeck check` (or the narrowest sufficient subset), commit that task, then
  start the next. Do not batch unrelated changes into one commit.
- A change is not finished until typecheck + tests pass. If you cannot run them
  (Docker unavailable), say so explicitly in the summary — do not imply they
  passed.

## Commit and comment safety

- **English only, everywhere it lands in the tree or history**: code, comments,
  commit subjects and bodies, PR titles and descriptions. The conversation with
  the maintainer may be in another language; the artifacts are not.
- **No literal `@word` in any commit message, PR body, or code comment.** GitHub
  auto-links `@word` as a user mention and notifies a real account — and the most
  common way this rule is missed is scoped package names and framework tokens
  that do not *feel* like a mention: `@codedeck/core`, `@codedeck/protocol`,
  `@tauri-apps/cli`, `@anthropic-ai/claude-agent-sdk`. Fix by wrapping the token
  in backticks (`` `@codedeck/core` ``), dropping the `@` ("the codedeck/core
  package"), or rephrasing. Scan every drafted commit message for `@` before
  `git commit`; "does this look like a person" is not a sufficient filter.
- **Comments and commit messages must stand on their own.** State the actual
  invariant, constraint, or behaviour being preserved — do not make a `CDX-0NN` /
  `CDB-0NN` ticket id or "see commit `<sha>`" the *only* explanation. Upstream's
  existing `CDX-` tags are fine as traceability breadcrumbs alongside a real
  explanation; a new comment that says only "CDX-071 gate" is not.
- Do not reference the current task, the PR, or "the fix" in code comments — the
  comment outlives all three.


## Architecture and layering

```
crates/protocol          the phone wire: messages, total codec, kinds, ranges,
    │                    chunking, capabilities, NIP-44/NIP-42 primitives.
    │                    Depends on nothing internal.
    ├── crates/agent-protocol    the driver protocol (bridge ⇄ agent host);
    │                            the host's TS types are generated from it.
    ├── crates/nostr-transport   relay WebSocket + SOCKS5 driver, NIP-42 AUTH.
    │
    ├── crates/bridge-core       the bridge engine: sessions, restarts, cards,
    │        │                   seqs, sync, pairing, ingest, credentials — a
    │        │                   pure state machine (inputs in, effects out).
    │        └── crates/bridge-runtime   the `codedeck-bridge` binary: relays,
    │                            agent host process, state/transcript files,
    │                            workspace, uploads, direct link, CLI.
    │                                 │ stdio (driver protocol)
    │                            packages/agent-host   Node: one driver per agent
    │                            (opencode, claude, deepseek, qwen, fake) around
    │                            its SDK.
    │
    └── crates/client-core       the phone's pure core: stores, connection FSM,
             │                   sync/merge, presentation.
             └── crates/client-runtime   async host (tokio, transport, ports)
                      └── crates/client-ffi   UniFFI surface → apps/android
```

- **Pure cores stay pure.** `crates/client-core` and `crates/bridge-core` have
  no tokio, no sockets, no filesystem: they return effects (or read through
  small synchronous ports) and are tested deterministically with in-memory
  ports. I/O belongs in the runtimes.
- **The phone and the bridge share only `protocol` (and `nostr-transport`).**
  Neither core depends on the other.
- **Capability negotiation** — see the note at the top of
  `crates/protocol/src/capabilities.rs`. The only capabilities are `files`
  and `session-keys`, both gates. What an agent can do is catalog data
  (`supports`), not a capability. Do not add a new string unless a peer that
  has not seen it would otherwise hard-fail. The protocol version is not a
  capability: every message carries it as `v`.

## Absolute constraints (do not suggest workarounds)

- Never introduce pre-v12 protocol compatibility.
- Every phone-wire change starts in `crates/protocol` (with a corpus fixture);
  every driver-protocol change in `crates/agent-protocol` (then regenerate the
  host's types). Keep the decoders total.
- **When a Tor/SOCKS proxy is set, ALL Nostr traffic goes through it — on the
  bridge and on the phone alike.** Nostr traffic is anything to a relay or a
  Blossom server: relay connections, Blossom uploads and downloads. No path
  to one may bypass the proxy while it is set (loopback, which never leaves
  the machine, excepted). Other outbound calls (provider
  token checks, the agents' own API traffic) do not use it and are not a
  proxy bypass. A machine's direct link is not Nostr traffic either — it goes
  to the user's own bridge on a network they set up (LAN, VPN) and is dialled
  directly either way; only its `.onion` endpoints go through Orbot.
  Cleartext `ws://` / `http://` is allowed only to `.onion` hosts (and
  loopback, for tests).
- Secrets — API keys, GitHub PATs, custom-provider tokens, Android keystore
  material — are never logged, never echoed back over the wire, and are wiped
  from component state immediately after send. In Rust they travel as
  `agent_protocol::Secret`, whose `Debug` is redacted.
- Do not downgrade Node / TypeScript / Rust / NDK versions to work around a build
  failure; fix the root cause.
- The image (`docker/Dockerfile`) and the release archives lay the bridge out as
  `codedeck-bridge` with `agent-host/dist/main.js` beside it; the binary looks
  there by default — keep them consistent. Neither ships the agents' own
  binaries: the agent host installs them on demand at the version and sha512
  pnpm-lock.yaml pins (the image into the `/data` volume). A host without npm
  registry access uses `CODEDECK_NPM_REGISTRY`, a one-time online
  `codedeck-bridge agents install`, or a copied `/data/agents` volume. Never add
  a global Claude Code, OpenCode or DeepSeek Harness install — the version must
  follow the lockfile.

## History note

Commit `c0d8676` merged the two upstream repos into this monorepo as a pure
`git mv`; everything since is this fork's own. `docs/PROTOCOL.md` is the contributor contract; `crates/protocol` and
`crates/agent-protocol` are authoritative where they disagree. `docs/BRIDGE.md`
and `docs/CLIENT.md` describe each half as it is today.
