#!/usr/bin/env bash
set -e

# 1. Setup Git credentials if GITHUB_TOKEN is provided
if [ -n "$GITHUB_TOKEN" ]; then
  echo "Configuring Git credential helper for GitHub..."
  git config --global url."https://${GITHUB_TOKEN}:x-oauth-basic@github.com/".insteadOf "https://github.com/"
fi

# 2. Setup Git user identity
if [ -n "$GIT_USER" ]; then
  git config --global user.name "$GIT_USER"
fi

if [ -n "$GIT_EMAIL" ]; then
  git config --global user.email "$GIT_EMAIL"
fi

# 3. Manage the repository if GIT_REPO is provided
if [ -n "$GIT_REPO" ]; then
  # Extract the repository name from the URL (e.g., https://github.com/user/repo.git -> repo)
  REPO_NAME=$(basename "$GIT_REPO" .git)
  TARGET_DIR="/data/$REPO_NAME"

  if [ ! -d "$TARGET_DIR/.git" ]; then
    echo "Cloning repository $GIT_REPO into $TARGET_DIR..."
    git clone "$GIT_REPO" "$TARGET_DIR"
  else
    echo "Repository already exists at $TARGET_DIR, pulling latest changes..."
    cd "$TARGET_DIR" && git pull || true
  fi

  # Move to the repository directory for the bridge to work there
  cd "$TARGET_DIR"
else
  cd "/data"
fi

# 4. Start the CodeDeck bridge
echo "Starting CodeDeck bridge..."
exec node /app/main.js run