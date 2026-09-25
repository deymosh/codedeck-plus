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

To iterate on one piece without the full sweep:

```bash
pnpm --filter @codedeck/agent-host run test          # the agent host's vitest suite
cargo test -p bridge-core                            # one crate
```

Tests marked `#[ignore]` need Node plus a built agent host bundle
(`pnpm --filter @codedeck/agent-host run build`): the driver-protocol spawn
test and the bridge end-to-end test. Run them with `-- --ignored`:

```bash
cargo test -p bridge-runtime --test e2e -- --ignored
```

After changing a type in `crates/agent-protocol`, regenerate the host's
TypeScript types first (`cargo test -p agent-protocol --test gen_ts_bindings
-- --ignored`) or the host will not typecheck.

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
