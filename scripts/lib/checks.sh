# shellcheck shell=bash
# Sourced by `codedeck` (at the point the check pipeline used to sit): the
# workspace checks behind `check`, `typecheck` and `test` — each step run and
# remembered, the summary, `--changed`, and the Docker and local paths. It
# uses the script's own helpers and globals, so it is not run on its own.

# --- Workspace checks, in throwaway containers — nothing needs to be
# installed on the host.
#
# TypeScript (the agent host): a Node image with git and the pnpm pinned by
# package.json's packageManager; downloaded packages persist in the
# codedeck-pnpm-store volume, so `pnpm install` only fetches what the lockfile
# changed. Only the pnpm workspace is copied.
#
# Rust (every crate): the stock Rust image with clippy; the cargo registry
# and target dir live in named volumes, so a rerun only recompiles what
# changed. Only the cargo workspace is copied. ---

# The one Node image the checks and the dev container share (scripts/docker/
# node.Dockerfile), so a dependency is downloaded once into one store volume.
ensure_node_image() {
  local pnpm_version
  pnpm_version="$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' package.json)"
  ensure_tool_image codedeck-node "$TOOL_IMAGE_DIR/node.Dockerfile" --build-arg "PNPM_VERSION=$pnpm_version"
}

check_typescript() {
  local name="codedeck-check-$$"
  ensure_node_image
  start_throwaway "$name" codedeck-node -v codedeck-pnpm-store:/pnpm-store

  pack_repo_into "$name" /app package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json packages
  # Nothing after a failed install can pass, and each would only repeat it.
  step "host: install" dexec -w /app "$name" pnpm install --frozen-lockfile || return 0
  case "$1" in
    typecheck) step "host: typecheck" dexec -w /app "$name" pnpm -r --no-bail run typecheck || true ;;
    test) step "host: test" dexec -w /app "$name" pnpm -r --no-bail run test || true ;;
    check)
      step "host: typecheck" dexec -w /app "$name" pnpm -r --no-bail run typecheck || true
      step "host: test" dexec -w /app "$name" pnpm -r --no-bail run test || true
      step "host: build" dexec -w /app "$name" pnpm -r --no-bail run build || true
      ;;
  esac
}

check_rust() {
  local name="codedeck-check-rust-$$"
  ensure_tool_image codedeck-check-rust "$TOOL_IMAGE_DIR/rust.Dockerfile"
  start_throwaway "$name" codedeck-check-rust \
    -v codedeck-cargo-registry:/usr/local/cargo/registry \
    -v codedeck-check-target:/repo/target

  # The pack list must carry every file outside crates/ the workspace reads
  # at compile time: bridge-runtime's tests include_str! config.example.json,
  # and client-ffi's corpus test the Android copy of the display corpus.
  pack_repo_into "$name" /repo crates Cargo.toml Cargo.lock config.example.json \
    apps/android/app/src/test/resources/display_entries_corpus.json
  rust_steps "$1" dexec -w /repo "$name"
}

# The crate steps, behind whatever prefix runs a command where the crates are
# (`dexec … <container>` on the Docker engine, nothing locally). `cargo doc`
# is part of the bar: crates/protocol's docs are the spec other clients read,
# and CI fails on a broken intra-doc link.
rust_steps() {
  local mode="$1"
  shift
  case "$mode" in
    typecheck) step "crates: clippy" "$@" cargo clippy --locked --workspace --all-targets -- -D warnings || true ;;
    test) step "crates: test" "$@" cargo test --locked --workspace || true ;;
    check)
      step "crates: clippy" "$@" cargo clippy --locked --workspace --all-targets -- -D warnings || true
      step "crates: test" "$@" cargo test --locked --workspace || true
      step "crates: doc" "$@" env "RUSTDOCFLAGS=-D warnings" cargo doc --locked --workspace --no-deps || true
      ;;
  esac
}

# Same checks, on the local toolchain (no Docker). The Docker path packs
# only what each container needs; locally the whole repo is already here.
check_typescript_local() {
  # NODE_ENV inherited as production would make pnpm silently skip
  # devDependencies on install (and the toolchain this path runs —
  # typescript, vitest — IS devDependencies) and reach the tests, where the
  # Docker containers never set it. The containers run with it unset, so
  # unset it here too: same repo, same result either way.
  unset NODE_ENV
  step "host: install" env CI=true pnpm install --frozen-lockfile || return 0
  case "$1" in
    typecheck) step "host: typecheck" pnpm -r --no-bail run typecheck || true ;;
    test) step "host: test" pnpm -r --no-bail run test || true ;;
    check)
      step "host: typecheck" pnpm -r --no-bail run typecheck || true
      step "host: test" pnpm -r --no-bail run test || true
      step "host: build" pnpm -r --no-bail run build || true
      ;;
  esac
}

