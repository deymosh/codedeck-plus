#!/usr/bin/env bash
# apps/android/scripts/build-apk-local.sh — builds a debug APK directly on
# this host: no Docker, no tar, no throwaway container. Run
# scripts/install-toolchain.sh once first (installs the Android SDK/NDK into
# ./toolchain/, gitignored, without touching any system path).
#
# Usage: apps/android/scripts/build-apk-local.sh [--target <rust-triple>]...
#   (default targets: aarch64-linux-android x86_64-linux-android)
#
# Linux only — see scripts/install-toolchain.sh's own header for why, and
# apps/android/docker/build-apk.sh for the Windows path.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [ -f toolchain/env.sh ]; then
  # shellcheck source=/dev/null
  source toolchain/env.sh
fi
if [ -z "${ANDROID_HOME:-}" ]; then
  echo "error: ANDROID_HOME not set and toolchain/env.sh not found — run" >&2
  echo "scripts/install-toolchain.sh first, or export ANDROID_HOME yourself" >&2
  echo "(a system Android SDK/NDK works too, this script doesn't require" >&2
  echo "the toolchain/ one specifically)." >&2
  exit 1
fi
NDK_VERSION="28.2.13676358"
NDK_TOOLCHAIN="${ANDROID_NDK_HOME:-$ANDROID_HOME/ndk/$NDK_VERSION}/toolchains/llvm/prebuilt/linux-x86_64"
if [ ! -d "$NDK_TOOLCHAIN" ]; then
  echo "error: NDK toolchain not found at $NDK_TOOLCHAIN" >&2
  exit 1
fi

TARGETS=(aarch64-linux-android x86_64-linux-android)
_targets_set=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target) [ -z "$_targets_set" ] && TARGETS=(); _targets_set=1; TARGETS+=("$2"); shift 2 ;;
    --target=*) [ -z "$_targets_set" ] && TARGETS=(); _targets_set=1; TARGETS+=("${1#--target=}"); shift ;;
    *) echo "usage: $0 [--target <rust-triple>]..." >&2; exit 1 ;;
  esac
done

abi_of() {
  case "$1" in
    aarch64-linux-android) echo "arm64-v8a" ;;
    x86_64-linux-android) echo "x86_64" ;;
    armv7-linux-androideabi) echo "armeabi-v7a" ;;
    i686-linux-android) echo "x86" ;;
    *) echo "unknown target: $1" >&2; exit 1 ;;
  esac
}
ndk_clang_target_of() {
  case "$1" in
    armv7-linux-androideabi) echo "armv7a-linux-androideabi" ;;
    *) echo "$1" ;;
  esac
}

echo "==> Regenerating the UniFFI Kotlin bindings (host target)"
cargo build --locked -p uniffi-bridge --lib
cargo run --locked -p uniffi-bridge --bin uniffi-bindgen -- \
  generate --library target/debug/libuniffi_bridge.so --language kotlin \
  --out-dir /tmp/uniffi-kotlin-out-$$
rm -rf apps/android/app/src/main/java/uniffi
cp -r "/tmp/uniffi-kotlin-out-$$/uniffi" apps/android/app/src/main/java/uniffi
rm -rf "/tmp/uniffi-kotlin-out-$$"

echo "==> Cross-compiling crates/uniffi-bridge for: ${TARGETS[*]}"
for target in "${TARGETS[@]}"; do
  abi="$(abi_of "$target")"
  clang_target="$(ndk_clang_target_of "$target")"
  env_upper="$(echo "$target" | tr 'a-z-' 'A-Z_')"
  env \
    "CC_${target//-/_}=${NDK_TOOLCHAIN}/bin/${clang_target}26-clang" \
    "AR_${target//-/_}=${NDK_TOOLCHAIN}/bin/llvm-ar" \
    "CARGO_TARGET_${env_upper}_LINKER=${NDK_TOOLCHAIN}/bin/${clang_target}26-clang" \
    cargo build --locked -p uniffi-bridge --lib --target "$target" --release
  mkdir -p "apps/android/app/src/main/jniLibs/$abi"
  cp "target/$target/release/libuniffi_bridge.so" "apps/android/app/src/main/jniLibs/$abi/libuniffi_bridge.so"
done

echo "==> Building the debug APK (Gradle)"
cd apps/android
./gradlew assembleDebug --console=plain
cd - >/dev/null

mkdir -p dist
cp apps/android/app/build/outputs/apk/debug/app-debug.apk dist/codedeck-android-debug.apk

echo
echo "==> Done: dist/codedeck-android-debug.apk ($(du -h dist/codedeck-android-debug.apk | cut -f1))"
echo "    Install: adb install dist/codedeck-android-debug.apk"
