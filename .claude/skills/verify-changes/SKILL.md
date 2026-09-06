---
name: verify-changes
description: Verify a change in this monorepo when there is no Node toolchain on the host — run typecheck and tests in Docker via ./codedeck, and know when an APK or a running bridge is actually needed. Use before committing, when asked to run the tests, or to confirm a change works.
---

# Verifying changes without a host toolchain

The maintainer's machine has Docker but **no `node`/`pnpm` on `PATH`**. All
verification goes through the `./codedeck` script, which spins up a throwaway
`node` container, installs deps with `pnpm install --frozen-lockfile`, and runs
the workspace scripts inside it. Paths below are relative to the repo root.

## Primary path — always start here

```bash
./codedeck check        # typecheck + test, every package (bridge, mobile, packages/*)
./codedeck typecheck    # typecheck only — fastest signal while iterating
./codedeck test         # test only
```

`./codedeck check` being green is the bar for "done". It is the same set CI runs
(`.github/workflows/ci.yml`: recursive `typecheck` + `test` + `build` + a bridge
smoke test), so a green local `check` should mean a green CI `verify` job.

- First run pulls `node:22-slim` and does a full `pnpm install` — a few minutes.
- The container is removed on exit (success, failure, or Ctrl-C).
- `git` is installed inside it automatically for `test` (one suite shells out to
  git); `typecheck` skips that.

To iterate on one package without the full sweep, run the filtered form the
script uses under the hood, e.g. `pnpm --filter @codedeck/mobile run test` — but
prefer `./codedeck test` for the final check before committing.

## When the Rust side is involved

`./codedeck` does not compile the `src-tauri` / `tauri-plugin-*` crates. If a
change touches `apps/mobile/src-tauri/**` or `apps/mobile/tauri-plugin-*/**`, CI
runs `cargo test` for it (path-filtered) — note in the PR that the Rust suite is
CI-only from here.

## Opt-in: building an APK or running the bridge

Do these **only when the user explicitly asks** to build an APK, run the bridge,
or check something in the real app — never on your own initiative just because a
change is UI- or bridge-facing. The `check` sweep above is the default proof.

```bash
./codedeck apk debug       # fast, unstripped, Android debug keystore
./codedeck apk benchmark   # release-optimized .so, debug-signed so it installs
./codedeck bridge up       # build + start the bridge service (Docker Compose)
./codedeck bridge logs     # follow its logs
./codedeck bridge pair     # print the most recent pairing QR / URL
./codedeck bridge down
```

The APK toolchain image is several GB and slow on first build. A real signed
release APK is produced only by `.github/workflows/release.yml` on a tag, not by
this script (see the `cut-release` skill).

## Reporting

If Docker is unavailable and you could not run any of the above, say so plainly
in the summary and PR — do not imply the checks passed. Paste the failing
assertion, not just "tests failed", when something breaks.
