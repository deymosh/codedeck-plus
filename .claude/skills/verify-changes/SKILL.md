---
name: verify-changes
description: Verify a change in this repository when there is no Node/Rust toolchain on the host — run the agent host, Rust and Android checks through ./codedeck (in Docker, or on the toolchain it vendors), and know when an APK or a running bridge is actually needed. Use before committing, when asked to run the tests, or to confirm a change works.
---

# Verifying changes without a host toolchain

The maintainer's machine has **no `node`/`pnpm`/`cargo` on `PATH`** to rely
on. All verification goes through the `./codedeck` script, which runs each
check where a toolchain is: in throwaway containers (Node for the agent host,
Rust for the crates), or on the toolchain it vendors into `./toolchain/` when
`CODEDECK_ENGINE=local` is set or there is no Docker. The commands are the
same either way. Paths below are relative to the repo root.

## Primary path — always start here

```bash
./codedeck check            # the bar: agent host typecheck + test + build; cargo
                            # clippy, test and doc (-D warnings) for every crate
./codedeck check --changed  # the same, for the parts that differ from master —
                            # and the app's bar (bindings, tests, snapshots,
                            # lint) when its inputs do
./codedeck typecheck        # typecheck / clippy only — fastest signal while iterating
./codedeck test             # tests only
./codedeck e2e              # the two ignored tests that drive a built host from Rust
./codedeck ci [PR]          # after the push: the PR's checks, and each failure's log tail
```

`./codedeck check` being green is the bar for "done". It runs what CI's
agent host job and the workspace half of its Rust job run; CI adds the
generated-file drift checks (`./codedeck regen` keeps those current), the two
ignored tests (`./codedeck e2e`), the same host tests on Windows, and the
Android job.

Read its output whole — do not redirect it to a file and tail it. Every step
runs (a red clippy does not hide the tests), and the last lines list each
step. Without a terminal a step prints one line, or the end of its log when it
failed; the full output of each is in `dist/logs/<step>.log`.

What to run for what changed:

| changed | while iterating | before the PR |
| --- | --- | --- |
| a driver, anything in `packages/agent-host` | `dev vitest run <file> [-t name]` | `check --changed` |
| a crate | `dev cargo test -p <crate> [name]` | `check --changed` |
| a `Cargo.toml` | `regen cargo-lock` | `check` |
| a driver-protocol type (`crates/agent-protocol`) | `regen ts` | `check`, `e2e` |
| an FFI type (`crates/client-ffi`), even a doc comment | `regen bindings` | `check --changed` |
| a `package.json` | `regen pins` | `check` |
| `apps/android` | `android test --tests <Class>` | `check --changed` (or `android test verifyPaparazziDebug lintDebug`) |
| the bridge ⇄ host seam, process spawning | `e2e` | `check`, `e2e` |
| `codedeck`, a script | `bash -n <file>`, then the command itself | the command on both a pass and a failure |

- First run pulls the base images and does a full compile — a few minutes.
  After that, the pnpm store, cargo registry and target dir live in named
  volumes, so reruns only rebuild what changed.
- Each check's container is removed on exit (success, failure, or Ctrl-C).
- `CODEDECK_CPUS=<cores>` / `CODEDECK_MEMORY=<4g>` bound every container the
  script runs, for a machine someone is also working on.

- `CODEDECK_ENGINE=local` runs a command without Docker where the host has a
  toolchain for it, installed into `./toolchain/` on first use. On Windows
  that is everything but the APK build: `check`, `e2e`, `dev`, `live`,
  `regen` and `android` then run in this tree, natively — no container, no
  tree to sync. The agent host runs as the Windows CI job runs it, which is
  also how to reproduce a failure only that job shows. The crates are built with Rust's GNU
  toolchain, where CI's Windows job uses MSVC and CI's bar is Linux: a
  Windows build never compiles `cfg(unix)` code (the terminal, mostly), so
  after touching it run `CODEDECK_ENGINE=docker ./codedeck check --changed`
  once before the PR. `apk` still goes to Docker and says so.
  `./codedeck doctor` shows which is in force.
