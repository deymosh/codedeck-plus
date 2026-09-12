#!/usr/bin/env bash
# Reproduce the F0 UniFFI-binding probe end to end, entirely in Docker (no host
# Rust/Kotlin toolchain needed — matches this repo's "everything via Docker").
#
#   ./spike/uniffi-binding-probe/run.sh
#
# Stages:
#   1. rust:1-bookworm   cargo test (native)  +  clippy  +  generate Kotlin bindings  +  cdylib
#   2. rust:1-bookworm   cargo check the Tauri `#[tauri::command]` consumer
#   3. temurin:17-jdk    Gradle: run the Kotlin/JVM tests THROUGH the real FFI (JNA)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
export MSYS_NO_PATHCONV=1

RUST_IMG=rust:1-bookworm
JDK_IMG=eclipse-temurin:17-jdk
CARGO_VOL=codedeck-spike-cargo
GRADLE_VOL=codedeck-spike-gradle

# the Gradle wrapper jar is a binary — not committed; borrow the repo's own
WRAPPER="$HERE/kotlin/gradle/wrapper/gradle-wrapper.jar"
if [ ! -f "$WRAPPER" ]; then
  cp "$REPO/apps/mobile/src-tauri/gen/android/gradle/wrapper/gradle-wrapper.jar" "$WRAPPER"
fi

run_rust() { docker run --rm -v "$REPO/spike/uniffi-binding-probe:/spike" -v "$CARGO_VOL:/root/cargotarget" \
  -e CARGO_TARGET_DIR=/root/cargotarget -w /spike "$RUST_IMG" bash -c "$1"; }

echo "== stage 1: Rust (native tests, clippy, bindgen, cdylib) =="
run_rust '
  set -e
  cd client-core-probe
  cargo test
  rustup component add clippy >/dev/null 2>&1 || true
  cargo clippy --all-targets -- -D warnings
  cargo build
  cargo run --bin uniffi-bindgen -- generate \
    --library "$CARGO_TARGET_DIR/debug/libclient_core_probe.so" \
    --language kotlin --out-dir /spike/kotlin/bindings
  mkdir -p /spike/kotlin/lib
  cp "$CARGO_TARGET_DIR/debug/libclient_core_probe.so" /spike/kotlin/lib/
  echo "--- nostr crate dependency footprint (plan risk #13) ---"
  cargo tree -e normal -p nostr --depth 1
'

echo "== stage 2: Tauri #[tauri::command] consumer (cargo check) =="
run_rust '
  apt-get update -qq && apt-get install -y -qq \
    libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev >/dev/null
  cd tauri-consumer && cargo check
'

echo "== stage 3: Kotlin/JVM tests through the real FFI =="
docker run --rm -v "$REPO/spike/uniffi-binding-probe:/spike" -v "$GRADLE_VOL:/root/.gradle" \
  -w /spike/kotlin "$JDK_IMG" sh -c './gradlew --no-daemon test'

echo
echo "ALL GREEN — see README.md for the Go/No-Go writeup."
