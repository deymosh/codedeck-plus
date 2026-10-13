#!/usr/bin/env bash
# scripts/install-toolchain.sh — installs this repo's toolchain into
# ./toolchain/ (gitignored): a JDK, a Rust toolchain with the Android
# targets, Node.js + the exact pinned pnpm, and the Android SDK/NDK — plus a
# Zig that stands in for a missing system C compiler (see below).
# Everything lives under the repo, version-pinned independently of whatever
# else is on this machine — nothing is written to a system path (no
# ~/.rustup, no ~/.cache/node, no ~/.android, no apt package), so a
# different project's JDK/Rust/Node/Android-SDK version is never at risk of
# colliding with this one's, and a completely bare machine (no Rust, no
# Node, no Java already installed) works the same as one with all three
# already present for something else.
#
#   scripts/install-toolchain.sh [component…]
#
# No argument installs everything, which is what a machine building both the
# crates and the app wants. Naming components installs only those, for a host
# that works on one part of the repo: `node` for the TypeScript workspace,
# `rust` for the crates, `android` for apps/android (the SDK and NDK are a
# few GB on their own). A component pulls in what it stands on — `android`
# brings `java`, `rust` brings `zig` — so no request can leave a toolchain
# that does not run.
#
# The only things this script assumes are already on the machine: bash,
# curl, tar, and a glibc-or-compatible Linux (the prebuilt JDK/Rust/
# Node/Android-SDK binaries below aren't musl builds). It cannot vendor
# THOSE — they're what fetches everything else. It prefers the system
# `xz`/`unzip` binaries for archive extraction but falls back to python3's
# stdlib (`lzma`/`zipfile`) when they're missing — confirmed to happen on a
# real sandbox that had curl/tar/python3 but no `xz` or `unzip` and no
# root/apt access to install them.
#
# One real exception this script does NOT cover: building apps/mobile's
# Tauri DESKTOP target on Linux needs system GUI libraries (webkit2gtk,
# gtk3, libayatana-appindicator3, librsvg2, patchelf, pkg-config) — genuine
# OS packages (GTK/WebKit), not something vendorable into a project folder.
# Install those via your distro's package manager if you need that build;
# everything else in this repo (crates/*, apps/android, the TS workspace)
# does not need them.
#
# Linux only. On Windows, Docker is the supported path (see
# apps/android/docker/build-apk.sh, apps/mobile/docker/build-apk.sh) —
# installing this toolchain directly on Windows without Android Studio's own
# installer is its own can of worms this script doesn't attempt. macOS
# likely works too (Adoptium/rustup/Node/cmdline-tools all publish macOS
# binaries) but is untested — the NDK clang triples build-apk-local.sh uses
# are Linux-host-specific (`linux-x86_64` prebuilt dir) either way.
#
# Idempotent: safe to re-run — each step checks whether its target already
# exists before downloading/installing anything, and a later run for another
# component leaves the earlier ones alone (toolchain/env.sh and
# toolchain/.components are rewritten from what is on disk).
#
# After this: apps/android/scripts/build-apk-local.sh builds a debug APK
# directly on this host — no Docker, no tar, no throwaway container per
# build (that's the Windows path's tradeoff, not this one's). `source
# toolchain/env.sh` first to also get a working `cargo`/`node`/`pnpm` for
# the rest of the repo (`pnpm install`, `pnpm -r test`, etc.) without Docker.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [ "$(uname -s)" != "Linux" ]; then
  echo "This script installs a Linux toolchain. On Windows, use the Docker" >&2
  echo "path instead: apps/android/docker/build-apk.sh." >&2
  exit 1
fi

