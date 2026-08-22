/**
 * Phone → bridge command messages (published as COMMAND_KIND, stored, 1h expiry).
 *
 * Every command carries an optional `v` (sender's PROTOCOL_VERSION) and `caps`
 * so version/capability negotiation is two-directional — the bridge can degrade
 * or reject instead of silently ignoring what it doesn't understand.
 */
import { z } from 'zod';
import {
  deviceConfigSchema,
  effortLevelSchema,
  permissionModeSchema,
  providerBaseUrlSchema,
  providerModelSchema,
} from './common';

const versionFields = {
  /** Sender's PROTOCOL_VERSION. */
  v: z.number().int().positive().optional(),
  /** Sender's capability strings. */
  caps: z.array(z.string()).optional(),
};

export const inputMessageSchema = z.object({
  ...versionFields,
  type: z.literal('input'),
  sessionId: z.string().min(1),
  text: z.string(),
  /** v10: client-generated id echoed back in `input-ack` — drives the phone's
   *  outbox (pending → published → confirmed → failed). */
  inputId: z.string().optional(),
});

export const questionInputMessageSchema = z.object({
  ...versionFields,
  type: z.literal('question-input'),
  sessionId: z.string().min(1),
  text: z.string(),
  optionCount: z.number().int().nonnegative(),
});

export const permissionResponseMessageSchema = z.object({
  ...versionFields,
  type: z.literal('permission-res'),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  allow: z.boolean(),
  modifier: z.enum(['always', 'never']).optional(),
});

/** Single raw keypress for TUI-style prompts (plan approval, question selection). */
export const keypressMessageSchema = z.object({
  ...versionFields,
  type: z.literal('keypress'),
  sessionId: z.string().min(1),
  key: z.string().min(1),
  context: z.enum(['plan-approval', 'question']).optional(),
});

export const modeChangeMessageSchema = z.object({
  ...versionFields,
  type: z.literal('mode'),
  sessionId: z.string().min(1),
  mode: permissionModeSchema,
});

export const effortChangeMessageSchema = z.object({
  ...versionFields,
  type: z.literal('effort'),
  sessionId: z.string().min(1),
  level: effortLevelSchema,
});

export const modelChangeMessageSchema = z.object({
  ...versionFields,
  type: z.literal('model'),
  sessionId: z.string().min(1),
  model: z.string().min(1),
});

// --- Transcript sync (v10; replaces history-request/history) ---

/** Inclusive seq range [from, to]. */
export const seqRangeSchema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);
export type SeqRange = z.infer<typeof seqRangeSchema>;

/** Phone → bridge: "here is what I already have, send me the rest."
 *  `haveRanges` supports gaps (e.g. missed ephemeral output mid-stream). */
export const syncRequestMessageSchema = z.object({
  ...versionFields,
  type: z.literal('sync-request'),
  sessionId: z.string().min(1),
  haveRanges: z.array(seqRangeSchema),
});

/** Phone → bridge: acknowledges one delivered sync chunk. The bridge retries
 *  unacked chunks; anything still missing is re-requested on next connect. */
export const syncAckMessageSchema = z.object({
  ...versionFields,
  type: z.literal('sync-ack'),
  syncId: z.string().min(1),
  range: seqRangeSchema,
});

// --- Session lifecycle ---

export const createSessionMessageSchema = z.object({
  ...versionFields,
  type: z.literal('create-session'),
  defaultEffort: effortLevelSchema.optional(),
  model: z.string().optional(),
  /** Attach on-device test MCP tools (adb) — test sessions only. */
  testSession: z.boolean().optional(),
  /** Working directory, absolute or relative to a workspace root. Confined
   *  bridge-side to the workspace roots. */
  cwd: z.string().optional(),
  /** Create `cwd` (and `git init` it) when it doesn't exist yet. */
  createCwd: z.boolean().optional(),
  /** CDX-062: bind the session to a stored custom provider profile for its
   *  whole lifetime. Send ONLY when the bridge advertises 'custom-providers' —
   *  an old bridge's zod silently strips the unknown field and would run the
   *  session on Anthropic instead. */
  providerId: z.string().min(1).optional(),
});

