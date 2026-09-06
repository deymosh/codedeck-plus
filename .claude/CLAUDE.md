# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Project identity

CodeDeck+ is a community-maintained continuation of CodeDeck Next: run Claude Code
sessions on a laptop/VPS ("the bridge") and drive them from an Android phone over
end-to-end-encrypted Nostr. This repo consolidates the two upstream projects
(`codedeck-next-bridge`, `codedeck-next-mobile`) into one pnpm monorepo and adds
infrastructure the upstream did not design for:

- a Nostr relay that requires **NIP-42 `AUTH`** (e.g. a self-hosted Haven relay),
- a bridge that only reaches the network over **Tor** (SOCKS5),
- the phone routing through **Orbot** instead (Android's Tor app).

### Non-negotiable structure

- **`vendor/bridge/` and `vendor/mobile/` are pristine `git subtree` mirrors of
  upstream — never hand-edit a file under `vendor/`.** New upstream work arrives
  via `scripts/sync-upstream.sh` (a real `git subtree pull`); what then lands in
  `packages/*` / `apps/*` is a deliberate, reviewed merge. `vendor/*` exists only
  as the honest diff base.
- The **editable** code is `packages/{protocol,core,testkit}` and
  `apps/{bridge,mobile}`.
- **`packages/protocol` is the single source of truth for the wire.** Every
  message is a zod schema; TS types are `z.infer<>`; both peers `safeParse` at
  ingest; `decodeBridgeToPhone` / `decodePhoneToBridge` are **total** (they
  return a typed result and never throw). Protocol version 10 is a **clean break**
  — there is no compatibility with pre-v10 peers, so do not add version-ladder
  logic; gate new features on capability strings instead.
- The package is deliberately runtime-agnostic: its only deps are `nostr-tools`
  and `zod`, no `@types/node`, no DOM lib. Keep it that way — a second client
  (e.g. a native one) must be able to treat it as the spec.

## Commands

**There is no Node/pnpm toolchain on the maintainer's host.** Everything runs
through Docker via the `./codedeck` script (Git Bash on Windows, sh elsewhere).
Do not assume `pnpm`/`node` on `PATH`.

```bash
# Workspace verification — run these in a throwaway node container, nothing
# installed locally is required. A change is not done until `check` is green.
./codedeck check         # typecheck + test, every package
./codedeck typecheck     # typecheck only
./codedeck test          # test only

# The deployed bridge service (Docker Compose)
./codedeck bridge up     # build if needed and start
./codedeck bridge logs   # follow logs
./codedeck bridge pair   # print the most recent pairing QR/URL
./codedeck bridge down

# Local Android APK (its own Android/Rust toolchain image — several GB first run)
./codedeck apk debug     # fast, unstripped, Android debug keystore
./codedeck apk benchmark # release-optimized .so, debug-signed so it installs

# Pull upstream into vendor/* for hand-merging
./codedeck sync
```

If you must run a single package's tests, the container path is
`pnpm --filter <pkg> run test` — but prefer `./codedeck test` unless iterating.

### CI and releases

- `.github/workflows/ci.yml` runs on every push to `master` and every PR:
  `typecheck` + `test` + `build` (recursive) + a bridge-artifact smoke test, plus
  a path-filtered `cargo test` for `apps/mobile/src-tauri` and the
  `tauri-plugin-*` crates.
- `.github/workflows/release.yml` runs on a `vMAJOR.MINOR.PATCH` tag: it builds
  and publishes one GitHub Release with the signed APK, the bridge npm tarball,
  and the bridge container image (`ghcr.io/<owner>/codedeck-plus-bridge`). A tag
  with a hyphen (`v1.2.3-rc1`) is a prerelease. See the `cut-release` skill.
- `pnpm build` at the root is recursive (bridge + mobile web bundle);
  `pnpm build:bridge` is the bridge-only form. `docker/Dockerfile` invokes the
  filtered form directly, so the image build is independent of the root script.

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
packages/protocol   wire contract: schemas, codec (total), kinds, chunking,
                    capabilities, nip42 signer. Depends on nothing internal.
        │
        ├── packages/core        the BRIDGE engine (Node-only): SDK adapter,
        │                        session runner/registry/permissions, sync
        │                        server, nostr pool/publisher/ingest, pairing,
        │                        mesh admin, folders, Tor/SOCKS5 transport.
        │        │
        │        └── apps/bridge  thin CLI / systemd wrapper, esbuild-bundled.
        │
        └── apps/mobile          Tauri v2 + React Android app:
              src/core             stores, connection FSM, bridgeApi, nostrClient,
                                   crypto (mirrors core's crypto, does NOT import it)
              src/ui               screens + components + transcript renderers
              src/platform         Tauri seams — every one `isTauri`-guarded with
                                   a browser/desktop fallback
              src-tauri            Rust host + tauri-plugin-* (background relay,
              tauri-plugin-*       mesh VpnService, STT, tor-proxy, marmot/MLS)
```

- **The phone must not import `@codedeck/core` (or `@codedeck/testkit`) in
  production code.** `apps/mobile/src/__tests__/layering.test.ts` enforces this;
  `apps/mobile/src/core/crypto.ts` deliberately re-implements the crypto helpers
  rather than importing them. `@codedeck/core` is the bridge's engine.
- **Capability negotiation has three tiers** — see the note at the top of
  `packages/protocol/src/capabilities.ts`. `images`, `custom-providers` and
  `diff` are HARD GATES (absence changes behaviour). `sync/1`, `folders`, `gsd`,
  `usage`, `models`, `device-actions` are PRESENCE MARKERS (the feature is
  detected from payload data, not the string). `chunked` is a TRANSPORT BEACON
  (advertised on both sides, gated by neither). Do not add a new string as a
  "gate" unless a peer that has not seen it would otherwise hard-fail.
- Reusable UI primitives live in `apps/mobile/src/ui/shared.module.css` +
  `shared.ts` (buttons, cards, badges, banners, the `.screen` scroll column).
  Check there before adding a new one.
- `apps/mobile/src/platform/poolOptions.ts` is the single place every phone
  `SimplePool` is configured; a test scans the source tree to enforce it.

## Absolute constraints (do not suggest workarounds)

- Never hand-edit `vendor/*`. Never introduce pre-v10 protocol compatibility.
- Every wire change starts as a `packages/protocol` schema. Keep the decoders
  total (return a result, never throw). Keep `packages/protocol` free of
  `@types/node` / DOM / non-`nostr-tools`-non-`zod` deps.
- No bridge network path that bypasses the configured SOCKS proxy when one is
  set; no phone network path that bypasses the Orbot WebView proxy override.
  Cleartext `ws://` is allowed only for `.onion` relays.
- Secrets — Anthropic API keys, GitHub PATs, custom-provider tokens, Android
  keystore material — are never logged, never echoed back over the wire, and are
  wiped from component state immediately after send.
- Do not downgrade Node / TypeScript / Rust / NDK versions to work around a build
  failure; fix the root cause.
- The root `main.js` shim and `docker/Dockerfile` both assume the bridge builds
  to `apps/bridge/out/main.js` — keep them consistent if that changes.

## Vendored history note

Commit `c0d8676` restructured the two vendored repos into this monorepo as a pure
`git mv` (verified: no file content changed). Everything since is additive
(NIP-42, Tor/SOCKS5, Orbot, event fragmentation, APK build tooling, CI/release).
`docs/PROTOCOL.md` is the promoted contributor contract; `packages/protocol/src/`
is authoritative where they disagree.
