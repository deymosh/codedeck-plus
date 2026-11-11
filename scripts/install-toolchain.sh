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
# Linux, and Windows (Git Bash). Node on Windows is a zip with nothing to
# link. The crates compile C (ring, secp256k1, sqlite) and link executables,
# which on Windows normally means the MSVC build tools — a system install this
# script will not make. So `rust` on Windows is the GNU flavour instead
# (`x86_64-pc-windows-gnu`), with the GCC it needs unpacked beside it
# (WinLibs: GCC + MinGW-w64, one archive, pinned by hash). That is NOT the
# toolchain CI and the release build use on Windows (MSVC): same sources,
# same `cfg(windows)` code, another C compiler, linker and C runtime — good
# for the loop, and CI stays the judge. `android` on Windows is what the
# app's unit tests, snapshot tests and lint need — the JDK, the platform and
# the build tools — and not the NDK: the APK itself is not built on a Windows
# host (build-apk-local.sh links through the NDK's Linux clang), so Docker
# keeps that. macOS likely works too
# (Adoptium/rustup/Node/cmdline-tools all publish macOS binaries) but is
# untested — the NDK clang triples build-apk-local.sh uses are
# Linux-host-specific (`linux-x86_64` prebuilt dir) either way.
#
# Idempotent, and cheap enough to run as a check: every step asks whether its
# target is already here before it touches the network, and a later run for
# another component leaves the earlier ones alone (toolchain/env.sh is
# rewritten from what is on disk). `./codedeck` therefore calls this rather
# than keeping its own record of what was installed — a record can drift from
# the directory it describes, and a check cannot.
#
# After this: apps/android/scripts/build-apk-local.sh builds a debug APK
# directly on this host — no Docker, no tar, no throwaway container per
# build (that's the Windows path's tradeoff, not this one's). `source
# toolchain/env.sh` first to also get a working `cargo`/`node`/`pnpm` for
# the rest of the repo (`pnpm install`, `pnpm -r test`, etc.) without Docker.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

HOST_OS=linux
case "$(uname -s)" in
  Linux) ;;
  MINGW* | MSYS*) HOST_OS=windows ;;
  *)
    echo "This script installs a toolchain on Linux, and Node on Windows (Git" >&2
    echo "Bash). On this system use Docker: ./codedeck does, when it is running." >&2
    exit 1
    ;;
esac

# What was asked for, as a space-delimited set to match against. `android`
# implies `java`, and `rust` implies the C compiler it links through (`zig` on
# Linux, `mingw` on Windows), resolved here so each section below only has to
# ask for its own name. Asking for a name that is not a component is an error,
# not a skip: the caller would otherwise go on to run a tool that is not
# there.
ALL_COMPONENTS=(java rust node android)
WANTED=("$@")
if [ ${#WANTED[@]} -eq 0 ]; then
  WANTED=("${ALL_COMPONENTS[@]}")
else
  for component in "${WANTED[@]}"; do
    case " ${ALL_COMPONENTS[*]} " in
      *" $component "*) ;;
      *)
        echo "unknown component on $HOST_OS: $component" >&2
        echo "components: ${ALL_COMPONENTS[*]} (none = all of them)" >&2
        exit 2
        ;;
    esac
  done
fi
WANTED_STR=" ${WANTED[*]} "
case "$WANTED_STR" in *" android "*) WANTED_STR="$WANTED_STR java " ;; esac
case "$WANTED_STR" in
  *" rust "*)
    if [ "$HOST_OS" = windows ]; then WANTED_STR="$WANTED_STR mingw "; else WANTED_STR="$WANTED_STR zig "; fi
    ;;
esac

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
    python3 "$LIB_DIR/extract-tar-xz.py" "$archive" "$dest"
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
    python3 "$LIB_DIR/extract-zip.py" "$archive" "$dest"
  else
    echo "error: extracting $archive needs either the unzip binary or python3, neither is on PATH" >&2
    exit 1
  fi
}

TOOLCHAIN_DIR="$PWD/toolchain"