export const refreshSessionsMessageSchema = z.object({
  ...versionFields,
  type: z.literal('refresh-sessions'),
});

export const closeSessionMessageSchema = z.object({
  ...versionFields,
  type: z.literal('close-session'),
  sessionId: z.string().min(1),
});

export const interruptMessageSchema = z.object({
  ...versionFields,
  type: z.literal('interrupt'),
  sessionId: z.string().min(1),
});

// --- Folder management (v10 first-class) ---

/** Phone → bridge: create a new project folder under a workspace root and
 *  `git init` it. Answered with `folder-ack`; the next session-list heartbeat
 *  carries the updated `folders[]`. */
export const createFolderMessageSchema = z.object({
  ...versionFields,
  type: z.literal('create-folder'),
  /** Folder path relative to the workspace root (validated bridge-side). */
  path: z.string().min(1),
  /** Which workspace root, when the bridge advertises several. Defaults to the first. */
  root: z.string().optional(),
  requestId: z.string().min(1),
});

// --- Image upload ---

/** Legacy chunked upload (pre-Blossom fallback). */
export const uploadImageChunkMessageSchema = z.object({
  ...versionFields,
  type: z.literal('upload-image'),
  sessionId: z.string().min(1),
  uploadId: z.string().min(1),
  filename: z.string(),
  mimeType: z.string(),
  base64Data: z.string(),
  text: z.string(),
  chunkIndex: z.number().int().nonnegative(),
  totalChunks: z.number().int().positive(),
});

/** Blossom upload — hash reference to an AES-256-GCM encrypted blob. */
export const uploadImageBlossomMessageSchema = z.object({
  ...versionFields,
  type: z.literal('upload-image'),
  sessionId: z.string().min(1),
  hash: z.string().min(1),
  url: z.string().min(1),
  key: z.string().min(1),
  iv: z.string().min(1),
  filename: z.string(),
  mimeType: z.string(),
  text: z.string(),
  sizeBytes: z.number().int().nonnegative(),
});

export const uploadImageMessageSchema = z.union([
  uploadImageBlossomMessageSchema,
  uploadImageChunkMessageSchema,
]);

// --- Status requests ---

export const usageRequestMessageSchema = z.object({
  ...versionFields,
  type: z.literal('usage-request'),
  sessionId: z.string().min(1),
});

export const gsdRequestMessageSchema = z.object({
  ...versionFields,
  type: z.literal('gsd-request'),
  sessionId: z.string().min(1),
});

/** v10 (CDB-030): ask the bridge for the SDK's live supported-model list. */
export const modelsRequestMessageSchema = z.object({
  ...versionFields,
  type: z.literal('models-request'),
});

// --- Credentials / device config / pairing ---

export const setCredentialsMessageSchema = z.object({
  ...versionFields,
  type: z.literal('set-credentials'),
  anthropicApiKey: z.string().nullable().optional(),
  githubPat: z.string().nullable().optional(),
});

export const setDeviceConfigMessageSchema = z.object({
  ...versionFields,
  type: z.literal('set-device-config'),
  config: deviceConfigSchema,
});

export const pairRequestMessageSchema = z.object({
  ...versionFields,
  type: z.literal('pair-request'),
  npub: z.string().min(1),
  pubkeyHex: z.string().min(1),
  label: z.string(),
  token: z.string().min(1),
});

// --- Custom AI provider profiles (CDX-062) ---

/** Upsert or delete one provider profile stored bridge-side (mirrors the
 *  `set-credentials` secret handling). `profile: null` deletes the whole
 *  profile. Answered with `provider-profile-ack`; the bridge then broadcasts
 *  a fresh redacted `provider-profiles` list to all paired phones. */
