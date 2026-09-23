# shellcheck shell=bash
# Sourced helper: stream a scoped slice of the working tree into a container.
#
#   pack_repo_into <container> <dest-dir> [git-pathspec...]
#
# The file list comes from git, not from walking the directory: tracked files
# plus untracked-but-not-ignored ones (so a new file that is not committed yet
# is still built/tested), minus tracked files deleted in the working tree.
# Everything .gitignore covers — node_modules, target/, dist/, .env, data/,
# .pnpm-store, toolchain/ — therefore never leaves the host, with no exclude
# list to keep in sync. Pathspecs narrow it further per job (e.g. a Rust-only
# job does not need apps/mobile's web sources); `:(exclude)<path>` works too.
#
# The tarball is piped straight into `docker exec -i ... tar -x`: no temp file
# on the host (Git Bash's `docker cp` mishandles /tmp paths on Windows) and no
# copy of the archive left inside the container.
pack_repo_into() {
  local container="$1" dest="$2"
  shift 2
  git ls-files -z --cached --others --exclude-standard -- "$@" \
    | while IFS= read -r -d '' f; do
        if [ -e "$f" ] || [ -L "$f" ]; then printf '%s\0' "$f"; fi
      done \
    | tar --null -T - -czf - \
    | MSYS_NO_PATHCONV=1 docker exec -i "$container" \
        sh -c 'mkdir -p "$1" && tar -xzf - -C "$1"' sh "$dest"
}
