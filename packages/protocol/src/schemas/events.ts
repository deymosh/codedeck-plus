/**
 * Bridge → phone messages — v11 mirror of `crates/protocol/src/events.rs`,
 * which is authoritative.
 *
 * Storage class per message (see kinds.ts):
 * - `sessions` rides SESSION_LIST_KIND (replaceable heartbeat).
 * - `output`, `usage`, `gsd-state` ride LIVE_KIND (ephemeral — loss recoverable
 *   via sync / re-request).
 * - Everything else (sync chunks, acks, lifecycle, pairing) rides RESPONSE_KIND
 *   (stored, 1h expiry) so a briefly-offline phone still receives it.
 */
import { z } from 'zod';
import {
  agentDescriptorSchema,
  credentialStatusSchema,
  gsdStateSchema,
  outputEntrySchema,
  providerProfileInfoSchema,
  remoteSessionInfoSchema,
  sessionOptionSchema,
  usageDataSchema,
} from './common';
import { seqRangeSchema } from './commands';

// --- Session list heartbeat ---

export const sessionListMessageSchema = z.object({
  type: z.literal('sessions'),
  machine: z.string().min(1),
  /** Which host binary publishes this list (UI badge; identity is the keypair). */
  host: z.enum(['cli', 'vscode', 'service']).optional(),
  sessions: z.array(remoteSessionInfoSchema),
  /** The agent backends this bridge can run sessions on. */
  agents: z.array(agentDescriptorSchema),
  /** The bridge's own credentials (not tied to an agent), e.g. a GitHub token. */
  credentials: z.array(credentialStatusSchema).default([]),
  protocolVersion: z.number().int().positive(),
  capabilities: z.array(z.string()).optional(),
  /** Project folders per workspace root, relative paths. Valid `create-session.cwd` values. */
  folders: z.array(z.string()).optional(),
  /**
   * CDX-031: the workspace roots themselves, ABSOLUTE, in `--workspace` order.
   *
   * `folders` lists what is *inside* the roots and cannot name a root: a root
   * never appears among its own children, and two roots' children are unioned
   * into one flat list with no root identity. So with `--workspace a
   * --workspace b` the phone had no way to say "start in b" — the picker
   * offered `a`'s and `b`'s subfolders and every relative path resolves
   * against the FIRST root that contains it.
   *
   * Absolute, addressed exactly like `create-folder.root`, and a valid
   * `create-session.cwd`: `resolveSessionCwdMulti` matches an absolute request
   * against each root's containment check, so root N resolves to itself and a
   * path outside every root still falls back to the first root.
   */
  roots: z.array(z.string()).optional(),
  /** v10: explicit tombstones. The ONLY way a bridge removes a session from the
   *  phone — absence from `sessions` alone never deletes (the old behaviour
   *  silently wiped phones whenever a bridge published a short list). */
  removedSessions: z.array(z.string()).optional(),
  /** v10: set on clean shutdown — sessions remain listed (state: 'offline'). */
  machineOffline: z.boolean().optional(),
});

// --- Live output ---

export const outputMessageSchema = z.object({
  type: z.literal('output'),
  sessionId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  entry: outputEntrySchema,
});

/** v10: confirms receipt of an `input` command (echoes `inputId`) — the phone's
 *  outbox flips pending → confirmed on this, or surfaces failure on timeout. */
export const inputAckMessageSchema = z.object({
  type: z.literal('input-ack'),
  sessionId: z.string().min(1),
  inputId: z.string().min(1),
});

// --- Transcript sync (v10) ---

export const syncBeginMessageSchema = z.object({
  type: z.literal('sync-begin'),
  sessionId: z.string().min(1),
  syncId: z.string().min(1),
  /** Highest persisted seq at sync start — the phone's completeness target. */
  seqHigh: z.number().int().nonnegative(),
  /** Ranges this sync will deliver (the complement of the request's haveRanges). */
  ranges: z.array(seqRangeSchema),
});

export const syncChunkMessageSchema = z.object({
  type: z.literal('sync-chunk'),
  sessionId: z.string().min(1),
  syncId: z.string().min(1),
  /** Inclusive seq range covered by this chunk. */
  range: seqRangeSchema,
  entries: z.array(
    z.object({
      seq: z.number().int().nonnegative(),
      entry: outputEntrySchema,
    }),
  ),
});

