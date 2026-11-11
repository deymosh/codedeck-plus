#!/usr/bin/env bash
# Behaviour tests for ./codedeck: the step runner, `--changed`, the limits and
# the argument handling — the parts of the script that decide what runs and
# what a caller is told, which no other check exercises.
#
#   bash scripts/tests/codedeck.test.sh
#
# The script under test is copied into a throwaway git repository whose
# toolchain is three stubs (pnpm, cargo, gradlew) that record how they were
# called and fail on request, so a run needs no Docker, no network and no
# real toolchain, and takes seconds. The local engine is what runs: it is the
# one whose commands can be replaced by putting a directory on PATH. What the
# stubs cannot show — that the real tools take these arguments — is what
# `./codedeck check` itself proves on every change.
set -euo pipefail

SOURCE="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
REPO="$WORK/repo"
STUBS="$WORK/stubs"
export STUB_LOG="$WORK/calls.log"

# --- The sandbox repository. ---
BINDINGS=apps/android/app/src/main/java/uniffi
mkdir -p "$REPO/scripts" "$STUBS" "$REPO/packages/agent-host" "$REPO/crates/protocol/src" \
  "$REPO/crates/bridge-core/src" "$REPO/$BINDINGS"
cp "$SOURCE/codedeck" "$REPO/codedeck"
cp -R "$SOURCE/scripts/lib" "$REPO/scripts/lib"
printf '{"packageManager": "pnpm@0.0.0"}\n' >"$REPO/package.json"
printf 'lockfileVersion: 0\n' >"$REPO/pnpm-lock.yaml"
printf '[workspace]\n' >"$REPO/Cargo.toml"
printf '// a crate\n' >"$REPO/crates/protocol/src/lib.rs"
printf '// a crate the app does not use\n' >"$REPO/crates/bridge-core/src/lib.rs"
printf 'bindings v1\n' >"$REPO/$BINDINGS/client_ffi.kt"
printf '// the app\n' >"$REPO/apps/android/app/App.kt"
printf '// a driver\n' >"$REPO/packages/agent-host/index.ts"
printf '# docs\n' >"$REPO/README.md"
printf '/toolchain/\n/dist/\n' >"$REPO/.gitignore"

# The installer's stand-in: what `./codedeck` asks of the real one is an
# env.sh, in the repository's toolchain directory, that puts the toolchain on
# PATH — and here the toolchain is the stubs.
cat >"$REPO/scripts/install-toolchain.sh" <<EOF
#!/usr/bin/env bash
. scripts/lib/toolchain-dir.sh
mkdir -p "\$(toolchain_dir)"
printf 'installer %s\n' "\$*" >>"$STUB_LOG"
printf 'export PATH="%s:\$PATH"\n' "$STUBS" >"\$(toolchain_dir)/env.sh"
EOF

# A stub records its name, arguments and the limits it was handed, and fails
# when STUB_FAIL names a word of its command line. Asked for bindings (an
# `--out-dir`), it writes the one file uniffi-bindgen would, holding
# STUB_BINDINGS — so a test decides whether the tree's copy is current.
make_stub() {
  cat >"$1" <<'EOF'
#!/usr/bin/env bash
name="$(basename "$0")"
printf '%s %s [jobs=%s tests=%s vitest=%s] target=%s\n' "$name" "$*" \
  "${CARGO_BUILD_JOBS:-}" "${RUST_TEST_THREADS:-}" "${VITEST_MAX_FORKS:-}" \
  "${CARGO_TARGET_DIR:-}" >>"$STUB_LOG"
echo "$name: ran $*"
previous=""
for arg in "$@"; do
  if [ "$previous" = "--out-dir" ]; then
    mkdir -p "$arg/uniffi"
    printf 'bindings %s\n' "${STUB_BINDINGS:-v1}" >"$arg/uniffi/client_ffi.kt"
  fi
  previous="$arg"
done
for word in ${STUB_FAIL:-}; do
  case " $name $* " in
    *" $word "*)
      echo "$name: the stub was told to fail on '$word'" >&2
      exit 3
      ;;
  esac
done
exit 0
EOF
  chmod +x "$1"
}
make_stub "$STUBS/pnpm"
make_stub "$STUBS/cargo"
make_stub "$REPO/apps/android/gradlew"

