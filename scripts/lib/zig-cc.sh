#!/bin/sh
# The host C compiler/linker this machine lacks, as `zig cc`.
#
# Cargo links host binaries (build scripts, proc macros, test executables)
# through a system `cc`; a bare machine has none, and a project cannot install
# one without root. zig bundles clang plus the glibc headers and startup files
# it needs, so it works with nothing from the OS, and this shim is what
# `toolchain/env.sh` puts on PATH as `cc` — only when the machine has no
# cc/gcc/clang of its own.
#
# Installed by scripts/install-toolchain.sh as `toolchain/bin/cc`, beside
# `toolchain/zig/`, which is where it looks for zig: no path is baked in, so
# the same file is what a reader reads and what the toolchain runs.
#
# The one thing it does beyond `exec zig cc`: translate the target triples
# cc-rs emits. Rust names the vendor segment (`x86_64-unknown-linux-gnu`);
# zig rejects an unknown vendor and expects LLVM's form (`x86_64-linux-gnu`),
# so every --target/-target argument is rewritten on the way through.

set -e

here="$(dirname "$0")"
zig="$here/../zig/zig"
if [ ! -x "$zig" ]; then
  echo "cc: no ${zig} — this shim is installed beside the Zig it stands for;" >&2
  echo "cc: re-run scripts/install-toolchain.sh rust to put it back" >&2
  exit 1
fi

translate() {
  printf '%s' "$1" | sed -E 's/^([A-Za-z0-9_]+)-unknown-/\1-/'
}

# Rewrite the target arguments in place, then hand the whole line to zig. `n`
# is how many arguments there were before the rewrites, so the rewritten ones
# (appended) can be dropped by shifting exactly that many.
n=$#
target_next=0
for arg do
  case "$arg" in
    --target=* | -target=*)
      set -- "$@" "${arg%%=*}=$(translate "${arg#*=}")"
      ;;
    -target | --target)
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

exec "$zig" cc "$@"