export const syncEndMessageSchema = z.object({
  type: z.literal('sync-end'),
  sessionId: z.string().min(1),
  syncId: z.string().min(1),
  /** What was actually delivered (after retries) — the phone re-requests the
   *  difference on next connect instead of assuming completeness. */
  deliveredRanges: z.array(seqRangeSchema),
});

// --- Two-phase session creation ---

export const sessionPendingMessageSchema = z.object({
  type: z.literal('session-pending'),
  pendingId: z.string().min(1),
  machine: z.string(),
  createdAt: z.string(),
});

export const sessionReadyMessageSchema = z.object({
  type: z.literal('session-ready'),
  pendingId: z.string().min(1),
  session: remoteSessionInfoSchema,
});

export const sessionFailedMessageSchema = z.object({
  type: z.literal('session-failed'),
  pendingId: z.string().min(1),
  reason: z.string(),
});

// --- Lifecycle acks / notices ---

export const inputFailedMessageSchema = z.object({
  type: z.literal('input-failed'),
  sessionId: z.string().min(1),
  /** 'no-session': the bridge knows no such session; 'error': the session
   *  exists but rejected the input (dead/ended runner); 'busy': reserved for
   *  a runner that cannot take input right now; 'expired': the command aged
   *  out before the bridge saw it. */
  reason: z.enum(['no-session', 'expired', 'busy', 'error']),
  /** Echoed when the failing input carried an id (outbox correlation). */
  inputId: z.string().optional(),
});

export const closeSessionAckMessageSchema = z.object({
  type: z.literal('close-session-ack'),
  sessionId: z.string().min(1),
  success: z.boolean(),
});

export const sessionReplacedMessageSchema = z.object({
  type: z.literal('session-replaced'),
  oldSessionId: z.string().min(1),
  newSession: remoteSessionInfoSchema,
});

/** A session option now has `value` — the reply to `set-option`, and also
 *  sent when the agent changes an option on its own (e.g. entering plan mode). */
export const optionConfirmedMessageSchema = z.object({
  type: z.literal('option-confirmed'),
  sessionId: z.string().min(1),
  option: sessionOptionSchema,
  value: z.string(),
});

export const folderAckMessageSchema = z.object({
  type: z.literal('folder-ack'),
  requestId: z.string().min(1),
  success: z.boolean(),
  /** Created folder path relative to its root (usable as create-session.cwd). */
  path: z.string().optional(),
  error: z.string().optional(),
});

// --- Status snapshots ---

export const usageMessageSchema = z.object({
  type: z.literal('usage'),
  sessionId: z.string().min(1),
  usage: usageDataSchema,
});

export const gsdStateMessageSchema = z.object({
  type: z.literal('gsd-state'),
  sessionId: z.string().min(1),
  gsd: gsdStateSchema,
});

/** An agent's live model list. */
export const modelsMessageSchema = z.object({
  type: z.literal('models'),
  /** Echoes the request's `agent`. */
  agent: z.string().min(1),
  models: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().optional(),
    }),
  ),
  defaultModel: z.string().optional(),
  /** CDX-035: why the bridge could not answer with a list. Set ONLY alongside
   *  an empty `models` — an empty list is "could not answer", never "this
   *  agent supports zero models", so the phone shows the reason, keeps
   *  whatever list it already had, and keeps re-requesting. */
  error: z.string().optional(),
});

// --- Credentials / device config / pairing ---

/** Reply to `set-credentials`: the resulting status of every credential in
 *  the written scope (`agent`, or the bridge's own when absent). */
export const credentialsAckMessageSchema = z.object({
  type: z.literal('credentials-ack'),
  machine: z.string(),
  agent: z.string().optional(),
  success: z.boolean(),
  credentials: z.array(credentialStatusSchema),
  error: z.string().optional(),
});

export const deviceConfigAckMessageSchema = z.object({
  type: z.literal('device-config-ack'),
  success: z.boolean(),
  reachable: z.boolean().optional(),
  error: z.string().optional(),
});