git -C "$REPO" init -q -b master
git -C "$REPO" -c user.name=test -c user.email=test@example.invalid add -A
git -C "$REPO" -c user.name=test -c user.email=test@example.invalid commit -q -m base
git -C "$REPO" update-ref refs/remotes/origin/master HEAD

# --- Running the script, and saying what was expected of it. ---
FAILED=0
PASSED=0
OUT=""
CODE=0

# run [VAR=value…] -- <codedeck args…>: the script in the sandbox (in
# $RUN_IN, the main checkout unless a test says otherwise), on the local
# engine, with no terminal. Output (both streams) lands in $OUT, the exit
# code in $CODE, and what the stubs were called with in $STUB_LOG.
RUN_IN="$REPO"
run() {
  local env=()
  while [ "$1" != "--" ]; do
    env+=("$1")
    shift
  done
  shift
  : >"$STUB_LOG"
  CODE=0
  OUT="$(cd "$RUN_IN" && env -u CODEDECK_CPUS -u CODEDECK_MEMORY -u CODEDECK_TIMEOUT \
    -u CARGO_BUILD_JOBS -u RUST_TEST_THREADS -u VITEST_MAX_FORKS -u VITEST_MAX_THREADS \
    -u CARGO_TARGET_DIR -u CODEDECK_TOOLCHAIN -u GRADLE_USER_HOME \
    CODEDECK_ENGINE=local ${env[@]+"${env[@]}"} bash ./codedeck "$@" 2>&1 </dev/null)" || CODE=$?
}

calls() { cat "$STUB_LOG"; }

ok() {
  PASSED=$((PASSED + 1))
}

fail() {
  FAILED=$((FAILED + 1))
  echo "FAIL: $TEST — $1"
  echo "  exit code: $CODE"
  echo "  output:"
  printf '%s\n' "$OUT" | sed 's/^/    /'
  echo "  stub calls:"
  calls | sed 's/^/    /'
}

expect_code() {
  if [ "$CODE" = "$1" ]; then ok; else fail "expected exit code $1"; fi
}

expect_out() {
  case "$OUT" in
    *"$1"*) ok ;;
    *) fail "expected the output to hold: $1" ;;
  esac
}

expect_no_out() {
  case "$OUT" in
    *"$1"*) fail "expected the output NOT to hold: $1" ;;
    *) ok ;;
  esac
}

expect_call() {
  case "$(calls)" in
    *"$1"*) ok ;;
    *) fail "expected a stub call holding: $1" ;;
  esac
}

expect_no_call() {
  case "$(calls)" in
    *"$1"*) fail "expected NO stub call holding: $1" ;;
    *) ok ;;
  esac
}

# Put the sandbox back to its first commit between tests.
reset_repo() {
  git -C "$REPO" reset -q --hard
  git -C "$REPO" clean -q -fd
  rm -rf "$REPO/dist"
}

# --- The step runner. ---

TEST="a green sweep lists every step and exits 0"
run -- check
expect_code 0
for step in "host: install" "host: typecheck" "host: test" "host: build" \
  "crates: clippy" "crates: test" "crates: doc" "crates: host types"; do
  expect_out "ok      $step "
done
expect_no_call "gradlew"
expect_call "cargo clippy --locked --workspace --all-targets -- -D warnings"
expect_call "cargo doc --locked --workspace --no-deps"
expect_no_out "cargo: ran"

TEST="a failing step is reported with its log, and the steps after it still run"
run STUB_FAIL=clippy -- check
expect_code 1
expect_out "crates: clippy     FAILED (exit 3, "
expect_out "the stub was told to fail on 'clippy'"
expect_out "FAILED  crates: clippy"
expect_out "ok      crates: test"
expect_out "ok      crates: doc"
expect_call "cargo test --locked --workspace"

TEST="a step's whole output is kept in dist/logs"
if grep -q "cargo: ran clippy" "$REPO/dist/logs/crates-clippy.log"; then ok; else fail "no log file for the clippy step"; fi

TEST="a failed install skips the steps that need it, and the other half runs"
run STUB_FAIL=install -- check
expect_code 1
expect_out "FAILED  host: install"
expect_no_call "pnpm -r --no-bail run test"
expect_out "ok      crates: test"

