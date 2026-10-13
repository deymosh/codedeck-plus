#!/bin/sh
# The archiver that pairs with `zig-cc.sh`: the same Zig, run as `ar`.
#
# Cargo uses `ar` beside `cc` when it links a static library, and a machine
# with neither has neither. Installed by scripts/install-toolchain.sh as
# `toolchain/bin/ar`, beside `toolchain/zig/`, which is where it looks for
# zig — no path is baked in.

set -e

here="$(dirname "$0")"
zig="$here/../zig/zig"
if [ ! -x "$zig" ]; then
  echo "ar: no ${zig} — this shim is installed beside the Zig it stands for;" >&2
  echo "ar: re-run scripts/install-toolchain.sh rust to put it back" >&2
  exit 1
fi

exec "$zig" ar "$@"