# What was asked for, as a space-delimited set to match against. `android`
# implies `java` and `rust` implies `zig`, resolved here so each section below
# only has to ask for its own name.
ALL_COMPONENTS=(java rust node android)
WANTED=("$@")
if [ ${#WANTED[@]} -eq 0 ]; then
  WANTED=("${ALL_COMPONENTS[@]}")
else
  for component in "${WANTED[@]}"; do
    case " ${ALL_COMPONENTS[*]} " in
      *" $component "*) ;;
      *)
        echo "unknown component: $component" >&2
        echo "components: ${ALL_COMPONENTS[*]} (none = all of them)" >&2
        exit 2
        ;;
    esac
  done
fi
WANTED_STR=" ${WANTED[*]} "
case "$WANTED_STR" in *" android "*) WANTED_STR="$WANTED_STR java " ;; esac
case "$WANTED_STR" in *" rust "*) WANTED_STR="$WANTED_STR zig " ;; esac

# Whether this run is to install `$1` (and, for the two that stand on
# something else, what they bring with them).
wants() {
  case "$WANTED_STR" in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

# Extraction helpers: prefer the system `xz`/`unzip` binaries (faster, and
# `tar -xJf` needs `xz` on PATH even though `xz` itself never appears in the
# command line — GNU tar shells out to it for `.tar.xz`) but fall back to
# python3's stdlib `lzma`/`zipfile` modules, which need no external binary,
# for a host that has curl/tar/python3 but neither `xz` nor `unzip` and no
# root/apt access to add them.
extract_tar_xz() {
  local archive="$1" dest="$2"
  if command -v xz >/dev/null 2>&1 || command -v unxz >/dev/null 2>&1; then
    tar -xJf "$archive" -C "$dest" --strip-components=1
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c '
import lzma, sys, tarfile
archive, dest = sys.argv[1], sys.argv[2]
with lzma.open(archive) as f, tarfile.open(fileobj=f) as tar:
    members = []
    for m in tar.getmembers():
        # emulate --strip-components=1: drop the top-level directory entry,
        # rename everything else past its first path segment
        _, _, rest = m.name.partition("/")
        if not rest:
            continue
        m.name = rest
        members.append(m)
    tar.extractall(dest, members=members)
' "$archive" "$dest"
  else
    echo "error: extracting $archive needs either the xz/unxz binary or python3, neither is on PATH" >&2
    exit 1
  fi
}

extract_zip() {
  local archive="$1" dest="$2"
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$archive" -d "$dest"
  elif command -v python3 >/dev/null 2>&1; then
    # zipfile.extractall writes the bytes but not the Unix mode, so an SDK
    # manager or a wrapper script would come out non-executable — and a
    # "Permission denied" on it reads like a broken download. Apply each
    # entry's own mode (external_attr's high half) afterwards.
    python3 -c '
import os, sys, zipfile
archive, dest = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(archive) as z:
    z.extractall(dest)
    for info in z.infolist():
        mode = info.external_attr >> 16
        if mode:
            os.chmod(os.path.join(dest, info.filename), mode & 0o777)
' "$archive" "$dest"
  else
    echo "error: extracting $archive needs either the unzip binary or python3, neither is on PATH" >&2
    exit 1
  fi
}

TOOLCHAIN_DIR="$PWD/toolchain"
JDK_DIR="$TOOLCHAIN_DIR/jdk"
RUSTUP_HOME="$TOOLCHAIN_DIR/rustup"
CARGO_HOME="$TOOLCHAIN_DIR/cargo"
ANDROID_HOME="$TOOLCHAIN_DIR/android-sdk"
CMDLINE_TOOLS_VERSION="11076708"
PLATFORM="android-37.2"
BUILD_TOOLS="37.0.0"
NDK_VERSION="28.2.13676358"

mkdir -p "$TOOLCHAIN_DIR"

# --- JDK (Temurin 21 LTS, via Adoptium's API — always the latest 21.x build) ---
if wants java; then
  if [ ! -x "$JDK_DIR/bin/java" ]; then
    echo "==> Installing a JDK (Temurin 21)"
    arch="$(uname -m)"; case "$arch" in x86_64) arch=x64 ;; aarch64) arch=aarch64 ;; esac
    jdk_url="$(curl -fsSL "https://api.adoptium.net/v3/assets/latest/21/hotspot?os=linux&architecture=${arch}&image_type=jdk" \
      | grep -o '"link": *"[^"]*tar\.gz"' | head -1 | cut -d'"' -f4 || true)"
    if [ -z "$jdk_url" ]; then
      echo "error: could not resolve a Temurin 21 download URL from the Adoptium API" >&2
      exit 1
    fi
    tmp="$(mktemp -d)"
    curl -fsSL -o "$tmp/jdk.tar.gz" "$jdk_url"
    mkdir -p "$JDK_DIR"
    tar -xzf "$tmp/jdk.tar.gz" -C "$JDK_DIR" --strip-components=1
    rm -rf "$tmp"
  else
    echo "==> JDK already installed, skipping"
  fi
  export JAVA_HOME="$JDK_DIR"
  export PATH="$JAVA_HOME/bin:$PATH"
