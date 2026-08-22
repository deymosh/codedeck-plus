#!/usr/bin/env bash
# Build the signed aarch64 RELEASE APK locally, mirroring release-android.yml.
#
# Why this exists as a script: the CDX-012 NDK trap only bites on the
# tauri-CLI-drives-cargo path (gen/android/BuildTask.kt exports RANLIB_/AR_
# only when *Gradle* drives the CLI), so the exports below are not optional.
# `set -u` is deliberately NOT used before sdkman-init.sh — it breaks it.
set -eo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export JAVA_HOME="$HOME/.sdkman/candidates/java/current"
export ANDROID_HOME="$HOME/Android/Sdk"
export NDK_HOME="$ANDROID_HOME/ndk/28.2.13676358"
export ANDROID_NDK_HOME="$NDK_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

TOOLBIN="$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin"
export RANLIB_aarch64_linux_android="$TOOLBIN/llvm-ranlib"
export AR_aarch64_linux_android="$TOOLBIN/llvm-ar"

echo "== java:  $("$JAVA_HOME/bin/java" -version 2>&1 | head -1)"
echo "== ndk:   $NDK_HOME"
echo "== keystore.properties:"
sed -e 's/Password=.*/Password=<redacted>/' "$HERE/apps/mobile/src-tauri/gen/android/keystore.properties"

cd "$HERE/apps/mobile"
exec pnpm dlx @tauri-apps/cli@^2 android build --target aarch64
