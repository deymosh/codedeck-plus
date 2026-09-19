#!/usr/bin/env bash
# Build an apk for apps/mobile inside Docker — no Android Studio/Rust/NDK
# needed on the host. Output lands in dist/.
#
# Usage: apps/mobile/docker/build-apk.sh [debug|release|benchmark]
#   (default: debug)
#
# debug     — fast, unstripped, Android's auto debug keystore (no setup).
#             Only good for sideloading onto a test device: upstream
#             measured the debug arm64 .so at 226MB (see
#             .github/workflows/release.yml in codedeck-next-mobile) —
#             that's most of what makes this build huge.
# release   — minified + stripped .so via a real `cargo` release profile
#             (just dropping --debug from the CLI call, same as upstream's
#             release workflow). Upstream's own numbers: .so 24.3MB, whole
#             APK 45.6MB (that includes a 20.2MB mesh engine .so from a
#             nostr-vpn checkout we don't have here, so ours lands smaller
#             still — measured 34.8MB/31.5MB .so). UNSIGNED — Android
#             refuses to INSTALL an unsigned APK at all, so this is only
#             useful for inspecting size/build output, not for a phone.
# benchmark — the SAME release build (same .so, same minification/
#             stripping — nothing about the app's performance differs from
#             `release`), but re-signed with a debug keystore afterwards
#             (zipalign + apksigner, baked into the image) so it actually
#             installs on a device. This is what you want to test real
#             performance/size on a phone without a real signing identity.
#             The debug keystore here is NOT the one `debug` mode's build
#             auto-generates and is NOT a real release identity — it exists
#             solely so a release-optimized build can be sideloaded. For an
#             actually signed release (one an update mechanism/store would
#             trust) see vendor/mobile/scripts/build-release-apk.sh, which
#             needs a real keystore nobody has generated yet.
#
# First run builds the toolchain image (Android SDK/NDK 28 + Rust +
# cargo-tauri) — several GB, several minutes. Reruns reuse Docker's layer
# cache, so only the `docker exec` steps below actually redo work.
set -euo pipefail

# Git Bash (MSYS) on Windows rewrites leading-/ arguments as if they were
# Windows paths before docker.exe ever sees them. That breaks `docker exec
# -w /workspace ...` below ("Cwd must be an absolute path: unknown") if left
# on, but ALSO breaks `docker cp <host-tarball-path> ...` if left on globally
# (docker.exe then can't resolve the real host path either) — so it's set
# per-call below (dexec helper), not exported. No-op on real Linux/macOS.
dexec() { MSYS_NO_PATHCONV=1 docker exec "$@"; }

MODE="${1:-debug}"
case "$MODE" in
  debug|release|benchmark) ;;
  *) echo "usage: $0 [debug|release|benchmark] [--features <list>]" >&2; exit 1 ;;
esac
shift || true

# Optional EXTRA cargo features for src-tauri, added on top of the default
# feature set. `native-core` (the in-process Rust client-runtime hosting the
# entire bridge protocol + store layer — F2b) is a default feature now, so
# every build already includes it unless `--features` is used to pass
# `--no-default-features`-equivalent flags via cargo-tauri's own CLI. This
# flag remains for any future opt-in feature.
CARGO_FEATURES=""
# Android ABI(s). Default arm64 (real devices); `--target x86_64` builds for an
# emulator on an x86 host (add both to cover both).
TARGETS=(aarch64)
_targets_set=""
while [ $# -gt 0 ]; do
  case "$1" in
    --features) CARGO_FEATURES="$2"; shift 2 ;;
    --features=*) CARGO_FEATURES="${1#--features=}"; shift ;;
    --target) [ -z "$_targets_set" ] && TARGETS=(); _targets_set=1; TARGETS+=("$2"); shift 2 ;;
    --target=*) [ -z "$_targets_set" ] && TARGETS=(); _targets_set=1; TARGETS+=("${1#--target=}"); shift ;;
    *) echo "usage: $0 [debug|release|benchmark] [--features <list>] [--target <abi>]..." >&2; exit 1 ;;
  esac
done
FEATURE_ARGS=()
[ -n "$CARGO_FEATURES" ] && FEATURE_ARGS=(--features "$CARGO_FEATURES")
TARGET_ARGS=()
for t in "${TARGETS[@]}"; do TARGET_ARGS+=(--target "$t"); done
# benchmark builds the exact same artifact as release; only the post-build
# signing step differs.
GRADLE_MODE="release"; [ "$MODE" = "debug" ] && GRADLE_MODE="debug"

cd "$(git rev-parse --show-toplevel)"
mkdir -p dist

