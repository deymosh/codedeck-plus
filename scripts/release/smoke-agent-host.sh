#!/usr/bin/env bash
# Start a packaged agent host the way the bridge does and check it answers
# `initialize` with Claude Code in its catalog — proof that the archive's
# Node can load the bundle and its node_modules, whatever their layout.
# Test mode: nothing is downloaded, no API key is needed.
#
# Usage: scripts/release/smoke-agent-host.sh <node> <agent-host>/dist/main.js
set -euo pipefail

node="$1"
main="$2"

# stdin stays open for a while after the request: closing it is the host's
# signal to shut down, which could otherwise beat the reply.
reply="$(
  { echo '{"v":1,"id":"smoke","kind":"initialize","payload":{"bridgeVersion":"smoke"}}'; sleep 10; } |
    CODEDECK_TEST_MODE=1 CODEDECK_AGENT_HOST_DRIVERS=claude-code timeout 30 "$node" "$main" |
    head -n 1
)" || true

case "$reply" in
  *'"kind":"initialized"'*'"id":"claude-code"'*)
    echo "agent host OK: ${reply:0:120}..."
    ;;
  *)
    echo "::error::the packaged agent host did not answer initialize (got: ${reply:-nothing})" >&2
    exit 1
    ;;
esac
