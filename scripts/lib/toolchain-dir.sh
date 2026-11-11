# shellcheck shell=bash
# Sourced helper: where this repository's vendored toolchain lives.
#
#   main_checkout   the main checkout's root, from any checkout of the repo
#   toolchain_dir   the toolchain directory every checkout shares
#
# One toolchain per repository, not per checkout. A linked git worktree used
# to install its own ./toolchain — the same few GB again, and the same minutes
# of download, for a tree that differs by a branch. What is in there is
# compilers, SDKs and download caches, none of it derived from the tree, so a
# worktree uses the main checkout's. CODEDECK_TOOLCHAIN names another place
# (a checkout that must not share, or a disk with room).
#
# Git records where the main checkout is: every worktree's common directory is
# the main checkout's .git. A repository laid out otherwise (a bare repository
# with worktrees only) has no main checkout to borrow from, and each checkout
# then keeps its own.
main_checkout() {
  local common
  common="$(cd "$(git rev-parse --git-common-dir)" && pwd -P)"
  if [ "$(basename "$common")" = .git ]; then
    dirname "$common"
  else
    git rev-parse --show-toplevel
  fi
}

toolchain_dir() {
  if [ -n "${CODEDECK_TOOLCHAIN:-}" ]; then
    printf '%s\n' "$CODEDECK_TOOLCHAIN"
  else
    printf '%s/toolchain\n' "$(main_checkout)"
  fi
}