fi

# --- Rust (project-scoped rustup — never the user's own ~/.rustup) ---
if wants rust; then
  if [ ! -x "$CARGO_HOME/bin/cargo" ]; then
    echo "==> Installing a project-scoped Rust toolchain"
    tmp="$(mktemp -d)"
    curl -fsSL -o "$tmp/rustup-init.sh" https://sh.rustup.rs
    RUSTUP_HOME="$RUSTUP_HOME" CARGO_HOME="$CARGO_HOME" \
      sh "$tmp/rustup-init.sh" -y --no-modify-path --default-toolchain stable >/dev/null
    rm -rf "$tmp"
  else
    echo "==> Project-scoped Rust toolchain already installed, skipping"
  fi
  export RUSTUP_HOME CARGO_HOME
  export PATH="$CARGO_HOME/bin:$PATH"
  echo "==> Adding Android Rust targets"
  rustup target add aarch64-linux-android x86_64-linux-android
fi

# --- Zig — host C linker stand-in for cargo ---
# Cargo links host binaries (build scripts, proc macros, test executables)
# through a system `cc`, which a bare machine lacks. zig cc bundles clang
# plus glibc headers/startup files, so it works with nothing from the OS;
# pkg-config-driven libs (Tauri desktop) are still the distro's job.
# env.sh only puts toolchain/bin (the shims below) on PATH when the machine
# has no cc/gcc/clang at all.
ZIG_DIR="$TOOLCHAIN_DIR/zig"
if wants zig; then
  if [ ! -x "$ZIG_DIR/zig" ]; then
    echo "==> Installing Zig (host linker stand-in for cargo)"
    arch="$(uname -m)"
    case "$arch" in x86_64 | aarch64) ;; *)
      echo "error: no prebuilt Zig for linux-$arch" >&2
      exit 1
    ;; esac
    # Same resolve-at-install-time pattern as the JDK/Node steps: latest
    # stable from ziglang.org's index (the index's only non-release key is
    # "master"; every other key is a plain x.y.z version).
    zig_version="$(curl -fsSL https://ziglang.org/download/index.json \
      | grep -oE '"[0-9]+\.[0-9]+\.[0-9]+"' | tr -d '"' | sort -V | tail -1)"
    if [ -z "$zig_version" ]; then
      echo "error: could not resolve the latest Zig version from ziglang.org" >&2
      exit 1
    fi
    echo "==> Zig $zig_version"
    tmp="$(mktemp -d)"
    curl -fsSL -o "$tmp/zig.tar.xz" \
      "https://ziglang.org/download/${zig_version}/zig-${arch}-linux-${zig_version}.tar.xz"
    mkdir -p "$ZIG_DIR"
    extract_tar_xz "$tmp/zig.tar.xz" "$ZIG_DIR"
    rm -rf "$tmp"
  else
    echo "==> Zig already installed, skipping"
  fi
fi