TEST="--verbose streams the output instead of filing it"
run -- test --verbose
expect_code 0
expect_out "cargo: ran test --locked --workspace"

TEST="typecheck and test run their own steps only"
run -- typecheck
expect_call "cargo clippy"
expect_no_call "cargo test"
run -- test
expect_call "cargo test --locked --workspace"
expect_no_call "cargo clippy"
expect_no_call "run build"

TEST="an unknown option is a usage error"
run -- check --nope
expect_code 2
expect_out "usage:"

# --- --changed. ---

TEST="--changed with nothing changed runs nothing"
reset_repo
run -- check --changed
expect_code 0
expect_out "Nothing to run."
expect_no_call "cargo"
expect_no_call "pnpm"

TEST="--changed runs the agent host's half for a change under packages/"
reset_repo
echo "// edited" >>"$REPO/packages/agent-host/index.ts"
run -- check --changed
expect_code 0
expect_call "pnpm -r --no-bail run test"
expect_no_call "cargo"
expect_out "no crate differs from master"

TEST="--changed runs the crates' half for a committed change under crates/"
reset_repo
git -C "$REPO" checkout -q -b work
echo "// edited" >>"$REPO/crates/bridge-core/src/lib.rs"
git -C "$REPO" -c user.name=test -c user.email=test@example.invalid commit -q -am edit
run -- check --changed
expect_code 0
expect_call "cargo test --locked --workspace"
expect_no_call "pnpm"
expect_no_call "gradlew"
expect_out "nothing the app is built from differs from master"
git -C "$REPO" checkout -q master
git -C "$REPO" branch -q -D work

TEST="--changed counts a new, untracked file"
reset_repo
echo "// new" >"$REPO/crates/bridge-core/src/new.rs"
run -- check --changed
expect_call "cargo clippy"

TEST="--changed runs the app's bar for a change under apps/android, and nothing else"
reset_repo
echo "// edited" >>"$REPO/apps/android/app/App.kt"
run -- check --changed
expect_code 0
expect_call "gradlew testDebugUnitTest verifyPaparazziDebug lintDebug"
expect_out "ok      android: bindings "
expect_out "ok      android: gradle "
expect_no_call "cargo clippy"
expect_no_call "pnpm"

TEST="--changed runs the crates and the app for a crate the app is built from"
reset_repo
echo "// edited" >>"$REPO/crates/protocol/src/lib.rs"
run -- check --changed
expect_call "cargo clippy"
expect_call "gradlew testDebugUnitTest verifyPaparazziDebug lintDebug"

TEST="test --changed and typecheck --changed give the app their own tasks"
run -- test --changed
expect_call "gradlew testDebugUnitTest verifyPaparazziDebug --console=plain"
expect_no_out "android: bindings"
run -- typecheck --changed
expect_call "gradlew compileDebugUnitTestKotlin"

TEST="a failing Gradle run fails the sweep and shows the end of its output"
run STUB_FAIL=lintDebug -- check --changed
expect_code 1
expect_out "FAILED  android: gradle "
expect_out "the stub was told to fail on 'lintDebug'"

TEST="stale bindings fail the step once, and are left regenerated"
reset_repo
echo "// edited" >>"$REPO/apps/android/app/App.kt"
run STUB_BINDINGS=v2 -- check --changed
expect_code 1
expect_out "FAILED  android: bindings "
expect_out "was stale and has been regenerated"
if [ "$(cat "$REPO/$BINDINGS/client_ffi.kt")" = "bindings v2" ]; then ok; else fail "the regenerated bindings were not left in the tree"; fi
run STUB_BINDINGS=v2 -- check --changed
expect_code 0
expect_out "ok      android: bindings "

TEST="a plain check leaves the app out"
reset_repo
echo "// edited" >>"$REPO/apps/android/app/App.kt"
run -- check
expect_no_call "gradlew"

TEST="--changed ignores a change no check covers"
reset_repo
echo "more" >>"$REPO/README.md"
run -- check --changed
expect_out "Nothing to run."

TEST="--changed without an origin/master runs everything"
reset_repo
git -C "$REPO" update-ref -d refs/remotes/origin/master
run -- check --changed
expect_out "running everything"
expect_call "cargo test"
expect_call "pnpm -r --no-bail run test"
git -C "$REPO" update-ref refs/remotes/origin/master HEAD

