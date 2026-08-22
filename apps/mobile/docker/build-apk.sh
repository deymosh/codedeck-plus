#!/usr/bin/env bash
# Build a debug OR release apk for apps/mobile inside Docker — no Android
# Studio/Rust/NDK needed on the host. Output lands in dist/.
#
# Usage: apps/mobile/docker/build-apk.sh [debug|release]   (default: debug)
#
# debug   — fast, unstripped, Android's auto debug keystore (no setup). Only
#           good for sideloading onto a test device: upstream measured the
#           debug arm64 .so at 226MB (see .github/workflows/release.yml in
#           codedeck-next-mobile) — that's most of what makes the APK huge.
# release — minified + stripped .so via a real `cargo` release profile (just
#           dropping --debug from the CLI call, same as upstream's release
#           workflow). Upstream's own numbers: .so 24.3MB, whole APK 45.6MB
#           (that includes a 20.2MB mesh engine .so from a nostr-vpn
#           checkout we don't have here, so ours should land smaller still).
#           UNSIGNED — no keystore exists in this repo yet (see
#           vendor/mobile/scripts/build-release-apk.sh for what a signed
#           build additionally needs). Fine to sideload for testing; not
#           fine to publish anywhere that checks a signature.
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
if [ "$MODE" != "debug" ] && [ "$MODE" != "release" ]; then
  echo "usage: $0 [debug|release]" >&2
  exit 1
fi

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

TARBALL="$(mktemp).tar.gz"
tar --exclude='.git' --exclude='vendor' --exclude='data' --exclude='dist' \
    --exclude='node_modules' --exclude='*/node_modules' -czf "$TARBALL" .
docker cp "$TARBALL" "$CONTAINER":/workspace/repo.tar.gz
rm -f "$TARBALL"
dexec -w /workspace "$CONTAINER" tar -xzf repo.tar.gz

echo "==> Installing workspace deps"
dexec -w /workspace "$CONTAINER" pnpm install --frozen-lockfile

echo "==> Building ($MODE): Vite web assets, then cargo + Gradle"
if [ "$MODE" = "debug" ]; then
  dexec -w /workspace/apps/mobile "$CONTAINER" \
    pnpm dlx "@tauri-apps/cli@^2" android build --target aarch64 --debug
else
  dexec -w /workspace/apps/mobile "$CONTAINER" \
    pnpm dlx "@tauri-apps/cli@^2" android build --target aarch64
fi

OUT_DIR="apps/mobile/src-tauri/gen/android/app/build/outputs/apk/universal/$MODE"
if [ "$MODE" = "release" ]; then
  APK_NAME="app-universal-release-unsigned.apk"  # no keystore configured — see the header comment
else
  APK_NAME="app-universal-debug.apk"
fi
DEST="dist/codedeck-$MODE.apk"
docker cp "$CONTAINER":/workspace/"$OUT_DIR"/"$APK_NAME" "$DEST"

echo
echo "==> Done: $DEST ($(du -h "$DEST" | cut -f1))"
if [ "$MODE" = "release" ]; then
  echo "    UNSIGNED — fine to sideload for testing, not to publish."
fi
echo "    Install: adb install $DEST"
echo "    (or copy the file to the phone and open it — needs \"install"
echo "    unknown apps\" allowed for whatever app you open it with)"