# --- One step of a check: run it, remember how it ended, go on to the next. ---
#
# A sweep reports every step, not the first failure — a red clippy says nothing
# about the tests, and finding that out should not cost a second run. With a
# terminal the output streams as it always did. Without one (a script, an
# agent) each step's output goes to dist/logs/ and the step prints one line,
# plus the tail of its log when it failed: a green sweep is then a dozen lines
# rather than several thousand, and the full output is one file away.
CHECK_LOG_DIR=dist/logs
CHECK_RESULTS=""
CHECK_STREAM=0
CHECK_TAIL=60

step() {
  local label="$1" slug log code=0 started=$SECONDS took
  shift
  if [ "$CHECK_STREAM" = 1 ]; then
    echo "==> $label"
    "$@" || code=$?
    took=$((SECONDS - started))
  else
    slug="$(printf '%s' "$label" | tr -cs 'a-z0-9' '-')"
    log="$CHECK_LOG_DIR/${slug%-}.log"
    printf '==> %-18s ' "$label"
    "$@" >"$log" 2>&1 </dev/null || code=$?
    took=$((SECONDS - started))
    if [ "$code" = 0 ]; then
      echo "ok (${took}s)"
    else
      echo "FAILED (exit $code, ${took}s) — the end of $log:"
      tail -n "$CHECK_TAIL" "$log" | sed 's/^/    /'
    fi
  fi
  printf '%s\t%s\t%s\n' "$code" "$took" "$label" >>"$CHECK_RESULTS"
  return "$code"
}

# Every step that ran, and one exit code for the lot.
check_summary() {
  local code took label failed=0
  if [ ! -s "$CHECK_RESULTS" ]; then
    rm -f "$CHECK_RESULTS"
    echo "==> Nothing to run."
    return 0
  fi
  echo
  echo "==> Summary"
  # Each step with how long it took: where a sweep's time goes is the first
  # thing to know before making it shorter.
  while IFS=$'\t' read -r code took label; do
    if [ "$code" = 0 ]; then
      printf '    ok      %-20s %4ss\n' "$label" "$took"
    else
      printf '    FAILED  %-20s %4ss\n' "$label" "$took"
      failed=1
    fi
  done <"$CHECK_RESULTS"
  rm -f "$CHECK_RESULTS"
  [ "$CHECK_STREAM" = 1 ] || echo "    full output: $CHECK_LOG_DIR/"
  return "$failed"
}

begin_steps() {
  mkdir -p "$CHECK_LOG_DIR"
  CHECK_RESULTS="$(mktemp)"
  if [ -t 1 ]; then CHECK_STREAM=1; fi
}

# Which parts of the tree differ from master, for `--changed`: what the branch
# committed, what is staged or edited, and what is new and not ignored. The
# path lists are the `changes` job's filters in .github/workflows/ci.yml —
# keep the two in step, or a sweep here skips what CI then runs.
CHANGED_HOST=1
CHANGED_RUST=1
CHANGED_ANDROID=0

