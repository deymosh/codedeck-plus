/**
 * Protocol version + capability negotiation — v11 mirror of
 * `crates/protocol/src/capabilities.rs`, which is authoritative.
 *
 * The bridge advertises `protocolVersion` and `capabilities` on the session-list
 * heartbeat; the phone stamps commands with `v` (and optionally `caps`). Feature
 * gating is on capability STRINGS and on the per-agent catalog
 * (`AgentDescriptor.supports`), never on version comparisons.
 *
 * What an individual AGENT can do (models, usage, custom providers, GSD) is
 * catalog data, not a capability: capabilities describe the BRIDGE. Tiers (do
 * not add a string as a "gate" unless a peer that has not seen it would
 * otherwise hard-fail):
 *
 * • HARD GATE — absence changes behaviour: `images` (the phone shows image
 *   attach only when the bridge advertises it).
 * • PRESENCE MARKER — detection is on payload data: `sync/1`, `folders`,
 *   `device-actions`. Kept so a session list is self-describing.
 * • TRANSPORT BEACON — `chunked`: advertised on both sides, gated by neither.
 *   Fragmentation lives below the semantic layer (chunking.ts).
 */

/** v11 = the agent-neutral protocol: per-agent catalog, typed transcript
 *  entries, typed answers, `set-option`. Clean break from v10 — no v10
 *  compatibility. */
export const PROTOCOL_VERSION = 11;

export const CAPABILITIES = {
  /** PRESENCE MARKER. Transcript sync protocol v1; always runs. */
  sync1: 'sync/1',
  /** PRESENCE MARKER. Folder listing; the phone gates on the heartbeat's
   *  `folders[]`/`roots[]` arrays. */
  folders: 'folders',
  /** HARD GATE (phone-side). Image upload (Blossom + chunked fallback). */
  images: 'images',
  /** PRESENCE MARKER. On-device test sessions with adb MCP tools; no phone UI
   *  sends them (they are driven from the paired laptop). */
  deviceActions: 'device-actions',
  /** TRANSPORT BEACON. Oversize-event `chunk` fragmentation: a message whose
   *  encoded JSON would exceed one Nostr event's content cap is split into
   *  independently encrypted `chunk` events and reassembled before decode. */
  chunked: 'chunked',
} as const;

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

/** Every capability the reference bridge ships with. */
export const ALL_BRIDGE_CAPABILITIES: readonly Capability[] = [
  CAPABILITIES.sync1,
  CAPABILITIES.folders,
  CAPABILITIES.images,
  CAPABILITIES.deviceActions,
  CAPABILITIES.chunked,
];

/** Capabilities the reference phone stamps on outgoing command `caps`. */
export const ALL_PHONE_CAPABILITIES: readonly Capability[] = [CAPABILITIES.chunked];

/** Which host binary a bridge is running as (disambiguates two bridges on one
 *  machine — identity is the keypair, this is only a UI badge). */
export type BridgeHostKind = 'cli' | 'vscode' | 'service';
