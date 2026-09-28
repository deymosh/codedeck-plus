---
name: wire-change
description: Add or change a message, field or feature that crosses phone ⇄ bridge ⇄ agent host — the crate order, fixtures, and binding regeneration.
---

# A change across the wire

Contract: `docs/PROTOCOL.md` (Part 1 phone wire, Part 2 driver protocol,
"Adding an agent"). Read only the section for your message. Protocol v11 is a
clean break: no compatibility code; gate on a capability string only if an
older peer would otherwise hard-fail (`crates/protocol/src/capabilities.rs`
header), otherwise on the agent catalog's `supports` flags.

## Order — one commit per layer, each green

1. **Phone wire** `crates/protocol/src/` — phone→bridge in `commands.rs`,
   bridge→phone in `events.rs`, shared shapes in `common.rs`. Decoders stay
   total. Add a `valid` (and a `rejected`, when there is a rule) fixture to
   `fixtures/corpus.json` — `codec_conformance` fails until every message
   type has one (see `fixtures/README.md`). `cargo test -p protocol`.
2. **Driver protocol** `crates/agent-protocol/src/messages.rs` (+ `codec.rs`).
   Secrets travel as `agent_protocol::Secret`. Then regenerate the host's
   types: `cargo test -p agent-protocol --test gen_ts_bindings -- --ignored`
   (writes `packages/agent-host/src/generated/protocol.ts`; CI checks drift).
3. **Bridge** `crates/bridge-core/src/engine/` (pure: inputs → effects; one
   module per feature, e.g. `mcp.rs`), I/O in `crates/bridge-runtime`.
4. **Agent host** `packages/agent-host/src/drivers/<agent>/` — agent-specific
   behaviour lives only here. `pnpm --filter @codedeck/agent-host run test`.
5. **Phone core** `crates/client-core` (stores, pure) → `client-runtime` →
   `crates/client-ffi` (`intent.rs`, `views.rs`). Then
   `./codedeck gen-android-bindings`.
6. **Android** — see the `android-ui` skill.
7. **Docs** — the message in `docs/PROTOCOL.md`; `docs/BRIDGE.md` /
   `docs/CLIENT.md` if behaviour changed.
8. **End to end** (optional, for a round trip): `crates/bridge-runtime/tests/e2e.rs`,
   needs a built host; run with `-- --ignored`.

Check with `./codedeck check` (see the `verify-changes` skill). A
Tor/SOCKS-proxied path must stay proxied; secrets are never logged or echoed.