detect_changes() {
  local base path
  if ! base="$(git merge-base HEAD origin/master 2>/dev/null)"; then
    echo "==> --changed: no origin/master to compare with — running everything"
    return 0
  fi
  CHANGED_HOST=0
  CHANGED_RUST=0
  while IFS= read -r path; do
    # The workflow itself counts for every part, as it does there.
    case "$path" in
      .github/workflows/ci.yml)
        CHANGED_HOST=1
        CHANGED_RUST=1
        CHANGED_ANDROID=1
        ;;
    esac
    case "$path" in
      packages/* | package.json | pnpm-lock.yaml | pnpm-workspace.yaml | tsconfig.base.json) CHANGED_HOST=1 ;;
    esac
    case "$path" in
      crates/* | Cargo.toml | Cargo.lock | config.example.json | \
        apps/android/app/src/test/resources/display_entries_corpus.json) CHANGED_RUST=1 ;;
    esac
    case "$path" in
      apps/android/* | crates/protocol/* | crates/nostr-transport/* | crates/client-core/* | \
        crates/client-runtime/* | crates/client-ffi/* | Cargo.toml | Cargo.lock) CHANGED_ANDROID=1 ;;
    esac
  done <<<"$(git diff --name-only "$base"; git ls-files --others --exclude-standard)"
  [ "$CHANGED_HOST" = 1 ] || echo "==> --changed: nothing under the agent host differs from master — skipped"
  [ "$CHANGED_RUST" = 1 ] || echo "==> --changed: no crate differs from master — skipped"
  [ "$CHANGED_ANDROID" = 1 ] || echo "==> --changed: nothing the app is built from differs from master — skipped"
}

# One of CI's drift checks, as a step: regenerate <kind> and fail when that
# changed anything under <path>. The regenerated files stay — they are what
# the tree should hold — so the failure is one to read, review and commit,
# and the same step passes on the next run.
# (Run through `step`, by name: ShellCheck cannot see that call.)
# shellcheck disable=SC2329
generated_current() {
  local kind="$1" path="$2" before after
  before="$(tree_digest "$path")"
  (cmd_regen "$kind")
  after="$(tree_digest "$path")"
  if [ "$before" != "$after" ]; then
    echo "$path was stale and has been regenerated: review the change and commit it."
    return 1
  fi
}

# What the files under a path hold, as one comparable string.
# shellcheck disable=SC2329
tree_digest() {
  if [ -e "$1" ]; then find "$1" -type f -exec git hash-object {} + | LC_ALL=C sort; fi
}

# The app's bar, for a sweep that found its inputs changed: the bindings CI
# regenerates and compares, then one Gradle run for the mode's tasks (one run,
# because Gradle's start-up is most of a small task's time).
android_steps() {
  local tasks=()
  case "$1" in
    typecheck) tasks=(compileDebugUnitTestKotlin) ;;
    test) tasks=(test verifyPaparazziDebug) ;;
    check)
      tasks=(test verifyPaparazziDebug lintDebug)
      step "android: bindings" generated_current bindings apps/android/app/src/main/java/uniffi || true
      ;;
  esac
  step "android: gradle" bash "$REPO_ROOT/codedeck" android "${tasks[@]}" || true
}

# Each Docker check in a subshell: start_throwaway's EXIT trap removes that
# container. The local path needs no cleanup.
run_checks() {
  local mode="$1" changed=0
  shift
  begin_steps
  while [ $# -gt 0 ]; do
    case "$1" in
      --changed) changed=1 ;;
      --verbose) CHECK_STREAM=1 ;;
      --quiet) CHECK_STREAM=0 ;;
      *)
        echo "usage: $0 $mode [--changed] [--verbose|--quiet]" >&2
        exit 2
        ;;
    esac
    shift
  done
  [ "$changed" = 1 ] && detect_changes

  # Each part on the engine that can run it: a host may have a local toolchain
  # for one and not for another. All are asked before any runs, so a daemon
  # that is down stops the sweep at the start rather than part of the way in.
  # The app is part of a sweep only under `--changed`, when its inputs
  # differ: its bar is minutes of Gradle, which a plain `check` of a change
  # that cannot reach the app should not pay.
  local host_state=0 rust_state=0 android_state=0 with_android=0
  if [ "$changed" = 1 ] && [ "$CHANGED_ANDROID" = 1 ]; then with_android=1; fi
  if [ "$CHANGED_HOST" = 1 ]; then engine_state node || host_state=$?; fi
  if [ "$CHANGED_RUST" = 1 ]; then engine_state rust || rust_state=$?; fi
  if [ "$with_android" = 1 ]; then engine_state android || android_state=$?; fi
  if [ "$host_state" = 2 ] || [ "$rust_state" = 2 ] || [ "$android_state" = 2 ]; then fail_docker_down; fi

  if [ "$CHANGED_HOST" = 1 ]; then
    if [ "$host_state" = 0 ]; then
      (check_typescript "$mode")
    else
      ensure_toolchain node
      check_typescript_local "$mode"
    fi
  fi
  if [ "$CHANGED_RUST" = 1 ]; then
    if [ "$rust_state" = 0 ]; then
      (check_rust "$mode")
    else
      ensure_toolchain rust
      rust_steps "$mode"
    fi
    # The host's protocol types are generated from crates/agent-protocol, and
    # CI fails on a stale copy.
    if [ "$mode" = check ]; then
      step "crates: host types" generated_current ts packages/agent-host/src/generated/protocol.ts || true
    fi
  fi
  if [ "$with_android" = 1 ]; then android_steps "$mode"; fi

  check_summary
}
