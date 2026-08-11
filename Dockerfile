FROM node:20-slim

# Install git, curl, gnupg, and GitHub CLI (gh), alongside pnpm and Claude Code
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl gnupg ca-certificates git \
    && mkdir -p -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && npm install -g pnpm@10.8.0 @anthropic-ai/claude-code ws \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN git clone --branch v0.9.3 https://github.com/JeroenOnNostr/codedeck-next-bridge.git . \
    && pnpm install \
    && pnpm add -w ws \
    && pnpm --filter @codedeck/bridge add ws \
    && pnpm build

# Create a non-root system user and group, and prepare persistent home/data folders
RUN groupadd -r codedeck && useradd -r -g codedeck -m -d /home/codedeck codedeck \
    && mkdir -p /data \
    && chown -R codedeck:codedeck /app /data /home/codedeck \
    && rm -rf /home/codedeck/.codedeck \
    && ln -s /data /home/codedeck/.codedeck \
    && chown -h codedeck:codedeck /home/codedeck/.codedeck

# Copy both entrypoint files
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
COPY main.js /app/main.js

# Set the working directory and volume for persistent data storage
WORKDIR /data
VOLUME /data

# Switch to the non-root user for security
USER codedeck

# Set the entrypoint script to be executed when the container starts
CMD ["/app/entrypoint.sh"]