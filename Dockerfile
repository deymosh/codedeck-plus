FROM node:22-slim

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

# 2. Global Node tools installation (npm): pnpm, @anthropic-ai/claude-code, and ws
RUN npm install -g pnpm@10.8.0 @anthropic-ai/claude-code ws

# 3. Create user and prepare folders FIRST (before cloning/installing)
RUN groupadd -r codedeck && useradd -r -g codedeck -m -d /home/codedeck codedeck \
    && mkdir -p /app /data \
    && chown -R codedeck:codedeck /app /data /home/codedeck \
    && rm -rf /home/codedeck/.codedeck \
    && ln -s /data /home/codedeck/.codedeck \
    && chown -h codedeck:codedeck /home/codedeck/.codedeck

WORKDIR /app

# Switch to the non-root user early so everything created from here is owned by 'codedeck'
USER codedeck

# 4. Clone repo and install dependencies as the final user (avoids massive chown later)
RUN git clone --branch v0.9.3 https://github.com/JeroenOnNostr/codedeck-next-bridge.git . \
    && pnpm install \
    && pnpm add -w ws \
    && pnpm --filter @codedeck/bridge add ws \
    && pnpm build

# Copy entrypoint and main files (ensuring they have proper permissions or letting Docker handle them)
USER root
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
COPY main.js /app/main.js

# Quick ownership fix just for these two script files
RUN chown codedeck:codedeck /app/entrypoint.sh /app/main.js
USER codedeck

# Set the working directory and volume for persistent data storage
WORKDIR /data
VOLUME /data

# Set the entrypoint script to be executed when the container starts
CMD ["/app/entrypoint.sh"]