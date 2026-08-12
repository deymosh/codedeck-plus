#!/usr/bin/env bash
set -e

# 1. Install gsd-core globally for Claude integration
npx --yes @opengsd/gsd-core@latest --claude --global

# 2. Setup Git credentials via secure HTTP extraheader if GITHUB_TOKEN is provided
if [ -n "$GITHUB_TOKEN" ]; then
  echo "Configuring Git authentication via secure HTTP header..."

  # Encode credentials to Base64 (Format required by Git: x-access-token:TOKEN)
  TOKEN_B64=$(echo -n "x-access-token:$GITHUB_TOKEN" | base64 | tr -d '\n')
  git config --global http.extraheader "Authorization: Basic ${TOKEN_B64}"
fi

# 3. Setup Git user identity
if [ -n "$GIT_USER" ]; then
  git config --global user.name "$GIT_USER"
fi

if [ -n "$GIT_EMAIL" ]; then
  git config --global user.email "$GIT_EMAIL"
fi

# 4. Manage the repository if GIT_REPO is provided
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

# 5. Start the CodeDeck bridge
echo "Starting CodeDeck bridge..."
exec node /app/main.js run