# What a run that found everything in place has to say. `./codedeck` calls
# this script before every command of the local engine, as the check of what
# is installed, and sets INSTALL_TOOLCHAIN_QUIET so that a check which
# installed nothing prints nothing; a run that does install something is
# heard either way.
INSTALLED_SOMETHING=0
note() {
  if [ "${INSTALL_TOOLCHAIN_QUIET:-0}" != 1 ]; then echo "$@"; fi
}
# The helper scripts this one runs or installs: the python extractors for a
# host with no xz/unzip, and the Zig shims that go into toolchain/bin.
LIB_DIR="$(cd "$(dirname "$0")" && pwd)/lib"
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
    INSTALLED_SOMETHING=1
    echo "==> Installing a JDK (Temurin 21)"
    arch="$(uname -m)"; case "$arch" in x86_64) arch=x64 ;; aarch64) arch=aarch64 ;; esac
    # Linux ships a tarball, Windows a zip (and an installer, which is the
    # other "link" in the answer and not what this wants).
    jdk_os=linux
    jdk_ext='tar\.gz'
    if [ "$HOST_OS" = windows ]; then
      jdk_os=windows
      jdk_ext='zip'
    fi
    jdk_url="$(curl -fsSL "https://api.adoptium.net/v3/assets/latest/21/hotspot?os=${jdk_os}&architecture=${arch}&image_type=jdk" \
      | grep -o "\"link\": *\"[^\"]*${jdk_ext}\"" | head -1 | cut -d'"' -f4 || true)"
    if [ -z "$jdk_url" ]; then
      echo "error: could not resolve a Temurin 21 download URL from the Adoptium API" >&2
      exit 1
    fi
    tmp="$(mktemp -d)"
    rm -rf "$JDK_DIR"
    mkdir -p "$JDK_DIR"
    if [ "$HOST_OS" = windows ]; then
      curl -fsSL -o "$tmp/jdk.zip" "$jdk_url"
      # The zip holds one directory, jdk-<version>.
      extract_zip "$tmp/jdk.zip" "$tmp/unpacked"
      mv "$tmp/unpacked"/jdk-*/* "$JDK_DIR"/
    else
      curl -fsSL -o "$tmp/jdk.tar.gz" "$jdk_url"
      tar -xzf "$tmp/jdk.tar.gz" -C "$JDK_DIR" --strip-components=1
    fi
    rm -rf "$tmp"
  else
    note "==> JDK already installed, skipping"
  fi
  export JAVA_HOME="$JDK_DIR"
  export PATH="$JAVA_HOME/bin:$PATH"
fi

# --- Rust (project-scoped rustup — never the user's own ~/.rustup) ---
if wants rust; then
  if [ ! -x "$CARGO_HOME/bin/cargo" ]; then
    INSTALLED_SOMETHING=1
    echo "==> Installing a project-scoped Rust toolchain"
    tmp="$(mktemp -d)"
    if [ "$HOST_OS" = windows ]; then
      # The GNU host, because its linker is the GCC below and not the MSVC
      # build tools. `--no-modify-path` keeps rustup out of the user's PATH
      # and registry, and the path check is skipped because a rustup of the
      # user's own (in ~/.cargo) is no reason not to have this one: the two
      # never see each other, each has its own RUSTUP_HOME. The minimal
      # profile plus clippy is what the checks run; the offline docs alone
      # would be another few hundred MB.
      curl -fsSL -o "$tmp/rustup-init.exe" https://win.rustup.rs/x86_64
      RUSTUP_HOME="$RUSTUP_HOME" CARGO_HOME="$CARGO_HOME" RUSTUP_INIT_SKIP_PATH_CHECK=yes \
        "$tmp/rustup-init.exe" -y --no-modify-path --default-host x86_64-pc-windows-gnu \
        --default-toolchain stable --profile minimal --component clippy </dev/null >/dev/null
    else
      curl -fsSL -o "$tmp/rustup-init.sh" https://sh.rustup.rs
      RUSTUP_HOME="$RUSTUP_HOME" CARGO_HOME="$CARGO_HOME" \
        sh "$tmp/rustup-init.sh" -y --no-modify-path --default-toolchain stable >/dev/null
    fi
    rm -rf "$tmp"
  else
    note "==> Project-scoped Rust toolchain already installed, skipping"
  fi
  export RUSTUP_HOME CARGO_HOME
  export PATH="$CARGO_HOME/bin:$PATH"
  # Asked of the local toolchain, not of the network: `target list
  # --installed` reads what is here, so a run that finds the targets already
  # in place costs nothing and this script stays cheap to call as a check.
  # Linux only: the APK is not built on a Windows host.
  if [ "$HOST_OS" = linux ] &&
    ! rustup target list --installed 2>/dev/null | grep -qx 'aarch64-linux-android'; then
    INSTALLED_SOMETHING=1
    echo "==> Adding Android Rust targets"
    rustup target add aarch64-linux-android x86_64-linux-android
  fi
fi

# --- MinGW-w64 GCC — the C compiler and linker of the Windows GNU toolchain ---
# rustc for x86_64-pc-windows-gnu links through `gcc`, and the crates that
# carry C (ring, secp256k1, sqlite) compile it with the same one. WinLibs is
# GCC and MinGW-w64 in one archive that runs from wherever it is unpacked. The
# MSVCRT build, not the UCRT one: it is the C runtime Rust's own GNU target
# links against, and objects built against the other's headers would ask for
# symbols it does not have. Pinned to one release and its SHA-256 — what is
# unpacked here compiles and links every crate and test.
MINGW_DIR="$TOOLCHAIN_DIR/mingw64"
MINGW_RELEASE="16.2.0posix-14.0.0-msvcrt-r2"
MINGW_FILE="winlibs-x86_64-posix-seh-gcc-16.2.0-mingw-w64msvcrt-14.0.0-r2.zip"
MINGW_SHA256="1b90ec73c96e6905a913746b56fb6b20122422787029810d3afc6a3b440f2322"
if wants mingw; then
  if [ ! -x "$MINGW_DIR/bin/gcc.exe" ]; then
    INSTALLED_SOMETHING=1
    echo "==> Installing MinGW-w64 GCC (WinLibs $MINGW_RELEASE; a 270 MB download)"
    tmp="$(mktemp -d)"
    curl -fsSL -o "$tmp/$MINGW_FILE" \
      "https://github.com/brechtsanders/winlibs_mingw/releases/download/$MINGW_RELEASE/$MINGW_FILE"
    if ! (cd "$tmp" && printf '%s  %s\n' "$MINGW_SHA256" "$MINGW_FILE" | sha256sum -c - >/dev/null); then
      echo "error: $MINGW_FILE does not match the SHA-256 this script pins" >&2
      exit 1
    fi
    # The zip holds one directory, mingw64. Unpacked beside its final place
    # and moved, so an interrupted run leaves no half toolchain that the
    # check above would take for a whole one.
    rm -rf "$MINGW_DIR" "$TOOLCHAIN_DIR/mingw64.partial"
    mkdir -p "$TOOLCHAIN_DIR/mingw64.partial"
    extract_zip "$tmp/$MINGW_FILE" "$TOOLCHAIN_DIR/mingw64.partial"
    rm -rf "$tmp"
    # What the archive carries beyond a C compiler and linker — other
    # languages' front ends, a debugger, CMake, Doxygen, documentation —
    # is a third of its size and nothing here runs it.
    (
      cd "$TOOLCHAIN_DIR/mingw64.partial/mingw64"
      rm -rf share
      rm -f libexec/gcc/*/*/f951.exe libexec/gcc/*/*/cc1obj.exe libexec/gcc/*/*/cc1objplus.exe \
        bin/gdb.exe bin/gdbserver.exe bin/lto-dump.exe bin/doxygen.exe bin/cppcheck.exe \
        bin/cmake.exe bin/ctest.exe bin/cpack.exe bin/ninja.exe
    )
    mv "$TOOLCHAIN_DIR/mingw64.partial/mingw64" "$MINGW_DIR"
    rm -rf "$TOOLCHAIN_DIR/mingw64.partial"
  else
    note "==> MinGW-w64 GCC already installed, skipping"
  fi
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
    INSTALLED_SOMETHING=1
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
    note "==> Zig already installed, skipping"
  fi
