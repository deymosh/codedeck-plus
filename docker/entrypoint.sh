#!/usr/bin/env bash
set -euo pipefail

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

# 1. Install gsd-core globally for Claude integration
npx --yes @opengsd/gsd-core@1.12.0 --claude --global

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
fi

# 3. Setup Git user identity
if [ -n "$GIT_USER" ]; then
  git config --global user.name "$GIT_USER"
fi

if [ -n "$GIT_EMAIL" ]; then
  git config --global user.email "$GIT_EMAIL"
fi

# 4. Manage repositories if GIT_REPO is provided. Commas separate repositories.
if [ -n "$GIT_REPO" ]; then
  WORKSPACES_DIR="/data/workspaces"
  mkdir -p "$WORKSPACES_DIR"
  IFS=',' read -ra RAW_REPOSITORIES <<< "$GIT_REPO"
  REPOSITORIES=()
  REPO_NAMES=()
  # Validate the complete list before cloning or pulling anything.
  for repository in "${RAW_REPOSITORIES[@]}"; do
    repository="${repository#"${repository%%[![:space:]]*}"}"
    repository="${repository%"${repository##*[![:space:]]}"}"
    if [ -z "$repository" ]; then
      echo "Empty repository entry in GIT_REPO" >&2
      exit 1
    fi
    case "$repository" in
      *$'\n'*|*$'\r'*|http://*:*@*|https://*:*@*)
        echo "Invalid or credential-bearing repository URL in GIT_REPO" >&2
        exit 1
        ;;
    esac
    REPO_NAME=$(basename "${repository%/}" .git)
    case "$REPO_NAME" in
      ''|.|..|*[!A-Za-z0-9._-]*)
        echo "Invalid repository name derived from GIT_REPO" >&2
        exit 1
        ;;
    esac
    for existing_name in "${REPO_NAMES[@]}"; do
      if [ "$existing_name" = "$REPO_NAME" ]; then
        echo "Duplicate repository name in GIT_REPO: $REPO_NAME" >&2
        exit 1
      fi
    done
    REPOSITORIES+=("$repository")
    REPO_NAMES+=("$REPO_NAME")
  done

  TARGET_EXISTS=()
  for index in "${!REPOSITORIES[@]}"; do
    repository="${REPOSITORIES[$index]}"
    REPO_NAME="${REPO_NAMES[$index]}"
    TARGET_DIR="$WORKSPACES_DIR/$REPO_NAME"

    if [ -e "$TARGET_DIR" ] || [ -L "$TARGET_DIR" ]; then
      if [ -L "$TARGET_DIR" ] || [ ! -d "$TARGET_DIR/.git" ]; then
        echo "Workspace path exists but is not a supported Git repository: $TARGET_DIR" >&2
        exit 1
      fi
      if ! git -C "$TARGET_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        echo "Workspace path contains an invalid Git repository: $TARGET_DIR" >&2
        exit 1
      fi
      EXISTING_ORIGIN=$(git -C "$TARGET_DIR" config --get remote.origin.url) || {
        echo "Workspace repository has no readable origin: $TARGET_DIR" >&2
        exit 1
      }
      if [ "$(normalize_repository_url "$EXISTING_ORIGIN")" != "$(normalize_repository_url "$repository")" ]; then
        echo "Workspace repository origin does not match GIT_REPO: $TARGET_DIR" >&2
        exit 1
      fi
      TARGET_EXISTS+=(1)
    else
      TARGET_EXISTS+=(0)
    fi
  done

  for index in "${!REPOSITORIES[@]}"; do
    repository="${REPOSITORIES[$index]}"
    REPO_NAME="${REPO_NAMES[$index]}"
    TARGET_DIR="$WORKSPACES_DIR/$REPO_NAME"
    if [ "${TARGET_EXISTS[$index]}" -eq 1 ]; then
      echo "Repository already exists at $TARGET_DIR, pulling latest changes..."
      git -C "$TARGET_DIR" pull --ff-only
    else
      echo "Cloning repository into $TARGET_DIR..."
      git clone "$repository" "$TARGET_DIR"
    fi
  done
fi

# Start CodeDeck from the shared root so its default process.cwd() workspace
# includes configured repositories, repositories cloned later by Claude, and
# local folders created under /data/workspaces.
mkdir -p "/data/workspaces"
cd "/data/workspaces"

# 5. Start the CodeDeck bridge
echo "Starting CodeDeck bridge..."
exec node /app/main.js run
