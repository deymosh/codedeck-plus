# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Project identity

CodeDeck+ is a community-maintained continuation of CodeDeck Next: run coding
agents (Claude Code, OpenCode, …) on a laptop/VPS ("the bridge") and drive them
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
  Protocol v11 is a **clean break** — no compatibility with earlier peers, no
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
applies:**

- **Windows (the maintainer's usual host):** no toolchain on the host at
  all. Everything runs through Docker via the `./codedeck` script (Git Bash).
  For a single one-shot command this is fine as-is, but Windows bind mounts
  and repeated tar-the-whole-repo-and-`docker cp`-it startup cost make
  Docker slow for anything iterative (many builds/edits in a row, e.g. an
  Android session): build the toolchain image ONCE, `docker create`+`start`
  ONE long-lived container from it, then run each step as a separate
  `docker exec` against that same container, and only `docker rm -f` it once
  the whole session of work is actually done. Don't spin up a fresh
  container (and re-tar the repo into it) per command.
- **Linux (e.g. inside a container that doesn't itself have Docker-in-Docker,
  or any bare Linux machine):** `scripts/install-toolchain.sh` installs a
  COMPLETE toolchain — JDK, Rust (+ the Android targets), Node.js, the exact
  pinned pnpm, the Android SDK/NDK, and a Zig host-`cc` shim (active only
  when the machine has no C compiler; cargo needs one to link build
  scripts/proc macros/test binaries) — into `./toolchain/` (gitignored),
  independent of anything already on that machine. Run it once, then
  `source toolchain/env.sh` in any shell that needs
  `cargo`/`node`/`pnpm`/`java`/`sdkmanager` from it.
  `apps/android/scripts/build-apk-local.sh` uses this directly — no Docker.

```bash
# Workspace verification, in throwaway containers (nothing installed locally
# is required). A change is not done until `check` is green.
./codedeck check         # agent host typecheck + test, cargo clippy + test (every crate)
./codedeck typecheck     # typecheck / clippy only
./codedeck test          # tests only

# The deployed bridge service (Docker Compose)
./codedeck bridge up     # build if needed and start
./codedeck bridge logs   # follow logs
./codedeck bridge pair   # print the most recent pairing QR/URL
./codedeck bridge down

# The Android app — Windows: Docker (its own toolchain image, several GB
# first run); Linux: scripts/install-toolchain.sh once, then the -local script.
./codedeck apk                               # debug APK into dist/ (Docker)
apps/android/scripts/build-apk-local.sh      # debug APK, Linux/local path
./codedeck gen-android-bindings              # regenerate the UniFFI Kotlin bindings
```

Narrower loops: `cargo test -p <crate>`; `pnpm --filter @codedeck/agent-host
run test`. Tests marked `#[ignore]` need Node and a built agent host
(`pnpm --filter @codedeck/agent-host run build`): the driver-protocol spawn
test (`-p agent-protocol --test agent_host`) and the bridge end-to-end test
(`-p bridge-runtime --test e2e`) — run them with `-- --ignored`. After changing
a driver-protocol type, regenerate the host's types with
`cargo test -p agent-protocol --test gen_ts_bindings -- --ignored`.

### CI and releases

- `.github/workflows/ci.yml` runs on every push to `master` and every PR: the
  agent host's typecheck + test + build; cargo test + clippy for every crate;
  the driver-protocol drift check, host spawn test and bridge end-to-end test;
  and the Android unit/screenshot tests with the UniFFI bindings drift check
  (Rust and Android jobs are path-filtered).
- `.github/workflows/release.yml` runs on a `vMAJOR.MINOR.PATCH` tag: it builds
  and publishes one GitHub Release with the signed APK, the bridge for Linux
  x86_64 and aarch64 (self-contained archives: binary + agent host + Node),
  and the bridge container image (`ghcr.io/<owner>/codedeck-plus-bridge`). A
  tag with a hyphen (`v1.2.3-rc1`) is a prerelease. See the `cut-release`
  skill.

## Workflow

- **Branch + PR, never direct commits to `master`.** Start from an up-to-date
  `master`, create `claude/<short-kebab-slug>`, do all of a request's commits
  there (one branch per request, not per commit), then open a PR with
  `gh pr create` and a real summary. Leave the PR open for the user to merge
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
- **Every commit Claude Code makes ends with a `Co-Authored-By:` trailer** naming
  the model that did the work, e.g.
  `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`. Apply it every time,
  unprompted.
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
    │                            workspace, images, GSD, device tools, CLI.
    │                                 │ stdio (driver protocol)
    │                            packages/agent-host   Node: one driver per agent
    │                            (claude, opencode, fake) around its SDK.
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
  `crates/protocol/src/capabilities.rs`. `images` is a HARD GATE; `sync/1`,
  `folders`, `device-actions` are PRESENCE MARKERS; `chunked` is a TRANSPORT
  BEACON. What an agent can do is catalog data (`supports`), not a capability.
  Do not add a new string as a "gate" unless a peer that has not seen it would
  otherwise hard-fail.

## Absolute constraints (do not suggest workarounds)

- Never introduce pre-v11 protocol compatibility.
- Every phone-wire change starts in `crates/protocol` (with a corpus fixture);
  every driver-protocol change in `crates/agent-protocol` (then regenerate the
  host's types). Keep the decoders total.
- **The Tor/SOCKS proxy is for Nostr relay traffic only.** When one is set,
  every bridge relay connection goes through it; other outbound calls (HTTP
  checks, image downloads, the agents' own API traffic) do not use it and are
  not a proxy bypass. No phone network path may bypass the Orbot WebView proxy
  override. Cleartext `ws://` is allowed only for `.onion` relays (and
  loopback, for tests).
- Secrets — API keys, GitHub PATs, custom-provider tokens, Android keystore
  material — are never logged, never echoed back over the wire, and are wiped
  from component state immediately after send. In Rust they travel as
  `agent_protocol::Secret`, whose `Debug` is redacted.
- Do not downgrade Node / TypeScript / Rust / NDK versions to work around a build
  failure; fix the root cause.
- The image (`docker/Dockerfile`) and the release archives lay the bridge out as
  `codedeck-bridge` with `agent-host/dist/main.js` beside it; the binary looks
  there by default — keep them consistent. The image's `claude` is a symlink to
  the Agent SDK's own platform binary (no global Claude Code install), so its
  version follows the lockfile.

## History note

Commit `c0d8676` restructured the two upstream repos into this monorepo as a
pure `git mv`. Everything since is this fork's own work: NIP-42, Tor/SOCKS5,
Orbot, event fragmentation, the native Android app, protocol v11 and the Rust
bridge. `docs/PROTOCOL.md` is the contributor contract; `crates/protocol` and
`crates/agent-protocol` are authoritative where they disagree.
