FROM node:22-slim

# Set the user and group IDs to match the host system
ARG USER_ID=1000
ARG GROUP_ID=1000

# 1. System packages installation (APT): git, curl, gnupg, ca-certificates, and GitHub CLI
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl gnupg ca-certificates git \
    && mkdir -p -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# 2. Global Node tools installation (npm): pnpm and @anthropic-ai/claude-code.
#    ("ws" used to be force-installed here as a workaround — it is now a
#    proper dependency of @codedeck/core, declared in packages/core/package.json.)
RUN npm install -g pnpm@10.8.0 @anthropic-ai/claude-code

# 3. Create user safely (handling pre-existing UID/GID 1000 from node base image)
RUN if getent group ${GROUP_ID}; then groupmod -n codedeck $(getent group ${GROUP_ID} | cut -d: -f1); \
    else groupadd -g ${GROUP_ID} codedeck; fi \
    && if getent passwd ${USER_ID}; then usermod -l codedeck -d /home/codedeck -m $(getent passwd ${USER_ID} | cut -d: -f1); \
    else useradd -u ${USER_ID} -g codedeck -m -d /home/codedeck codedeck; fi \
    && mkdir -p /app /data \
    && chown -R codedeck:codedeck /app /data /home/codedeck \
    && rm -rf /home/codedeck/.codedeck \
    && ln -s /data /home/codedeck/.codedeck \
    && chown -h codedeck:codedeck /home/codedeck/.codedeck

WORKDIR /app

# Switch to the non-root user early so everything created from here is owned by 'codedeck'
USER codedeck

# 4. Copy just what the bridge build needs (workspace manifests + packages/*
#    + apps/bridge — NOT apps/mobile or vendor/, which need Android/Rust
#    toolchains this image has no reason to carry) and build it as the final
#    user (avoids massive chown later).
COPY --chown=codedeck:codedeck pnpm-workspace.yaml package.json pnpm-lock.yaml* tsconfig.base.json ./
COPY --chown=codedeck:codedeck packages ./packages
COPY --chown=codedeck:codedeck apps/bridge ./apps/bridge

RUN pnpm install --frozen-lockfile \
    && pnpm --filter @codedeck/bridge... run build

# Copy entrypoint and main files (ensuring they have proper permissions)
USER root
COPY --chown=codedeck:codedeck docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
COPY --chown=codedeck:codedeck main.js /app/main.js

# Switch back to the non-root user for running the application
USER codedeck

# Set the working directory and volume for persistent data storage
WORKDIR /data
VOLUME /data

CMD ["/app/entrypoint.sh"]