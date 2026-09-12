#!/usr/bin/env bash
# F0 probe-4: render the transcript corpus with a Compose-native Markdown
# renderer and capture Paparazzi golden PNGs (JVM screenshot test — no
# emulator). Assess parity vs the current react-markdown + rehype-highlight.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export MSYS_NO_PATHCONV=1
command -v cygpath >/dev/null 2>&1 && C="$(cygpath -w "$HERE")" || C="$HERE"
IMG=codedeck-bgprobe-build   # reuse: has JDK + Android cmdline-tools
GVOL=codedeck-spike-gradle

docker image inspect "$IMG" >/dev/null 2>&1 || { echo "build $IMG first (spike/background-probe/build.sh)"; exit 1; }

docker run --rm -v "${C}:/s" -v "${GVOL}:/root/.gradle" -e ANDROID_HOME=/opt/android-sdk \
  -w /s "$IMG" bash -c '
  set -e
  echo "sdk.dir=/opt/android-sdk" > local.properties
  ./gradlew --no-daemon :ui:recordPaparazziDebug
  echo "--- goldens ---"; find ui/src/test/snapshots -type f -name "*.png" | sort
'
mkdir -p "$HERE/artifacts"
cp -f "$HERE"/ui/src/test/snapshots/images/*.png "$HERE/artifacts/" 2>/dev/null || true
echo "goldens -> spike/markdown-compose-probe/artifacts/"