if [ -x "$ZIG_DIR/zig" ]; then
  mkdir -p "$TOOLCHAIN_DIR/bin"
  # The cc shim rewrites --target/-target triples from the LLVM dialect
  # (cc-rs emits the `-unknown-` vendor segment; zig rejects it).
  sed "s|@ZIG@|$ZIG_DIR/zig|" > "$TOOLCHAIN_DIR/bin/cc" <<'EOF'
#!/bin/sh
# Installed by scripts/install-toolchain.sh — zig cc, the host C
# compiler/linker this machine lacks (see that script for why).
translate() {
  printf '%s' "$1" | sed -E 's/^([A-Za-z0-9_]+)-unknown-/\1-/'
}
n=$#
target_next=0
for arg do
  case "$arg" in
    --target=*|-target=*)
      set -- "$@" "${arg%%=*}=$(translate "${arg#*=}")"
      ;;
    -target|--target)
      target_next=1
      set -- "$@" "$arg"
      ;;
    *)
      if [ "$target_next" -eq 1 ]; then
        set -- "$@" "$(translate "$arg")"
        target_next=0
      else
        set -- "$@" "$arg"
      fi
      ;;
  esac
done
shift "$n"
exec "@ZIG@" cc "$@"
EOF
  sed "s|@ZIG@|$ZIG_DIR/zig|" > "$TOOLCHAIN_DIR/bin/ar" <<'EOF'
#!/bin/sh
# Installed by scripts/install-toolchain.sh — pairs with bin/cc (zig ar).
exec "@ZIG@" ar "$@"
EOF
  chmod +x "$TOOLCHAIN_DIR/bin/cc" "$TOOLCHAIN_DIR/bin/ar"
fi

# --- Node.js + the exact pnpm this repo pins (package.json's "engines"/
# "packageManager" — kept in sync by hand, same as any other version bump
# here) ---
NODE_MAJOR="22"
PNPM_VERSION="10.8.0"
NODE_DIR="$TOOLCHAIN_DIR/node"
if wants node; then
  if [ ! -x "$NODE_DIR/bin/node" ]; then
    echo "==> Installing Node.js $NODE_MAJOR.x"
    arch="$(uname -m)"; case "$arch" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; esac
    node_file="$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" \
      | grep -o "node-v${NODE_MAJOR}\.[0-9.]*-linux-${arch}\.tar\.xz" | head -1 || true)"
    if [ -z "$node_file" ]; then
      echo "error: could not resolve a Node ${NODE_MAJOR}.x download for linux-$arch" >&2
      exit 1
    fi
    tmp="$(mktemp -d)"
    curl -fsSL -o "$tmp/node.tar.xz" "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/$node_file"
    mkdir -p "$NODE_DIR"
    extract_tar_xz "$tmp/node.tar.xz" "$NODE_DIR"
    rm -rf "$tmp"
  else
    echo "==> Node.js already installed, skipping"
  fi
  export PATH="$NODE_DIR/bin:$PATH"

  if [ ! -x "$NODE_DIR/bin/pnpm" ]; then
    echo "==> Installing pnpm $PNPM_VERSION via corepack"
    export COREPACK_HOME="$TOOLCHAIN_DIR/corepack"
    corepack enable --install-directory "$NODE_DIR/bin"
    corepack prepare "pnpm@$PNPM_VERSION" --activate
  else
    echo "==> pnpm already installed, skipping"
  fi
fi