IMAGE=codedeck-android-build
CONTAINER=codedeck-android-build-run

echo "==> Building toolchain image (cached after the first run)"
docker build -t "$IMAGE" -f apps/mobile/docker/Dockerfile apps/mobile/docker

echo "==> Copying source into a fresh container (avoids Windows bind-mount"
echo "    issues with pnpm/cargo/gradle's many small-file writes)"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker create --name "$CONTAINER" "$IMAGE" sleep infinity
docker start "$CONTAINER" >/dev/null
# Removed on exit either way (success, build failure, or Ctrl-C) — same
# pattern as codedeck's run_in_workspace_container. Without this the
# container (sleep infinity) was left running forever after every build.
trap 'docker rm -f "$CONTAINER" >/dev/null 2>&1 || true' EXIT

TARBALL="$(mktemp).tar.gz"
tar --exclude='.git' --exclude='vendor' --exclude='data' --exclude='dist' \
    --exclude='node_modules' --exclude='*/node_modules' -czf "$TARBALL" .
docker cp "$TARBALL" "$CONTAINER":/workspace/repo.tar.gz
rm -f "$TARBALL"
dexec -w /workspace "$CONTAINER" tar -xzf repo.tar.gz

echo "==> Installing workspace deps"
dexec -w /workspace "$CONTAINER" pnpm install --frozen-lockfile

echo "==> Building ($GRADLE_MODE): Vite web assets, then cargo + Gradle"
[ -n "$CARGO_FEATURES" ] && echo "    src-tauri cargo features: $CARGO_FEATURES"
if [ "$GRADLE_MODE" = "debug" ]; then
  dexec -w /workspace/apps/mobile "$CONTAINER" \
    pnpm dlx "@tauri-apps/cli@^2" android build "${TARGET_ARGS[@]}" --debug "${FEATURE_ARGS[@]+${FEATURE_ARGS[@]}}"
else
  dexec -w /workspace/apps/mobile "$CONTAINER" \
    pnpm dlx "@tauri-apps/cli@^2" android build "${TARGET_ARGS[@]}" "${FEATURE_ARGS[@]+${FEATURE_ARGS[@]}}"
fi

OUT_DIR="apps/mobile/src-tauri/gen/android/app/build/outputs/apk/universal/$GRADLE_MODE"
if [ "$GRADLE_MODE" = "release" ]; then
  APK_NAME="app-universal-release-unsigned.apk"  # no keystore configured — see the header comment
else
  APK_NAME="app-universal-debug.apk"
fi
TARGET_TAG=""
[ "${TARGETS[*]}" != "aarch64" ] && TARGET_TAG="-$(echo "${TARGETS[*]}" | tr ' ' '+')"
DEST="dist/codedeck-$MODE${CARGO_FEATURES:+-$(echo "$CARGO_FEATURES" | tr ', ' '--')}${TARGET_TAG}.apk"

if [ "$MODE" = "benchmark" ]; then
  echo "==> Re-signing with the baked-in debug keystore (zipalign + apksigner)"
  BUILD_TOOLS=/opt/android-sdk/build-tools/36.0.0
  IN="/workspace/$OUT_DIR/$APK_NAME"
  ALIGNED="/workspace/$OUT_DIR/app-benchmark-aligned.apk"
  SIGNED="/workspace/$OUT_DIR/app-benchmark-signed.apk"
  dexec "$CONTAINER" "$BUILD_TOOLS/zipalign" -f -p 4 "$IN" "$ALIGNED"
  dexec "$CONTAINER" "$BUILD_TOOLS/apksigner" sign \
    --ks /opt/debug.keystore --ks-pass pass:android \
    --key-pass pass:android --ks-key-alias androiddebugkey \
    --out "$SIGNED" "$ALIGNED"
  docker cp "$CONTAINER":"$SIGNED" "$DEST"
else
  docker cp "$CONTAINER":/workspace/"$OUT_DIR"/"$APK_NAME" "$DEST"
fi

echo
echo "==> Done: $DEST ($(du -h "$DEST" | cut -f1))"
case "$MODE" in
  release)
    echo "    UNSIGNED — Android will refuse to install this. Use 'benchmark'"
    echo "    for a release-optimized build you can actually sideload."
    ;;
  benchmark)
    echo "    Signed with a throwaway debug keystore (not a real release"
    echo "    identity) — fine to sideload for testing, not to publish."
    ;;
esac
echo "    Install: adb install $DEST"
echo "    (or copy the file to the phone and open it — needs \"install"
echo "    unknown apps\" allowed for whatever app you open it with)"