export const pairAckMessageSchema = z.object({
  type: z.literal('pair-ack'),
  machine: z.string(),
  ok: z.boolean(),
  reason: z.enum(['bad-token', 'window-closed']).optional(),
  /** The bridge's relay list, so a manual-npub pairing (which carries no
   *  relays in its URL) still learns where this bridge actually lives. The
   *  phone merges these into its settings (deduped). */
  relays: z.array(z.string()).optional(),
  /** Which host binary acked — same badge vocabulary as the heartbeat. */
  host: z.enum(['cli', 'vscode', 'service']).optional(),
});

// --- Custom AI provider profiles (CDX-062) ---

/** The bridge's redacted stored-profile list (each entry carries `hasToken`,
 *  never the token itself). Rides RESPONSE_KIND (stored) so a briefly-offline
 *  phone still receives it. Deliberately NO `error` field — unlike `models`
 *  (which needs a live SDK to answer), this is always answerable straight from
 *  bridge storage, so there is no "could not answer" case to report. */
export const providerProfilesMessageSchema = z.object({
  type: z.literal('provider-profiles'),
  machine: z.string(),
  profiles: z.array(providerProfileInfoSchema),
});

/** Ack for one `set-provider-profile`. Rides RESPONSE_KIND (stored).
 *  `tokenValid` is tri-state like credentials-ack's `keyValid`: true/false =
 *  live probe verdict, absent = the probe could not run (network error). */
export const providerProfileAckMessageSchema = z.object({
  type: z.literal('provider-profile-ack'),
  machine: z.string(),
  profileId: z.string().min(1),
  success: z.boolean(),
  tokenValid: z.boolean().optional(),
  error: z.string().optional(),
});

// --- Union ---

export const bridgeToPhoneSchema = z.union([
  sessionListMessageSchema,
  outputMessageSchema,
  inputAckMessageSchema,
  syncBeginMessageSchema,
  syncChunkMessageSchema,
  syncEndMessageSchema,
  sessionPendingMessageSchema,
  sessionReadyMessageSchema,
  sessionFailedMessageSchema,
  inputFailedMessageSchema,
  closeSessionAckMessageSchema,
  sessionReplacedMessageSchema,
  optionConfirmedMessageSchema,
  folderAckMessageSchema,
  usageMessageSchema,
  gsdStateMessageSchema,
  modelsMessageSchema,
  credentialsAckMessageSchema,
  deviceConfigAckMessageSchema,
  pairAckMessageSchema,
  providerProfilesMessageSchema,
  providerProfileAckMessageSchema,
]);

export type SessionListMessage = z.infer<typeof sessionListMessageSchema>;
export type OutputMessage = z.infer<typeof outputMessageSchema>;
export type InputAckMessage = z.infer<typeof inputAckMessageSchema>;
export type SyncBeginMessage = z.infer<typeof syncBeginMessageSchema>;
export type SyncChunkMessage = z.infer<typeof syncChunkMessageSchema>;
export type SyncEndMessage = z.infer<typeof syncEndMessageSchema>;
export type SessionPendingMessage = z.infer<typeof sessionPendingMessageSchema>;
export type SessionReadyMessage = z.infer<typeof sessionReadyMessageSchema>;
export type SessionFailedMessage = z.infer<typeof sessionFailedMessageSchema>;
export type InputFailedMessage = z.infer<typeof inputFailedMessageSchema>;
export type CloseSessionAckMessage = z.infer<typeof closeSessionAckMessageSchema>;
export type SessionReplacedMessage = z.infer<typeof sessionReplacedMessageSchema>;
export type OptionConfirmedMessage = z.infer<typeof optionConfirmedMessageSchema>;
export type FolderAckMessage = z.infer<typeof folderAckMessageSchema>;
export type UsageMessage = z.infer<typeof usageMessageSchema>;
export type GsdStateMessage = z.infer<typeof gsdStateMessageSchema>;
export type ModelsMessage = z.infer<typeof modelsMessageSchema>;
export type CredentialsAckMessage = z.infer<typeof credentialsAckMessageSchema>;
export type DeviceConfigAckMessage = z.infer<typeof deviceConfigAckMessageSchema>;
export type PairAckMessage = z.infer<typeof pairAckMessageSchema>;
export type ProviderProfilesMessage = z.infer<typeof providerProfilesMessageSchema>;
export type ProviderProfileAckMessage = z.infer<typeof providerProfileAckMessageSchema>;
export type BridgeToPhoneMessage = z.infer<typeof bridgeToPhoneSchema>;