export const setProviderProfileMessageSchema = z.object({
  ...versionFields,
  type: z.literal('set-provider-profile'),
  profileId: z.string().min(1),
  profile: z
    .object({
      label: z.string().min(1),
      /** CDX-071: https, or http ONLY on loopback. This is the write gate both
       *  ends share: `encodePhoneToBridge` validates on the way out, so a
       *  cleartext profile throws at the phone (where the operator can fix it)
       *  rather than being dropped mid-flight by the bridge's decode. */
      baseUrl: providerBaseUrlSchema,
      /** Tri-state secret, same convention as `set-credentials`: undefined =
       *  keep the stored token, null = delete it, string = set it. This is the
       *  ONLY message the token ever rides on — bridge→phone traffic carries
       *  `hasToken` only (see providerProfileInfoSchema). */
      authToken: z.string().min(1).nullable().optional(),
      models: z.array(providerModelSchema).min(1),
      defaultModel: z.string().optional(),
    })
    .nullable(),
});

/** Ask the bridge for its redacted stored-profile list (`provider-profiles`). */
export const providerProfilesRequestMessageSchema = z.object({
  ...versionFields,
  type: z.literal('provider-profiles-request'),
});

// --- Union ---

export const phoneToBridgeSchema = z.union([
  inputMessageSchema,
  questionInputMessageSchema,
  permissionResponseMessageSchema,
  keypressMessageSchema,
  modeChangeMessageSchema,
  effortChangeMessageSchema,
  modelChangeMessageSchema,
  syncRequestMessageSchema,
  syncAckMessageSchema,
  createSessionMessageSchema,
  refreshSessionsMessageSchema,
  closeSessionMessageSchema,
  interruptMessageSchema,
  createFolderMessageSchema,
  uploadImageBlossomMessageSchema,
  uploadImageChunkMessageSchema,
  usageRequestMessageSchema,
  gsdRequestMessageSchema,
  modelsRequestMessageSchema,
  setCredentialsMessageSchema,
  setDeviceConfigMessageSchema,
  pairRequestMessageSchema,
  setProviderProfileMessageSchema,
  providerProfilesRequestMessageSchema,
]);

export type InputMessage = z.infer<typeof inputMessageSchema>;
export type QuestionInputMessage = z.infer<typeof questionInputMessageSchema>;
export type PermissionResponseMessage = z.infer<typeof permissionResponseMessageSchema>;
export type KeypressMessage = z.infer<typeof keypressMessageSchema>;
export type ModeChangeMessage = z.infer<typeof modeChangeMessageSchema>;
export type EffortChangeMessage = z.infer<typeof effortChangeMessageSchema>;
export type ModelChangeMessage = z.infer<typeof modelChangeMessageSchema>;
export type SyncRequestMessage = z.infer<typeof syncRequestMessageSchema>;
export type SyncAckMessage = z.infer<typeof syncAckMessageSchema>;
export type CreateSessionMessage = z.infer<typeof createSessionMessageSchema>;
export type RefreshSessionsMessage = z.infer<typeof refreshSessionsMessageSchema>;
export type CloseSessionMessage = z.infer<typeof closeSessionMessageSchema>;
export type InterruptMessage = z.infer<typeof interruptMessageSchema>;
export type CreateFolderMessage = z.infer<typeof createFolderMessageSchema>;
export type UploadImageMessage = z.infer<typeof uploadImageMessageSchema>;
export type UsageRequestMessage = z.infer<typeof usageRequestMessageSchema>;
export type GsdRequestMessage = z.infer<typeof gsdRequestMessageSchema>;
export type ModelsRequestMessage = z.infer<typeof modelsRequestMessageSchema>;
export type SetCredentialsMessage = z.infer<typeof setCredentialsMessageSchema>;
export type SetDeviceConfigMessage = z.infer<typeof setDeviceConfigMessageSchema>;
export type PairRequestMessage = z.infer<typeof pairRequestMessageSchema>;
export type SetProviderProfileMessage = z.infer<typeof setProviderProfileMessageSchema>;
export type ProviderProfilesRequestMessage = z.infer<typeof providerProfilesRequestMessageSchema>;
export type PhoneToBridgeMessage = z.infer<typeof phoneToBridgeSchema>;