fi

if [ -x "$ZIG_DIR/zig" ]; then
  mkdir -p "$TOOLCHAIN_DIR/bin"
  # Copied, not generated: the shims are scripts/lib/zig-cc.sh and
  # scripts/lib/zig-ar.sh, which find the zig beside them at run time rather
  # than having its path written into them — so what is installed is exactly
  # what a reader reads, and re-installing them is a copy.
  install -m 0755 "$LIB_DIR/zig-cc.sh" "$TOOLCHAIN_DIR/bin/cc"
  install -m 0755 "$LIB_DIR/zig-ar.sh" "$TOOLCHAIN_DIR/bin/ar"
fi

# --- Node.js + the exact pnpm this repo pins (package.json's "engines"/
# "packageManager" — kept in sync by hand, same as any other version bump
# here) ---
NODE_MAJOR="22"
PNPM_VERSION="10.8.0"
NODE_DIR="$TOOLCHAIN_DIR/node"
# Where the binaries are inside it: the Linux tarball has a bin/, the Windows
# zip keeps node.exe at its root.
NODE_BIN="$NODE_DIR/bin"
if [ "$HOST_OS" = windows ]; then NODE_BIN="$NODE_DIR"; fi
if wants node; then
  if [ ! -x "$NODE_BIN/node" ]; then
    INSTALLED_SOMETHING=1
    echo "==> Installing Node.js $NODE_MAJOR.x"
    arch="$(uname -m)"; case "$arch" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; esac
    node_suffix="linux-${arch}.tar.xz"
    if [ "$HOST_OS" = windows ]; then node_suffix="win-${arch}.zip"; fi
    node_sums="$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt")"
    node_file="$(printf '%s\n' "$node_sums" \
      | grep -o "node-v${NODE_MAJOR}\.[0-9.]*-${node_suffix//./\\.}" | head -1 || true)"
    if [ -z "$node_file" ]; then
      echo "error: could not resolve a Node ${NODE_MAJOR}.x download for $node_suffix" >&2
      exit 1
    fi
    tmp="$(mktemp -d)"
    curl -fsSL -o "$tmp/$node_file" "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/$node_file"
    # The archive against the release's own checksum list: what is unpacked
    # here goes on PATH and runs every test.
    if ! (cd "$tmp" && printf '%s\n' "$node_sums" | grep " $node_file\$" | sha256sum -c - >/dev/null); then
      echo "error: $node_file does not match its SHA-256 in SHASUMS256.txt" >&2
      exit 1
    fi
    rm -rf "$NODE_DIR"
    mkdir -p "$NODE_DIR"
    if [ "$HOST_OS" = windows ]; then
      # The zip holds one directory, node-v<version>-win-<arch>.
      extract_zip "$tmp/$node_file" "$tmp/unpacked"
      mv "$tmp/unpacked"/node-v*/* "$NODE_DIR"/
    else
      extract_tar_xz "$tmp/$node_file" "$NODE_DIR"
    fi
    rm -rf "$tmp"
  else
    note "==> Node.js already installed, skipping"
  fi
  export PATH="$NODE_BIN:$PATH"

  if [ ! -x "$NODE_BIN/pnpm" ]; then
    INSTALLED_SOMETHING=1
    echo "==> Installing pnpm $PNPM_VERSION via corepack"
    export COREPACK_HOME="$TOOLCHAIN_DIR/corepack"
    corepack enable --install-directory "$NODE_BIN"
    corepack prepare "pnpm@$PNPM_VERSION" --activate
  else
    note "==> pnpm already installed, skipping"
  fi
fi

# --- Android SDK + NDK ---
# On Windows the SDK manager is a batch file, and the SDK stops at what the
# JVM-side checks need (the platform and the build tools): no NDK, because no
# APK is linked there.
SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
SDK_OS=linux
SDK_PACKAGES=("platform-tools" "platforms;$PLATFORM" "build-tools;$BUILD_TOOLS" "ndk;$NDK_VERSION")
if [ "$HOST_OS" = windows ]; then
  SDKMANAGER="$SDKMANAGER.bat"
  SDK_OS=win
  SDK_PACKAGES=("platforms;$PLATFORM" "build-tools;$BUILD_TOOLS")
fi

# Whether the SDK manager is there to run. A batch file is not "executable"
# to Git Bash's test, so on Windows its presence is the question.
have_sdkmanager() {
  if [ "$HOST_OS" = windows ]; then [ -f "$SDKMANAGER" ]; else [ -x "$SDKMANAGER" ]; fi
}

# Whether everything SDK_PACKAGES names has landed: the platform and the
# build tools everywhere, the NDK where one is installed.
sdk_packages_present() {
  [ -d "$ANDROID_HOME/platforms/$PLATFORM" ] && [ -d "$ANDROID_HOME/build-tools/$BUILD_TOOLS" ] &&
    { [ "$HOST_OS" = windows ] || [ -d "$ANDROID_HOME/ndk/$NDK_VERSION" ]; }
}

if wants android; then
  export ANDROID_HOME
  mkdir -p "$ANDROID_HOME"
  if ! have_sdkmanager; then
    INSTALLED_SOMETHING=1
    echo "==> Installing Android cmdline-tools"
    tmp="$(mktemp -d)"
    curl -fsSL -o "$tmp/cmdline-tools.zip" \
      "https://dl.google.com/android/repository/commandlinetools-${SDK_OS}-${CMDLINE_TOOLS_VERSION}_latest.zip"
    # Cleared first: a copy left half-extracted (an interrupted run, or an
    # extractor that lost the executable bits) must not survive into the
    # `mv` below, which would land the real tools one directory down.
    rm -rf "$ANDROID_HOME/cmdline-tools"
    mkdir -p "$ANDROID_HOME/cmdline-tools"
    extract_zip "$tmp/cmdline-tools.zip" "$ANDROID_HOME/cmdline-tools"
    mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
    rm -rf "$tmp"
  else
    note "==> Android cmdline-tools already installed, skipping"
  fi

  # The packages behind cmdline-tools are asked for only when one of them is
  # missing: a run that finds them all in place does not touch the network,
  # which is what lets this script be called as a check on every command
  # rather than once with a marker file claiming what it installed.
  if ! sdk_packages_present; then
    INSTALLED_SOMETHING=1
    echo "==> Installing the Android SDK packages: ${SDK_PACKAGES[*]}"
    yes | "$SDKMANAGER" --licenses >/dev/null 2>&1 || true
    "$SDKMANAGER" --install "${SDK_PACKAGES[@]}" </dev/null
  else
    note "==> Android SDK packages already installed, skipping"
  fi
fi

# --- What this toolchain holds. ---
# Derived from what is on disk rather than from what this run installed, so a
# later run for another component leaves the earlier ones in place instead of
# writing a toolchain that forgets half of itself.

# A component is here when the binary that does its work is — and, for
# Android, when what that binary was going to install is here too: the
# platform, the build tools and the NDK are separate downloads after
# cmdline-tools lands, so a run interrupted in between would otherwise look
# like an Android toolchain and then fail in Gradle.
component_present() {
  case "$1" in
    java) [ -x "$JDK_DIR/bin/java" ] ;;
    # On Windows a cargo that cannot link is not a Rust toolchain.
    rust)
      [ -x "$CARGO_HOME/bin/cargo" ] &&
        { [ "$HOST_OS" != windows ] || [ -x "$MINGW_DIR/bin/gcc.exe" ]; }
      ;;
    node) [ -x "$NODE_BIN/node" ] ;;
    android) have_sdkmanager && sdk_packages_present ;;
    *) return 1 ;;
  esac
}

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
    # The GCC the GNU toolchain links through (Windows). Always, unlike the
    # Zig shims below: Git Bash has a /mingw64/bin of its own with no compiler
    # in it, and a GCC from somewhere else is not the one the crates were
    # checked against.
    if [ "$HOST_OS" = windows ]; then path_prefix="$path_prefix$MINGW_DIR/bin:"; fi
  fi
  if component_present node; then
    echo "export COREPACK_HOME=\"$TOOLCHAIN_DIR/corepack\""
    path_prefix="$path_prefix$NODE_BIN:"
  fi
  if component_present android; then
    echo "export ANDROID_HOME=\"$ANDROID_HOME\""
    if [ -d "$ANDROID_HOME/ndk/$NDK_VERSION" ]; then
      echo "export ANDROID_NDK_HOME=\"$ANDROID_HOME/ndk/$NDK_VERSION\""
    fi
    path_prefix="$path_prefix\$ANDROID_HOME/cmdline-tools/latest/bin:\$ANDROID_HOME/platform-tools:"
  fi
  echo "export PATH=\"${path_prefix}\$PATH\""
  echo "# zig-backed cc/ar shims (see install-toolchain.sh), only when this"
  echo "# machine has no C compiler of its own."
  echo 'if ! command -v cc >/dev/null 2>&1 && ! command -v gcc >/dev/null 2>&1 && ! command -v clang >/dev/null 2>&1; then'
  echo "  export PATH=\"$TOOLCHAIN_DIR/bin:\$PATH\""
  echo "fi"
} > "$TOOLCHAIN_DIR/env.sh"

if [ "$INSTALLED_SOMETHING" = 0 ] && [ "${INSTALL_TOOLCHAIN_QUIET:-0}" = 1 ]; then
  exit 0
fi
echo
if component_present android && [ "$HOST_OS" = linux ]; then
  echo "==> Done. toolchain/env.sh written — source it, then run:"
  echo "    apps/android/scripts/build-apk-local.sh"
else
  present=""
  for component in "${ALL_COMPONENTS[@]}"; do
    if component_present "$component"; then present="$present$component "; fi
  done
  echo "==> Done. toolchain/env.sh written — source it for: ${present% }"
fi
