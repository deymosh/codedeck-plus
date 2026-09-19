#!/usr/bin/env bash
# F0 probe-2: does the MDK/MLS + SQLCipher stack from apps/mobile/src-tauri
# survive the plan's re-layout (workspace member + cdylib + alongside uniffi),
# and still cross-compile to aarch64-linux-android?
#
#   ./spike/ndk-marmot-probe/run.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export MSYS_NO_PATHCONV=1

# host path in the form Docker wants (Windows: C:\...; elsewhere: unchanged)
if command -v cygpath >/dev/null 2>&1; then CTX="$(cygpath -w "$HERE")"; else CTX="$HERE"; fi
IMG=codedeck-ndk-probe
VOL=codedeck-ndkprobe-target

echo "== build the lean NDK image (first run downloads NDK r28c ~600MB) =="
docker build -t "$IMG" "$CTX"

echo "== host: workspace tests (SQLCipher open + MLS group loopback) =="
docker run --rm -v "${CTX}:/w" -v "${VOL}:/w/target" -w /w "$IMG" bash -c 'cargo test --workspace'

echo "== android: cross-compile the workspace cdylib for arm64 =="
docker run --rm -v "${CTX}:/w" -v "${VOL}:/w/target" -w /w "$IMG" bash -c '
  set -e
  cargo ndk -t arm64-v8a -o ./jniLibs build --release -p client-core
  echo "--- artifact ---"
  find ./jniLibs -type f
  file ./jniLibs/arm64-v8a/libclient_core.so
  ls -la ./jniLibs/arm64-v8a/libclient_core.so
'

echo
echo "probe-2 GREEN — see README.md"