# --- Limits. ---

TEST="CODEDECK_CPUS sizes cargo, the tests and vitest on the local engine"
reset_repo
run CODEDECK_CPUS=3 -- check
expect_call "cargo test --locked --workspace [jobs=3 tests=3 vitest=3]"
expect_call "run test [jobs=3 tests=3 vitest=3]"

TEST="CODEDECK_CPUS sizes Gradle's workers"
run CODEDECK_CPUS=3 -- android test
expect_call "gradlew testDebugUnitTest --max-workers 3 --console=plain"
run -- android lint
expect_call "gradlew lintDebug --console=plain"

TEST="without CODEDECK_CPUS nothing is limited"
run -- test
expect_call "cargo test --locked --workspace [jobs= tests= vitest=]"

TEST="a limit the caller set for one tool is kept"
run CODEDECK_CPUS=3 CARGO_BUILD_JOBS=7 -- test
expect_call "cargo test --locked --workspace [jobs=7 tests=3 vitest=3]"

TEST="CODEDECK_CPUS must be a number of cores"
run CODEDECK_CPUS=many -- check
expect_code 2
expect_out "CODEDECK_CPUS must be a number of cores"
run CODEDECK_CPUS=0 -- check
expect_code 2

TEST="CODEDECK_ENGINE takes local or docker only"
run CODEDECK_ENGINE=podman -- check
expect_code 2
expect_out "CODEDECK_ENGINE must be 'local' or 'docker'"

# --- dev, e2e, regen: what reaches the toolchain. ---

TEST="dev runs the command in the tree and passes its exit code on"
run -- dev cargo test -p protocol
expect_code 0
expect_call "cargo test -p protocol"
expect_out "cargo: ran test -p protocol"
run STUB_FAIL=protocol -- dev cargo test -p protocol
expect_code 3

TEST="dev installs only what the command names"
run -- dev cargo --version
expect_call "installer rust"
expect_no_call "installer node"
expect_no_call "pnpm install"
run -- dev pnpm --version
expect_call "installer node"

TEST="dev --timeout needs a number"
run -- dev --timeout soon cargo test
expect_code 2

# --- Worktrees. ---

# A path as the script hands it to a native program (C:/… under Git Bash).
native() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

TEST="a linked worktree uses the main checkout's toolchain and cargo target"
reset_repo
rm -rf "$REPO/toolchain"
git -C "$REPO" worktree add -q "$WORK/linked" -b linked
RUN_IN="$WORK/linked"
run -- dev cargo build
expect_code 0
expect_call "cargo build [jobs= tests= vitest=] target=$(native "$(cd "$REPO" && pwd -P)/target")"
if [ -f "$REPO/toolchain/env.sh" ] && [ ! -e "$WORK/linked/toolchain" ]; then ok; else fail "the toolchain was not installed into the main checkout alone"; fi

TEST="a worktree keeps a cargo target the caller chose"
run CARGO_TARGET_DIR=/elsewhere -- dev cargo build
expect_call "target=/elsewhere"
RUN_IN="$REPO"
git -C "$REPO" worktree remove --force "$WORK/linked"
git -C "$REPO" branch -q -D linked

TEST="the main checkout builds into its own target directory"
run -- dev cargo build
expect_call "cargo build [jobs= tests= vitest=] target="
expect_no_call "target=$(native "$(cd "$REPO" && pwd -P)/target")"

TEST="e2e builds the host first, and runs neither test without the bundle"
run -- e2e
expect_code 0
expect_out "ok      bridge end to end"
run STUB_FAIL=build -- e2e
expect_code 1
expect_out "FAILED  host: build"
expect_no_call "cargo test"

TEST="regen takes a known kind only"
run -- regen everything
expect_code 2
expect_out "kinds:"

TEST="an unknown command prints the usage and fails"
run -- frobnicate
expect_code 1
expect_out "unknown command: frobnicate"

echo
if [ "$FAILED" -gt 0 ]; then
  echo "codedeck tests: $FAILED failed, $PASSED passed"
  exit 1
fi
echo "codedeck tests: $PASSED passed"
