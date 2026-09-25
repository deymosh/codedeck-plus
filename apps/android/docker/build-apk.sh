#!/usr/bin/env bash
# Build a debug apk for apps/android inside Docker — no Android Studio/Rust/
# NDK needed on the host. Output lands in dist/.
#
# Usage: apps/android/docker/build-apk.sh [--target <abi>]...
#   (default targets: aarch64-linux-android x86_64-linux-android — a real
#   device and an emulator, both in one APK)
#
# Debug builds only: the signed release APK is built by
# .github/workflows/release.yml from a version tag.
#
# First run builds the toolchain image (Android SDK/NDK 28 + Rust) — several
# GB, several minutes. Reruns reuse Docker's layer cache plus the cargo and
# Gradle cache volumes (see below), so they are incremental.
set -euo pipefail

# Git Bash (MSYS) on Windows rewrites leading-/ arguments as if they were
# Windows paths before docker.exe ever sees them — breaks `docker exec -w
# /path ...` if left on globally, but ALSO breaks `docker cp <host-path> ...`
# if left on globally — so it's set per-call (dexec helper), not exported.
# No-op on real Linux/macOS.
dexec() { MSYS_NO_PATHCONV=1 docker exec "$@"; }
dcp() { MSYS_NO_PATHCONV=1 docker cp "$@"; }

TARGETS=(aarch64-linux-android x86_64-linux-android)
_targets_set=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target) [ -z "$_targets_set" ] && TARGETS=(); _targets_set=1; TARGETS+=("$2"); shift 2 ;;
    --target=*) [ -z "$_targets_set" ] && TARGETS=(); _targets_set=1; TARGETS+=("${1#--target=}"); shift ;;
    *) echo "usage: $0 [--target <rust-triple>]..." >&2; exit 1 ;;
  esac
done

# Rust triple -> Android ABI name (jniLibs/ subdirectory + NDK clang prefix).
abi_of() {
  case "$1" in
    aarch64-linux-android) echo "arm64-v8a" ;;
    x86_64-linux-android) echo "x86_64" ;;
    armv7-linux-androideabi) echo "armeabi-v7a" ;;
    i686-linux-android) echo "x86" ;;
    *) echo "unknown target: $1" >&2; exit 1 ;;
  esac
}
# NDK per-ABI clang target name differs from the Rust triple only for arm32
# (NDK uses "armv7a-linux-androideabi", Rust uses "armv7-linux-androideabi").
ndk_clang_target_of() {
  case "$1" in
    armv7-linux-androideabi) echo "armv7a-linux-androideabi" ;;
    *) echo "$1" ;;
  esac
}

cd "$(git rev-parse --show-toplevel)"
mkdir -p dist

IMAGE=codedeck-android-build
CONTAINER=codedeck-android-build-run

echo "==> Building toolchain image (cached after the first run)"
docker build -t "$IMAGE" -f apps/android/docker/Dockerfile apps/android/docker

# The container itself is throwaway, but the expensive state is not: the
# cargo registry, the cargo target dir and the Gradle user home (dependency
# jars, the build cache org.gradle.caching feeds, the configuration cache)
# live in named volumes, so a rerun recompiles only what changed instead of
# every crate and every Gradle task from scratch. `docker volume rm
# codedeck-android-{cargo-registry,target,gradle}` resets them.
echo "==> Copying source into a fresh container"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
MSYS_NO_PATHCONV=1 docker create --name "$CONTAINER" -m 6g \
  -v codedeck-android-cargo-registry:/opt/cargo/registry \
  -v codedeck-android-target:/workspace/target \
  -v codedeck-android-gradle:/gradle-home \
  -e GRADLE_USER_HOME=/gradle-home \
  "$IMAGE" sleep infinity >/dev/null
docker start "$CONTAINER" >/dev/null
trap 'docker rm -f "$CONTAINER" >/dev/null 2>&1 || true' EXIT

# Only what this build reads: the cargo workspace, the protocol corpus
# crates/protocol's build.rs embeds, and apps/android itself.
# shellcheck source=../../../scripts/lib/pack-repo.sh
. scripts/lib/pack-repo.sh
pack_repo_into "$CONTAINER" /workspace \
  Cargo.toml Cargo.lock crates apps/android

echo "==> Regenerating the UniFFI Kotlin bindings (host target, no NDK needed for this step)"
dexec -w /workspace "$CONTAINER" cargo build --locked -p client-ffi --lib
dexec -w /workspace "$CONTAINER" cargo run --locked -p client-ffi --bin uniffi-bindgen -- \
  generate --library target/debug/libclient_ffi.so --language kotlin --no-format \
  --out-dir /tmp/uniffi-kotlin-out
dexec "$CONTAINER" rm -rf /workspace/apps/android/app/src/main/java/uniffi
dexec "$CONTAINER" cp -r /tmp/uniffi-kotlin-out/uniffi /workspace/apps/android/app/src/main/java/uniffi

echo "==> Cross-compiling crates/client-ffi for: ${TARGETS[*]}"
NDK_TOOLCHAIN=/opt/android-sdk/ndk/28.2.13676358/toolchains/llvm/prebuilt/linux-x86_64
for target in "${TARGETS[@]}"; do
  abi="$(abi_of "$target")"
  clang_target="$(ndk_clang_target_of "$target")"
  env_upper="$(echo "$target" | tr 'a-z-' 'A-Z_')"
  dexec -w /workspace "$CONTAINER" env \
    "CC_${target//-/_}=${NDK_TOOLCHAIN}/bin/${clang_target}26-clang" \
    "AR_${target//-/_}=${NDK_TOOLCHAIN}/bin/llvm-ar" \
    "CARGO_TARGET_${env_upper}_LINKER=${NDK_TOOLCHAIN}/bin/${clang_target}26-clang" \
    cargo build --locked -p client-ffi --lib --target "$target" --release
  dexec "$CONTAINER" mkdir -p "/workspace/apps/android/app/src/main/jniLibs/$abi"
  dexec "$CONTAINER" cp "/workspace/target/$target/release/libclient_ffi.so" \
    "/workspace/apps/android/app/src/main/jniLibs/$abi/libclient_ffi.so"
done

echo "==> Building the debug APK (Gradle)"
# The container's copy of the tree has no .git, so the commit the APK's
# versionName carries is resolved here, on the host (see build.gradle.kts).
GIT_REV="$(git describe --always --dirty --exclude='*')"
dexec -w /workspace/apps/android -e ANDROID_HOME=/opt/android-sdk "$CONTAINER" \
  gradle assembleDebug -PcodedeckGitRev="$GIT_REV" --console=plain

OUT="apps/android/app/build/outputs/apk/debug/app-debug.apk"
DEST="dist/codedeck-android-debug.apk"
dcp "$CONTAINER":/workspace/"$OUT" "$DEST"

echo
echo "==> Done: $DEST ($(du -h "$DEST" | cut -f1))"
echo "    Install: adb install $DEST"
