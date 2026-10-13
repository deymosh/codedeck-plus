---
name: verify-changes
description: Verify a change in this repository when there is no Node/Rust toolchain on the host — run the agent host and Rust checks in Docker via ./codedeck, and know when an APK or a running bridge is actually needed. Use before committing, when asked to run the tests, or to confirm a change works.
---

# Verifying changes without a host toolchain

The maintainer's machine has Docker but **no `node`/`pnpm`/`cargo` on `PATH`**.
All verification goes through the `./codedeck` script, which spins up throwaway
containers (Node for the agent host, Rust for the crates) and runs the checks
inside them. Paths below are relative to the repo root.

## Primary path — always start here

```bash
./codedeck check        # agent host typecheck + test, then cargo clippy + test (every crate)
./codedeck typecheck    # typecheck / clippy only — fastest signal while iterating
./codedeck test         # tests only
```

`./codedeck check` being green is the bar for "done". It matches CI
(`.github/workflows/ci.yml`), so a green local `check` should mean green CI.

- First run pulls the base images and does a full compile — a few minutes.
  After that, the pnpm store, cargo registry and target dir live in named
  volumes, so reruns only rebuild what changed.
- Each check's container is removed on exit (success, failure, or Ctrl-C).

To iterate on one piece without the full sweep, use the dev container — one
long-lived container that keeps its `node_modules` and the caches, with the
working tree synced into it on every command (so an edit, a new file or a
deletion lands without thinking about it). It runs the same command on a
Docker-less Linux host, so nothing here is Windows-only:

```bash
./codedeck dev vitest run src/drivers/opencode/__tests__/opencodeDriver.test.ts
./codedeck dev vitest run <file> -t "the test name"
./codedeck dev cargo test -p bridge-core
./codedeck dev pnpm --filter @codedeck/agent-host run typecheck
./codedeck dev sh          # a shell in it, if you need one
```

`./codedeck doctor` reports what exists right now (Docker, images, volumes,
containers, the agent cache, the Android SDK) — worth one call before
debugging anything about the environment.

Tests marked `#[ignore]` need Node plus a built agent host bundle: the
driver-protocol spawn test and the bridge end-to-end test. Build the bundle in
the same container, then run them with `-- --ignored`:

```bash
./codedeck dev pnpm --filter @codedeck/agent-host run build
./codedeck dev cargo test -p bridge-runtime --test e2e -- --ignored
```

After changing a type in `crates/agent-protocol`, regenerate the host's
TypeScript types first (`./codedeck dev cargo test -p agent-protocol --test
gen_ts_bindings -- --ignored`) or the host will not typecheck.

## Android tests and lint

```bash
./codedeck android test          # app:testDebugUnitTest, then the counts and any failing class
./codedeck android lint          # app:lintDebug, then what the report says
./codedeck android paparazzi     # the snapshot tests
./codedeck android snapshot      # re-record them; goldens copied back to review
./codedeck android <task>        # any other Gradle task, passed through
```

Gradle runs without `--offline` on purpose: AGP resolves the platform DSL's
`release(37)` to `android-37.0`, which the toolchain image does not carry, so
the first run downloads it. Offline it stops with a message that reads like a
missing SDK.

## Asking a real agent

For anything about what an agent actually sends, or what the phone actually
ends up being shown, run one real session instead of writing a probe:

```bash
./codedeck live opencode --prompt "Reply with exactly: ok"
./codedeck live opencode --models      # what it offers, and which one a session defaults to
./codedeck live fake --prompt question # the scripted test agent: no network, no account
```

It prints every transcript entry, turn state, context figure and error as they
arrive, and keeps the log at `dist/live-<agent>.log`. Cost: `fake` and
OpenCode's free Zen models are free; anything else spends the account, so pass
`--model` when it matters. Claude and DeepSeek need credentials the bridge
holds — do not borrow them; use `opencode` or `fake`.

## Opt-in: building an APK or running the bridge

Do these **only when the user explicitly asks** to build an APK, run the
bridge, or check something in the real app — never on your own initiative just
because a change is UI- or bridge-facing. The `check` sweep above is the default
proof.

```bash
./codedeck apk             # debug APK of apps/android into dist/ (Docker; several GB first run)
./codedeck bridge up       # build + start the bridge service (Docker Compose)
./codedeck bridge logs     # follow its logs
./codedeck bridge pair     # print the most recent pairing QR / URL
./codedeck bridge down
```

A real signed release APK is produced only by `.github/workflows/release.yml`
on a tag, not by this script (see the `cut-release` skill).

## Reporting

If Docker is unavailable and you could not run any of the above, say so plainly
in the summary and PR — do not imply the checks passed. Paste the failing
assertion, not just "tests failed", when something breaks.
