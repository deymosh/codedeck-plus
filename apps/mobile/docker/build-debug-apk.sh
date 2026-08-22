#!/usr/bin/env bash
# Build a DEBUG apk for apps/mobile inside Docker — no Android Studio/Rust/NDK
# needed on the host. Debug-signed (Android's auto-generated debug keystore),
# good for sideloading onto a test device; NOT a release build (see
# vendor/mobile/scripts/build-release-apk.sh for that — it needs a real
# keystore nobody has generated yet).
#
# First run builds the toolchain image (Android SDK/NDK 28 + Rust +
# cargo-tauri) — several GB, several minutes. Reruns reuse Docker's layer
# cache, so only the `docker exec` steps below actually redo work.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

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
tar --exclude='.git' --exclude='vendor' --exclude='data' --exclude='node_modules' \
    --exclude='*/node_modules' -czf "$TARBALL" .
docker cp "$TARBALL" "$CONTAINER":/workspace/repo.tar.gz
rm -f "$TARBALL"
docker exec -w /workspace "$CONTAINER" tar -xzf repo.tar.gz

echo "==> Installing workspace deps"
docker exec -w /workspace "$CONTAINER" pnpm install --frozen-lockfile

echo "==> Building (Vite web assets, then cargo + Gradle)"
docker exec -w /workspace/apps/mobile "$CONTAINER" \
  pnpm dlx "@tauri-apps/cli@^2" android build --target aarch64 --debug

OUT=apps/mobile/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
docker cp "$CONTAINER":/workspace/"$OUT" ./codedeck-debug.apk

echo
echo "==> Done: ./codedeck-debug.apk"
echo "    Install: adb install codedeck-debug.apk"
echo "    (or copy the file to the phone and open it — needs \"install"
echo "    unknown apps\" allowed for whatever app you open it with)"
