# syntax=docker/dockerfile:1
#
# Three stages, so the runtime image carries only what the bridge executes:
#   bridge     the Rust `codedeck-bridge` binary, built on the SAME base
#              image as the runtime so the glibc it links against is the
#              one it runs on.
#   agenthost  the agent host (packages/agent-host): esbuild bundle, then
#              `pnpm deploy --prod` of its own dependency closure — the
#              Claude Agent SDK and the OpenCode client, nothing else.
#   runtime    node:slim (the agent host is Node) + git/gh/python3 for the
#              agent's own tool use.
#
# The agents' own binaries are NOT in the image. The agent host installs
# OpenCode, the default agent, when it first starts, and any other agent when
# someone installs it from the phone (or `codedeck-bridge agents install`),
# pinned to pnpm-lock.yaml's sha512, into /data/agents — the persisted volume,
# so a container recreated from a newer image reuses them until the pin moves.
# /data/agents/bin (links under stable names) is on PATH for a shell in the
# container, e.g. a one-time `opencode auth login`.
#
# A host without npm registry access points CODEDECK_NPM_REGISTRY at a
# reachable mirror, runs `codedeck-bridge agents install <agent>…` once while
# online (the volume keeps them across image rebuilds), or copies the
# /data/agents volume from another deployment.

ARG NODE_IMAGE=node:24.20.0-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS bridge
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path
WORKDIR /src
# The whole Rust workspace: cargo needs every member's manifest to resolve,
# even though only the bridge (and what it depends on) is compiled.
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
# The release number `codedeck-bridge version` reports (empty = the crate version).
ARG CODEDECK_VERSION=
RUN --mount=type=cache,id=codedeck-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=codedeck-cargo-target,target=/src/target \
    CODEDECK_VERSION="$CODEDECK_VERSION" cargo build --release --locked -p bridge-runtime \
    && cp target/release/codedeck-bridge /codedeck-bridge \
    && /codedeck-bridge version

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS agenthost
WORKDIR /src
RUN npm install -g pnpm@10.8.0
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/agent-host/package.json packages/agent-host/
RUN --mount=type=cache,id=codedeck-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @codedeck/agent-host...
COPY packages/agent-host ./packages/agent-host
RUN pnpm --filter @codedeck/agent-host run build
# --legacy: deploy the package's own prod dependency closure without
# requiring inject-workspace-packages. The SDK's platform packages (the Claude
# Code binary) go with it: the host installs that binary on demand at the
# lockfile's pin, so the image must not carry another at the SDK's version.
RUN --mount=type=cache,id=codedeck-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @codedeck/agent-host deploy --prod --legacy /deploy \
    && rm -rf /deploy/src /deploy/tsconfig.json /deploy/build.mjs \
    && rm -rf /deploy/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-*@*

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE}

ARG USER_ID=1000
ARG GROUP_ID=1000

# git/gh/python3/curl are for the agent's own tool use inside sessions. The
# GitHub CLI keyring is served already dearmored, so no gnupg is needed.
# yarn and corepack ship with the node image and nothing here uses them (npm
# stays, for the agents' own use in sessions).
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
# Claude Code keeps its settings, plugins and marketplaces, and the
# conversations a session resumes, under ~/.claude — moved under /data for
# the same reason, so plugins installed from the phone and resumable
# sessions both survive recreation.
ENV CLAUDE_CONFIG_DIR=/data/.claude
# The bridge home, named directly rather than through the ~/.codedeck
# symlink, so the paths the bridge reports (its default workspace root,
# /data/workspaces, among them) are the volume's own.
ENV CODEDECK_HOME=/data
# The agents installed on demand, under their stable names (see the top).
ENV PATH=$PATH:/data/agents/bin

# Create the user (the node base image already owns UID/GID 1000 — rename it).
# /data/agents holds the agents the host installs on demand; created and owned
# here, it gives the volume compose mounts at that path the ownership the
# runtime user needs to install into it.
RUN if getent group ${GROUP_ID}; then groupmod -n codedeck $(getent group ${GROUP_ID} | cut -d: -f1); \
    else groupadd -g ${GROUP_ID} codedeck; fi \
    && if getent passwd ${USER_ID}; then usermod -l codedeck -d /home/codedeck -m $(getent passwd ${USER_ID} | cut -d: -f1); \
    else useradd -u ${USER_ID} -g codedeck -m -d /home/codedeck codedeck; fi \
    && mkdir -p /data /data/agents \
    && chown codedeck:codedeck /data /data/agents \
    && rm -rf /home/codedeck/.codedeck \
    && ln -s /data /home/codedeck/.codedeck \
    && chown -h codedeck:codedeck /home/codedeck/.codedeck

# Root-owned and read-only to the runtime user: nothing under /app is state.
# The binary finds the agent host at agent-host/ beside it.
COPY --from=agenthost /deploy /app/agent-host
COPY --from=bridge /codedeck-bridge /app/codedeck-bridge
COPY --chmod=0755 docker/entrypoint.sh /app/entrypoint.sh
COPY --chmod=0755 docker/git-credential-codedeck-secret /usr/local/bin/git-credential-codedeck-secret
COPY --chmod=0755 docker/gh-codedeck-secret /usr/local/bin/gh
RUN ln -s /app/codedeck-bridge /usr/local/bin/codedeck-bridge \
    && codedeck-bridge version

USER codedeck
WORKDIR /data
VOLUME /data

CMD ["/app/entrypoint.sh"]
