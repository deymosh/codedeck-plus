/**
 * Protocol version + capability negotiation (two-directional).
 *
 * The bridge advertises `protocolVersion` and `capabilities` on the session-list
 * heartbeat; the phone stamps commands with `v` (and optionally `caps`). Feature
 * gating is done on capability STRINGS, not version comparisons, so adding a
 * feature is one new string rather than a version-ladder entry.
 *
 * v10 = the monorepo rebuild: kind split (ephemeral live output 24515, stored
 * responses 4516), transcript sync protocol replacing fire-and-forget history
 * chunks, session tombstones, host discrimination, input acks. Clean break from
 * v9 — no compatibility with pre-v10 peers.
 */
export const PROTOCOL_VERSION = 10;

export const CAPABILITIES = {
  /** Transcript sync protocol v1 (sync-request/begin/chunk/ack/end). */
  sync1: 'sync/1',
  /** Workspace folder listing + per-session cwd + createProjectFolder. */
  folders: 'folders',
  /** GSD workflow snapshots (gsd-request / gsd-state). */
  gsd: 'gsd',
  /** Image upload (Blossom + chunked fallback). */
  images: 'images',
  /** On-device test sessions with adb MCP tools. */
  deviceActions: 'device-actions',
  /** Subscription usage snapshots (usage-request / usage). */
  usage: 'usage',
  /** Live model list from the SDK (models-request / models). */
  models: 'models',
  /**
   * Colored diff cards (CDX-050): `entryType: 'diff'` output entries carrying
   * a structured `diff` payload (file path + add/del/context lines). Two-sided:
   * the bridge advertises it on the heartbeat ("I can produce diff entries");
   * the PHONE advertises it on command `caps` ("I can render them"). The
   * bridge only emits diff entries once every phone it has heard from this
   * boot advertised the cap — a pre-CDX-050 phone hard-fails zod on the
   * unknown entryType and would drop the whole output message, so emission
   * defaults OFF until a capable phone proves itself.
   */
  diff: 'diff',
  /**
   * Custom AI provider profiles (CDX-062): the bridge stores provider
   * profiles (set-provider-profile / provider-profiles-request /
   * provider-profiles / provider-profile-ack) and honors
   * `create-session.providerId`. Advertised on the heartbeat ("I store
   * profiles and bind sessions to them"); the PHONE must gate ALL provider
   * UI and sends on it — an old bridge's zod silently strips the unknown
   * `providerId` field from create-session and would run the session on
   * Anthropic (wrong provider, wrong account's bill).
   */
  customProviders: 'custom-providers',
  /**
   * Oversize-event fragmentation (`chunk` envelopes). A bridge→phone message
   * whose encoded JSON would exceed one Nostr event's `content` cap (65535 B —
   * HAVEN/eventstore `MaxContentSize`) is split into N independently
   * NIP-44-encrypted `chunk` events and reassembled by the receiver before
   * decode (see chunking.ts). Advisory only: the bridge fragments whenever it
   * must (a large model reply would otherwise fail to publish at all), and the
   * phone reassembles whenever it sees `chunk` events — neither side gates on
   * the other advertising this. Present on both the heartbeat `capabilities`
   * and the phone command `caps` purely so the pair is observable.
   */
  chunked: 'chunked',
} as const;

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

/** Every capability the reference bridge implementation ships with. */
export const ALL_BRIDGE_CAPABILITIES: readonly Capability[] =
  Object.values(CAPABILITIES);

/** Capabilities the reference PHONE implementation stamps on outgoing command
 *  `caps` (feature strings the phone can RENDER — see `diff` above). */
export const ALL_PHONE_CAPABILITIES: readonly Capability[] = [CAPABILITIES.diff, CAPABILITIES.chunked];

/** Which host binary a bridge is running as (disambiguates two bridges on one
 *  machine — identity is the keypair, this is only a UI badge). */
export type BridgeHostKind = 'cli' | 'vscode' | 'service';
