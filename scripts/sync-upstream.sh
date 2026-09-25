#!/usr/bin/env bash
# scripts/sync-upstream.sh — refresh vendor/* from upstream and show what
# changed, so the relevant parts can be ported by hand.
#
# vendor/bridge and vendor/mobile are pristine git-subtree mirrors of
# codedeck-next-bridge and codedeck-next-mobile — never hand-edited. This
# repository started as a copy of them and has since been rebuilt: the
# protocol and the bridge are Rust (crates/*), the agent SDK code lives in
# packages/agent-host, the phone is apps/android. Upstream sync is therefore:
# pull into vendor/*, read what changed, and port the behaviour that matters
# to where it now lives.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

git remote add upstream-bridge https://github.com/JeroenOnNostr/codedeck-next-bridge.git 2>/dev/null || true
git remote add upstream-mobile https://github.com/JeroenOnNostr/codedeck-next-mobile.git 2>/dev/null || true

echo "==> Pulling upstream bridge into vendor/bridge"
git subtree pull --prefix=vendor/bridge upstream-bridge main --squash \
  -m "chore(vendor): sync bridge from upstream"

echo "==> Pulling upstream mobile into vendor/mobile"
git subtree pull --prefix=vendor/mobile upstream-mobile main --squash \
  -m "chore(vendor): sync mobile from upstream"

cat <<'EOF'

vendor/* refreshed. See what upstream changed since the last sync, e.g.:

  git diff HEAD~2 -- vendor/bridge vendor/mobile

and port what matters to where it lives now:

  upstream bridge engine (packages/core)  -> crates/bridge-core, crates/bridge-runtime
  upstream protocol (packages/protocol)   -> crates/protocol
  upstream SDK adapters (packages/core/src/sdk) -> packages/agent-host/src/drivers
  upstream mobile app (apps/mobile)       -> crates/client-core, apps/android
EOF
