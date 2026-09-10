#!/usr/bin/env bash
# Build the bgprobe APK entirely in Docker:
#   1. cargo test the heartbeat-core (host)
#   2. cargo-ndk -> libheartbeat_core.so for x86_64 + arm64  (into app/src/main/jniLibs)
#   3. uniffi-bindgen -> Kotlin bindings (into app/src/main/kotlin/uniffi)
#   4. Gradle assembleDebug -> artifacts/bgprobe-debug.apk
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export MSYS_NO_PATHCONV=1
if command -v cygpath >/dev/null 2>&1; then C="$(cygpath -w "$HERE")"; else C="$HERE"; fi

IMG=codedeck-bgprobe-build
CVOL=codedeck-spike-cargo
GVOL=codedeck-spike-gradle

echo "== build $IMG (Rust+NDK+cargo-ndk + JDK17 + Android cmdline-tools) =="
docker build -t "$IMG" "$C"

echo "== 1-3: rust tests + .so (x86_64,arm64) + kotlin bindings =="
docker run --rm -v "${C}:/s" -v "${CVOL}:/ct" -e CARGO_TARGET_DIR=/ct -w /s "$IMG" bash -c '
  set -e
  cd rust/heartbeat-core
  cargo test
  OUT=/s/android/app/src/main/jniLibs
  KOT=/s/android/app/src/main/kotlin
  rm -rf "$OUT" "$KOT/uniffi"
  cargo ndk -t x86_64 -t arm64-v8a -o "$OUT" build --release --lib
  cargo run --quiet --bin uniffi-bindgen -- generate \
    --library "$OUT/x86_64/libheartbeat_core.so" --language kotlin --out-dir "$KOT"
  echo "--- artifacts ---"; find "$OUT" -type f; find "$KOT/uniffi" -type f
'

echo "== 4: gradle assembleDebug (compileSdk 36 — see app/build.gradle.kts) =="
docker run --rm -v "${C}:/s" -v "${GVOL}:/root/.gradle" \
  -e ANDROID_HOME=/opt/android-sdk -w /s/android "$IMG" bash -c '
  set -e
  echo "sdk.dir=/opt/android-sdk" > local.properties
  ./gradlew --no-daemon :app:assembleDebug
'
mkdir -p "$HERE/artifacts"
cp "$HERE/android/app/build/outputs/apk/debug/app-debug.apk" "$HERE/artifacts/bgprobe-debug.apk"
echo "APK -> spike/background-probe/artifacts/bgprobe-debug.apk"
