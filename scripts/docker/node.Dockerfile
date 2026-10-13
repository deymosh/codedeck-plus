# The Node image `./codedeck` runs the TypeScript workspace in — the
# throwaway containers behind `check`/`typecheck`/`test`, and the long-lived
# dev container behind `dev` and `live`. One image for all of them, so the
# checks and the loop run on the same Node and pnpm, and a dependency is
# downloaded once into the shared store volume.
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
