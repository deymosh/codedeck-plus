#!/usr/bin/env bash
# The container's start: optional conveniences first (GSD, Git identity and
# credentials, repositories to clone), then the bridge.
#
# Only what the bridge cannot run without stops the container: a /data it
# cannot write. Everything else here is quick setup the operator may or may
# not have configured, so a missing setting is mentioned and a failing one
# warned about, and the bridge starts either way.
set -euo pipefail

info() { echo "[entrypoint] $*"; }
warn() { echo "[entrypoint] WARNING: $*" >&2; }

read_secret() {
  local secret_name="$1"
  local variable_name="$2"
  local value="${!variable_name:-}"
  local file="/run/secrets/${secret_name}"
  if [ -r "$file" ]; then
    value=$(<"$file")
  fi
  printf '%s' "$value"
}

CLAUDE_CODE_OAUTH_TOKEN=$(read_secret claude_code_oauth_token CLAUDE_CODE_OAUTH_TOKEN)
GITHUB_TOKEN=$(read_secret github_token GITHUB_TOKEN)
export CLAUDE_CODE_OAUTH_TOKEN

# /data is the only volume this image persists — the Dockerfile points
# XDG_CONFIG_HOME/XDG_DATA_HOME there so OpenCode's own config/auth (e.g. a
# one-time `opencode auth login`) survives container recreation, but a fresh
# volume won't already contain those subdirectories. A /data that cannot be
# written is fatal: the bridge keeps its identity there.
mkdir -p "${XDG_CONFIG_HOME:-/data/.config}" "${XDG_DATA_HOME:-/data/.local/share}"

# 1. Optionally install gsd-core globally for Claude integration. Off by
#    default (this is a real network call to the npm registry on every
#    container boot, and the bridge's GSD strip already degrades to a blank
#    snapshot when gsd-tools is missing). Opt in with
#    CODEDECK_GSD_AUTO_INSTALL=1, mirroring the CODEDECK_OPENCODE_AUTO_START
#    convention. An unset/empty value (Compose's `${VAR:-}` default for every
#    operator who never touched it) and an explicit "0"/"false" both mean
#    disabled.
case "${CODEDECK_GSD_AUTO_INSTALL:-}" in
  ''|0|false) ;;
  *)
    npx --yes @opengsd/gsd-core@1.12.0 --claude --global \
      || warn "installing gsd-core failed; sessions run without GSD"
    ;;
esac

# 2. Make Git authentication available to Claude and interactive shells via a
# helper that reads the runtime secret without persisting the token.

normalize_repository_url() {
  local url="$1"
  url="${url%/}"
  url="${url%.git}"
  printf '%s' "$url"
}

if [ -n "$GITHUB_TOKEN" ]; then
  git config --global credential.helper codedeck-secret
else
  info "no GitHub token set: Git over HTTPS works for public repositories only"
fi

# 3. Setup Git user identity
if [ -n "${GIT_USER:-}" ]; then
  git config --global user.name "$GIT_USER"
fi
if [ -n "${GIT_EMAIL:-}" ]; then
  git config --global user.email "$GIT_EMAIL"
fi
if [ -z "${GIT_USER:-}" ] || [ -z "${GIT_EMAIL:-}" ]; then
  info "GIT_USER/GIT_EMAIL not both set: commits made in sessions need an identity configured some other way"
fi

# 4. Clone or update the repositories in GIT_REPO (comma-separated). Each
# entry stands alone: one that is invalid, or fails to clone or update, is
# skipped with a warning and the rest still are.
WORKSPACES_DIR="/data/workspaces"
mkdir -p "$WORKSPACES_DIR"
# A repository that needs credentials nobody gave fails (and is warned
# about) instead of waiting on a password prompt.
export GIT_TERMINAL_PROMPT=0

# Clone `repository` into `name`, or fast-forward the clone already there.
sync_repository() {
  local repository="$1" name="$2"
  local target="$WORKSPACES_DIR/$name"
  if [ -e "$target" ] || [ -L "$target" ]; then
    if [ -L "$target" ] || [ ! -d "$target/.git" ]; then
      warn "skipping $name: $target exists but is not a Git repository"
      return
    fi
    if ! git -C "$target" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      warn "skipping $name: $target holds an invalid Git repository"
      return
    fi
    local origin
    if ! origin=$(git -C "$target" config --get remote.origin.url); then
      warn "skipping $name: $target has no readable origin"
      return
    fi
    if [ "$(normalize_repository_url "$origin")" != "$(normalize_repository_url "$repository")" ]; then
      warn "skipping $name: the origin of $target is not the repository GIT_REPO names"
      return
    fi
    info "updating $name"
    git -C "$target" pull --ff-only || warn "could not update $name (offline, or it has diverged); using it as it is"
  else
    info "cloning $name"
    git clone "$repository" "$target" || warn "could not clone $name; it is skipped"
  fi
}

if [ -n "${GIT_REPO:-}" ]; then
  IFS=',' read -ra RAW_REPOSITORIES <<< "$GIT_REPO"
  SEEN_NAMES=" "
  for repository in "${RAW_REPOSITORIES[@]}"; do
    repository="${repository#"${repository%%[![:space:]]*}"}"
    repository="${repository%"${repository##*[![:space:]]}"}"
    [ -n "$repository" ] || continue
    case "$repository" in
      http://*:*@*|https://*:*@*)
        # Never echoed: the entry holds a credential.
        warn "skipping a GIT_REPO entry with a credential in its URL; use the github_token secret instead"
        continue
        ;;
      *$'\n'*|*$'\r'*)
        warn "skipping a malformed GIT_REPO entry"
        continue
        ;;
    esac
    name=$(basename "${repository%/}" .git)
    case "$name" in
      ''|.|..|*[!A-Za-z0-9._-]*)
        warn "skipping GIT_REPO entry $repository: no usable directory name in it"
        continue
        ;;
    esac
    case "$SEEN_NAMES" in
      *" $name "*)
        warn "skipping GIT_REPO entry $repository: another entry already uses the name $name"
        continue
        ;;
    esac
    SEEN_NAMES="$SEEN_NAMES$name "
    sync_repository "$repository" "$name"
  done
fi

# Start CodeDeck from the shared root so its default working-directory workspace
# includes configured repositories, repositories cloned later by Claude, and
# local folders created under /data/workspaces.
cd "$WORKSPACES_DIR"

# 5. Start the CodeDeck bridge
info "starting the CodeDeck bridge"
exec /app/codedeck-bridge run
