# The image the long-lived dev container runs: the whole repository's own
# tooling in one container — Node with the pinned pnpm for the TypeScript
# workspace and the agent host, and Rust with clippy for the crates. `dev`
# and `live` use it, which is what makes `./codedeck dev cargo test -p …` and
# the agent-host spawn test work in the same place as `dev vitest …`.
#
# It is deliberately NOT the image the throwaway checks run in: those want one
# tool each and a small image (`node.Dockerfile`, `rust.Dockerfile`), while
# this one is built to be lived in. Rust comes first so the base — and the
# cargo registry and target volumes mounted into the container — are the same
# ones `./codedeck check` uses, which is what keeps both loops incremental.
#
# Built by `./codedeck` (ensure_dev_image), which passes the pnpm version
# pinned in package.json's "packageManager".
FROM rust:1-bookworm
ARG PNPM_VERSION
RUN rustup component add clippy
# NodeSource, because bookworm's own node is far behind the major this repo
# asks for (engines: >=22) and the checks run on. git and the small tools are
# for working inside the container: jq reads driver protocol frames, curl and
# ps poke at a running agent.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs git ca-certificates jq procps curl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g "pnpm@${PNPM_VERSION}"
ENV npm_config_store_dir=/pnpm-store
