#!/usr/bin/env bash
# scripts/install-toolchain.sh — installs EVERY toolchain this repo needs
# into ./toolchain/ (gitignored): a JDK, a Rust toolchain with the Android
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
# exists before downloading/installing anything.
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
    python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$archive" "$dest"
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

# --- Rust (project-scoped rustup — never the user's own ~/.rustup) ---
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

# --- Zig — host C linker stand-in for cargo ---
# Cargo links host binaries (build scripts, proc macros, test executables)
# through a system `cc`, which a bare machine lacks. zig cc bundles clang
# plus glibc headers/startup files, so it works with nothing from the OS;
# pkg-config-driven libs (Tauri desktop) are still the distro's job.
# env.sh only puts toolchain/bin (the shims below) on PATH when the machine
# has no cc/gcc/clang at all.
ZIG_DIR="$TOOLCHAIN_DIR/zig"
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

# --- Android SDK + NDK ---
mkdir -p "$ANDROID_HOME"
if [ ! -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]; then
  echo "==> Installing Android cmdline-tools"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/cmdline-tools.zip" \
    "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip"
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  extract_zip "$tmp/cmdline-tools.zip" "$ANDROID_HOME/cmdline-tools"
  mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
  rm -rf "$tmp"
else
  echo "==> Android cmdline-tools already installed, skipping"
fi

export ANDROID_HOME
SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"

echo "==> Installing platform-tools, $PLATFORM, build-tools $BUILD_TOOLS, NDK $NDK_VERSION"
yes | "$SDKMANAGER" --licenses >/dev/null 2>&1 || true
"$SDKMANAGER" --install \
  "platform-tools" \
  "platforms;$PLATFORM" \
  "build-tools;$BUILD_TOOLS" \
  "ndk;$NDK_VERSION"

cat > "$TOOLCHAIN_DIR/env.sh" <<EOF
# Source this to point your shell at this repo's ENTIRE local toolchain —
# cargo, node, pnpm, java, and the Android SDK/NDK all resolve from here,
# nothing from a system install:
#   source toolchain/env.sh
export JAVA_HOME="$JDK_DIR"
export RUSTUP_HOME="$RUSTUP_HOME"
export CARGO_HOME="$CARGO_HOME"
export COREPACK_HOME="$TOOLCHAIN_DIR/corepack"
export ANDROID_HOME="$ANDROID_HOME"
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/$NDK_VERSION"
export PATH="\$JAVA_HOME/bin:\$CARGO_HOME/bin:$NODE_DIR/bin:\$ANDROID_HOME/cmdline-tools/latest/bin:\$ANDROID_HOME/platform-tools:\$PATH"
# zig-backed cc/ar shims (see install-toolchain.sh), only when this machine
# has no C compiler of its own.
if ! command -v cc >/dev/null 2>&1 && ! command -v gcc >/dev/null 2>&1 && ! command -v clang >/dev/null 2>&1; then
  export PATH="$TOOLCHAIN_DIR/bin:\$PATH"
fi
EOF

echo
echo "==> Done. toolchain/env.sh written — source it, then run:"
echo "    apps/android/scripts/build-apk-local.sh"