- Every step of a sweep prints how long it took, and a stale generated file
  (the host's protocol types, the UniFFI bindings) fails its step once and
  is left regenerated: review it, commit it, run again.

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

The sync overwrites the container's tree, so a file a tool generates is never
produced by hand in there: `./codedeck regen <cargo-lock|ts|pins|bindings>`
runs the generator and writes the result back to this tree, and says whether
anything changed. After changing a type in `crates/agent-protocol`, run
`regen ts` first or the host will not typecheck.

## Android tests and lint

```bash
./codedeck android test          # app:testDebugUnitTest, then the counts and any failing class
./codedeck android lint          # app:lintDebug, then what the report says
./codedeck android paparazzi     # the snapshot tests
./codedeck android snapshot      # re-record them; goldens copied back to review
./codedeck android <task>        # any other Gradle task, passed through
```

Without a terminal Gradle's own output goes to `dist/logs/android.log` and
the command prints the report — the counts, the classes that failed, lint's
verdict for this run — plus the end of the log when the run failed
(`--verbose` streams everything). The bar for lint is no errors; the three
"a newer version is available" warnings it reports today are a Gradle/AGP
bump waiting to be done, not something a change introduced.

Gradle runs without `--offline` on purpose: AGP resolves the platform DSL's
`release(37)` to `android-37.0`, which the toolchain image does not carry, so
the first run downloads it. Offline it stops with a message that reads like a
missing SDK.

## Asking a real agent

For anything about what an agent actually sends, or what the phone actually
ends up being shown, run one real session instead of writing a probe. Three
tiers, cheapest first — pick by what needs proving:

```bash
# 1. The scripted test agent: the driver protocol's own plumbing, no SDK, no model.
./codedeck live fake --prompt permission

# 2. A real agent against a local model server: real CLI, real session, fake
#    model. No account, no network, the same bytes every run.
./codedeck live claude-code --fake-model --prompt /tool
./codedeck live opencode    --fake-model --prompt /question --prompt /long
./codedeck live deepseek-harness --fake-model --prompt /error
./codedeck live qwen-code   --fake-model --prompt /tool

# 3. A real model. Free on OpenCode's Zen models; anything else spends the account.
./codedeck live opencode --model opencode/cat-jam-free --prompt "Reply with exactly: ok"
./codedeck live opencode --models      # what it offers, and which one a session defaults to
```

It prints every transcript entry, turn state, context figure and error as they
arrive, and keeps the log at `dist/live-<agent>.log`.

### Tier 2: the fake model

`--fake-model` starts `packages/agent-host/tools/fake-model.mjs` on loopback
and binds the session to it as a provider profile, so the agent runs the model
it is given (`fake-model-1`) and nothing reaches an account whatever an
agent's banner says. Each prompt is a scenario, the same vocabulary the `fake`
agent uses:

| prompt | what it makes the agent do |
| --- | --- |
| `/tool [command]` | call its own shell tool (a permission card on OpenCode) |
| `/question` | ask one multiple-choice question (a question form/card) |
| `/plan-approval` | propose a plan for approval (a plan card; needs plan mode) |
| `/error` | answer with a 400, exercising the failure path |
| `/long` | answer with a long text and a large context figure |
| anything else | echoed back as the agent's text |

`--dump DIR` writes every request the agent made, which is the fastest way to
see what a driver actually sends. Add `--mode`, `--model` or `--effort` as
usual — a scenario is a prompt, not a setup step.

What each agent does with a scenario differs, and that is the point of running
it: OpenCode raises a permission card for `/tool` (its v2 policy auto-allows
everything, and the driver still asks first); Claude Code 2.1.283 answers a
tool call through its own auto-mode safety classifier instead of asking the
user, so `/tool` there proves the tool round trip rather than a card, and a
permission card needs a hook's ask; the DeepSeek Harness validates model ids
against its own table, so it keeps its own model name while every request still
goes to the stub.

Tier 2 is deterministic, so it is also what CI runs:
`packages/agent-host/src/drivers/claude/__tests__/claudeFakeModel.test.ts`
drives the real `claude` binary (the SDK's own platform package) through the
driver against the stub, and skips with a reason where that package is not
installed.

Tier 3 is for fidelity — only a real model picks its own tool arguments and
writes prose. Claude and DeepSeek have no free path, so a real-model run there
spends the account: pass `--model` deliberately, and never borrow the bridge's
credentials for it.

## Opt-in: building an APK or running the bridge

Do these **only when the user explicitly asks** to build an APK, run the
bridge, or check something in the real app — never on your own initiative just
because a change is UI- or bridge-facing. The `check` sweep above is the default
proof.

```bash
./codedeck apk             # debug APK of apps/android into dist/ (Docker; several GB first run)
./codedeck apk --target aarch64-linux-android   # the phone's build, and nothing else:
                           # dist/codedeck-plus-<rev>-debug-arm64-v8a.apk
./codedeck bridge up       # build + start the bridge service (Docker Compose)
./codedeck bridge logs     # follow its logs
./codedeck bridge pair     # open a pairing window on the running bridge: QR + URL
./codedeck bridge down
```

A real signed release APK is produced only by `.github/workflows/release.yml`
on a tag, not by this script (see the `cut-release` skill).

## Reporting

If Docker is unavailable and you could not run any of the above, say so plainly
in the summary and PR — do not imply the checks passed. Paste the failing
assertion, not just "tests failed", when something breaks.