# --- Android SDK + NDK ---
if wants android; then
  export ANDROID_HOME
  SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
  mkdir -p "$ANDROID_HOME"
  if [ ! -x "$SDKMANAGER" ]; then
    echo "==> Installing Android cmdline-tools"
    tmp="$(mktemp -d)"
    curl -fsSL -o "$tmp/cmdline-tools.zip" \
      "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip"
    # Cleared first: a copy left half-extracted (an interrupted run, or an
    # extractor that lost the executable bits) must not survive into the
    # `mv` below, which would land the real tools one directory down.
    rm -rf "$ANDROID_HOME/cmdline-tools"
    mkdir -p "$ANDROID_HOME/cmdline-tools"
    extract_zip "$tmp/cmdline-tools.zip" "$ANDROID_HOME/cmdline-tools"
    mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
    rm -rf "$tmp"
  else
    echo "==> Android cmdline-tools already installed, skipping"
  fi

  echo "==> Installing platform-tools, $PLATFORM, build-tools $BUILD_TOOLS, NDK $NDK_VERSION"
  yes | "$SDKMANAGER" --licenses >/dev/null 2>&1 || true
  "$SDKMANAGER" --install \
    "platform-tools" \
    "platforms;$PLATFORM" \
    "build-tools;$BUILD_TOOLS" \
    "ndk;$NDK_VERSION"
fi

# --- What this toolchain now holds, and the shell that points at it. ---
# Both are derived from what is on disk rather than from what this run
# installed, so a later run for another component leaves the earlier ones in
# place instead of writing a toolchain that forgets half of itself.
# `.components` is what `./codedeck` reads to tell whether the piece a command
# needs is here before it runs the installer again.

# A component is here when the binary that does its work is.
component_present() {
  case "$1" in
    java) [ -x "$JDK_DIR/bin/java" ] ;;
    rust) [ -x "$CARGO_HOME/bin/cargo" ] ;;
    node) [ -x "$NODE_DIR/bin/node" ] ;;
    android) [ -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ] ;;
    *) return 1 ;;
  esac
}

: > "$TOOLCHAIN_DIR/.components"
for component in "${ALL_COMPONENTS[@]}"; do
  if component_present "$component"; then echo "$component" >> "$TOOLCHAIN_DIR/.components"; fi
done

{
  echo "# Source this to point your shell at this repo's local toolchain — the"
  echo "# pieces scripts/install-toolchain.sh has installed here, and nothing"
  echo "# from a system install of the same tool:"
  echo "#   source toolchain/env.sh"
  path_prefix=""
  if component_present java; then
    echo "export JAVA_HOME=\"$JDK_DIR\""
    path_prefix="$path_prefix\$JAVA_HOME/bin:"
  fi
  if component_present rust; then
    echo "export RUSTUP_HOME=\"$RUSTUP_HOME\""
    echo "export CARGO_HOME=\"$CARGO_HOME\""
    path_prefix="$path_prefix\$CARGO_HOME/bin:"
  fi
  if component_present node; then
    echo "export COREPACK_HOME=\"$TOOLCHAIN_DIR/corepack\""
    path_prefix="$path_prefix$NODE_DIR/bin:"
  fi
  if component_present android; then
    echo "export ANDROID_HOME=\"$ANDROID_HOME\""
    echo "export ANDROID_NDK_HOME=\"$ANDROID_HOME/ndk/$NDK_VERSION\""
    path_prefix="$path_prefix\$ANDROID_HOME/cmdline-tools/latest/bin:\$ANDROID_HOME/platform-tools:"
  fi
  echo "export PATH=\"${path_prefix}\$PATH\""
  echo "# zig-backed cc/ar shims (see install-toolchain.sh), only when this"
  echo "# machine has no C compiler of its own."
  echo 'if ! command -v cc >/dev/null 2>&1 && ! command -v gcc >/dev/null 2>&1 && ! command -v clang >/dev/null 2>&1; then'
  echo "  export PATH=\"$TOOLCHAIN_DIR/bin:\$PATH\""
  echo "fi"
} > "$TOOLCHAIN_DIR/env.sh"

echo
if component_present android; then
  echo "==> Done. toolchain/env.sh written — source it, then run:"
  echo "    apps/android/scripts/build-apk-local.sh"
else
  echo "==> Done. toolchain/env.sh written — source it for the pieces"
  echo "    installed here ($(tr '\n' ' ' < "$TOOLCHAIN_DIR/.components"))."
fi
