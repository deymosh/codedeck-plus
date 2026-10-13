# The Node image `./codedeck` runs the TypeScript workspace checks in — the
# throwaway containers behind `check`, `typecheck` and `test`. Small on
# purpose: those want Node and the pinned pnpm, nothing else.
#
# The long-lived dev container (`dev`, `live`) is a different image on
# purpose — `workspace.Dockerfile`, which carries Rust too, because a session
# works on the crates and the agent host in the same place.
#
# Built by `./codedeck` (ensure_node_image), which passes the pnpm version
# pinned in package.json's "packageManager" as a build argument — the file
# itself never reads the repo, so the build context is this directory.
#
# node:22-slim is the major `engines` asks for and the one CI uses; jq reads
# the driver protocol's frames, curl and ps poke at a running agent, git is
# what the tree arrives with.
FROM node:22-slim
ARG PNPM_VERSION
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       git ca-certificates jq procps curl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g "pnpm@${PNPM_VERSION}"
# The pnpm store lives in a named volume mounted here, so a rerun only
# fetches what the lockfile changed.
ENV npm_config_store_dir=/pnpm-store
