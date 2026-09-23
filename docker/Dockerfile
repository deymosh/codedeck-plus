# syntax=docker/dockerfile:1
#
# Three stages, so the runtime image carries only what the bridge executes:
#   build     pnpm install + esbuild bundle, then `pnpm deploy --prod` of
#             apps/bridge — the bundle's only external runtime package is
#             the Claude Agent SDK (see apps/bridge/build.mjs), so devDeps
#             (typescript, vitest, esbuild, jsdom, ...) and the workspace
#             sources never reach the final image.
#   opencode  `npm install -g opencode-ai` pulls every CPU variant of the
#             OpenCode binary (~180MB each); its postinstall picks one and
#             materialises it as bin/opencode.exe. Only that one file is
#             copied out.
#   runtime   node:slim + git/gh/python3 for the agent's own tool use.
#
# The `claude` CLI is NOT installed globally: the Agent SDK's per-platform
# optional package already ships the matching Claude Code binary (its
# package.json `claudeCodeVersion`), so /usr/local/bin/claude is a symlink to
# it. That keeps the CLI version locked to the SDK version in pnpm-lock.yaml
# and avoids a second ~230MB copy.

ARG NODE_IMAGE=node:24.20.0-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /src
RUN npm install -g pnpm@10.8.0

# Manifests first so the dependency layer is reused across source-only edits.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/core/package.json packages/core/
COPY packages/testkit/package.json packages/testkit/
COPY apps/bridge/package.json apps/bridge/
RUN --mount=type=cache,id=codedeck-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @codedeck/bridge...

COPY packages ./packages
COPY apps/bridge ./apps/bridge
RUN pnpm --filter @codedeck/bridge run build

# --legacy: deploy the package's own prod dependency closure without
# requiring inject-workspace-packages (its workspace deps are devDeps, which
# --prod drops anyway — they are already inside out/main.js). The runtime base
# is Debian (glibc), so the SDK's musl binaries are dead weight.
RUN --mount=type=cache,id=codedeck-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @codedeck/bridge deploy --prod --legacy /deploy \
    && rm -rf /deploy/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-*-musl@* \
    && rm -rf /deploy/src /deploy/deploy /deploy/tsconfig.json /deploy/build.mjs \
    && claude_bin="$(find /deploy/node_modules/.pnpm -type f -path "*/claude-agent-sdk-linux-$(node -p process.arch)/claude")" \
    && test -n "$claude_bin" \
    && ln -s "${claude_bin#/deploy/}" /deploy/claude

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS opencode
# Keep in step with the @opencode-ai/sdk version in pnpm-lock.yaml — the
# bridge speaks that SDK's HTTP API to this binary.
ARG OPENCODE_VERSION=1.18.31
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" \
    && cp -L "$(readlink -f /usr/local/bin/opencode)" /opencode \
    && /opencode --version

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE}

ARG USER_ID=1000
ARG GROUP_ID=1000

# git/gh/python3/curl are for the agent's own tool use inside sessions. The
# GitHub CLI keyring is served already dearmored, so no gnupg is needed.
# yarn and corepack ship with the node image and nothing here uses them (npm
# stays: the entrypoint's opt-in GSD install runs through npx).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git python3 \
    && install -d -m 0755 /etc/apt/keyrings \
    && curl -fsSL -o /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /var/log/apt /var/log/dpkg.log \
    && rm -rf /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
       /usr/local/lib/node_modules/corepack /usr/local/bin/corepack

# OpenCode stores its own config/auth under XDG_CONFIG_HOME/XDG_DATA_HOME
# (default ~/.config, ~/.local/share). Redirect both under /data — the only
# volume this image persists (see the ~/.codedeck symlink below) — so a
# one-time `docker compose exec codedeck-bridge opencode auth login` survives
# container recreation instead of silently vanishing.
ENV XDG_CONFIG_HOME=/data/.config
ENV XDG_DATA_HOME=/data/.local/share

# Create the user (the node base image already owns UID/GID 1000 — rename it).
RUN if getent group ${GROUP_ID}; then groupmod -n codedeck $(getent group ${GROUP_ID} | cut -d: -f1); \
    else groupadd -g ${GROUP_ID} codedeck; fi \
    && if getent passwd ${USER_ID}; then usermod -l codedeck -d /home/codedeck -m $(getent passwd ${USER_ID} | cut -d: -f1); \
    else useradd -u ${USER_ID} -g codedeck -m -d /home/codedeck codedeck; fi \
    && mkdir -p /data \
    && chown codedeck:codedeck /data \
    && rm -rf /home/codedeck/.codedeck \
    && ln -s /data /home/codedeck/.codedeck \
    && chown -h codedeck:codedeck /home/codedeck/.codedeck

# Root-owned and read-only to the runtime user: nothing under /app is state.
COPY --from=opencode /opencode /usr/local/bin/opencode
COPY --from=build /deploy /app
COPY --chmod=0755 docker/entrypoint.sh /app/entrypoint.sh
COPY --chmod=0755 docker/git-credential-codedeck-secret /usr/local/bin/git-credential-codedeck-secret
COPY --chmod=0755 docker/gh-codedeck-secret /usr/local/bin/gh
COPY docker/main.js /app/main.js
RUN ln -s /app/claude /usr/local/bin/claude && claude --version

USER codedeck
WORKDIR /data
VOLUME /data

CMD ["/app/entrypoint.sh"]
