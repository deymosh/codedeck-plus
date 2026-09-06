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
 *
 * --- Not every string in `CAPABILITIES` is a runtime gate. Three tiers: ---
 *
 * • HARD GATE — the receiving peer will NOT use the feature until it has seen
 *   the string, because the alternative is a hard failure (an old peer's zod
 *   drops the message, or bills the wrong account). Today: `images`,
 *   `customProviders` (both gated phone-side on the bridge's heartbeat), and
 *   `diff` (gated bridge-side on the phone's command `caps` — see below).
 *   These are the only strings whose ABSENCE changes behaviour.
 *
 * • PRESENCE MARKER — the feature is unconditional in v10; real detection is on
 *   PAYLOAD DATA, not the string. `folders` (phone reads the heartbeat's
 *   `folders[]`/`roots[]` arrays), `gsd` (UI gates on `gsd.available` in the
 *   snapshot), `usage` / `models` (phone requests unconditionally, renders
 *   whatever comes back), `sync1` (transcript sync always runs). The string is
 *   kept purely so a session list is self-describing / greppable — removing it
 *   would change nothing at runtime. `deviceActions` is a marker too: the
 *   bridge fully implements `create-session.testSession`, but no phone UI sends
 *   it (test sessions are driven from the paired laptop, not the app).
 *
 * • TRANSPORT BEACON — `chunked`. Advertised on BOTH sides, gated by NEITHER,
 *   by design: oversize-event fragmentation lives below the semantic layer
 *   (chunking.ts). A phone that can't reassemble would drop the message anyway
 *   (zod has no `chunk` member), and the un-fragmented form is physically
 *   unpublishable (> relay content cap), so there is no alternative encoding to
 *   choose — unlike `diff`, gating would only turn "dropped" into "dropped".
 *   The pair is advertised solely so it's observable.
 */
export const PROTOCOL_VERSION = 10;

export const CAPABILITIES = {
  /** PRESENCE MARKER. Transcript sync protocol v1 (sync-request/begin/chunk/
   *  ack/end). Always runs in v10; nothing checks this string. */
  sync1: 'sync/1',
  /** PRESENCE MARKER. Workspace folder listing + per-session cwd +
   *  createProjectFolder. Phone gates on the heartbeat's `folders[]`/`roots[]`
   *  arrays being present, not on this string. */
  folders: 'folders',
  /** PRESENCE MARKER. GSD workflow snapshots (gsd-request / gsd-state). The
   *  strip UI gates on `gsd.available` in the snapshot payload, not this. */
  gsd: 'gsd',
  /** HARD GATE (phone-side). Image upload (Blossom + chunked fallback). The
   *  phone shows the attach control only when this is in the machine's
   *  heartbeat `capabilities` (SessionScreen). */
  images: 'images',
  /** PRESENCE MARKER. On-device test sessions with adb MCP tools. The bridge
   *  fully implements `create-session.testSession`; no phone UI sends it (test
   *  sessions are driven from the paired laptop). Advertised so a bridge that
   *  can host them is identifiable. */
  deviceActions: 'device-actions',
  /** PRESENCE MARKER. Subscription usage snapshots (usage-request / usage).
   *  Phone requests unconditionally; the badge is gated by a local setting. */
  usage: 'usage',
  /** PRESENCE MARKER. Live model list from the SDK (models-request / models).
   *  Phone re-requests unconditionally and renders whatever returns. */
  models: 'models',
  /**
   * HARD GATE (bridge-side, on the phone's command `caps`).
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
   * HARD GATE (phone-side).
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
   * TRANSPORT BEACON — advertised on both sides, gated by neither (see the
   * three-tier note at the top of this file).
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

/** Every capability the reference bridge implementation ships with. Advertised
 *  wholesale on the heartbeat; only `images` and `customProviders` are read by
 *  the phone as gates, the rest are presence markers (see the tier note above). */
export const ALL_BRIDGE_CAPABILITIES: readonly Capability[] =
  Object.values(CAPABILITIES);

/** Capabilities the reference PHONE implementation stamps on outgoing command
 *  `caps` (feature strings the phone can RENDER — see `diff` above). The bridge
 *  only ever reads `diff` from this list (phonesSupportDiff in bridge.ts);
 *  `chunked` is carried as a transport beacon so the negotiated pair is
 *  observable, not because anything gates on it. */
export const ALL_PHONE_CAPABILITIES: readonly Capability[] = [CAPABILITIES.diff, CAPABILITIES.chunked];

/** Which host binary a bridge is running as (disambiguates two bridges on one
 *  machine — identity is the keypair, this is only a UI badge). */
export type BridgeHostKind = 'cli' | 'vscode' | 'service';
