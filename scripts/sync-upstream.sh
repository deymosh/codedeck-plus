#!/usr/bin/env bash
# scripts/sync-upstream.sh — refresh vendor/* from upstream and show what
# changed, so it can be hand-merged into packages/* and apps/*.
#
# vendor/bridge and vendor/mobile are pristine git-subtree mirrors of
# codedeck-next-bridge and codedeck-next-mobile — never hand-edited. The
# working tree (packages/*, apps/bridge, apps/mobile) started as a copy of
# their content and has since diverged with local patches (Tor, NIP-42,
# resilience). `git subtree pull` can only refresh the pristine mirrors — it
# has no way to know which working-tree files moved where — so upstream sync
# is always: pull into vendor/*, then diff vendor/* against the working tree
# and hand-apply what's relevant.
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

vendor/* refreshed. Review upstream changes and hand-apply the relevant ones
into packages/* and apps/*, e.g.:

  diff -ru vendor/bridge/packages/core       packages/core
  diff -ru vendor/bridge/packages/protocol   packages/protocol
  diff -ru vendor/bridge/packages/testkit    packages/testkit
  diff    vendor/bridge/tsconfig.base.json   tsconfig.base.json
  diff -ru vendor/bridge/apps/bridge-cli     apps/bridge
  diff -ru vendor/mobile/apps/mobile         apps/mobile

Note: vendor/mobile/packages/* was deleted at fork time (it was byte-identical
to vendor/bridge/packages/* at the time of the fork) — packages/core stays the
single source of truth. If upstream mobile's copy has since diverged from
upstream bridge's, diff the two vendor mirrors against each other first to
decide which side's change is the one to port.
EOF
