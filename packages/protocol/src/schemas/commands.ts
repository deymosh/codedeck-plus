/**
 * Phone → bridge command messages (published as COMMAND_KIND, stored, 1h
 * expiry) — v11 mirror of `crates/protocol/src/commands.rs`, which is
 * authoritative.
 *
 * Every command carries an optional `v` (sender's PROTOCOL_VERSION) and `caps`
 * so version/capability negotiation is two-directional.
 */
import { z } from 'zod';
import {
  credentialValuesSchema,
  deviceConfigSchema,
  providerBaseUrlSchema,
  providerModelSchema,
  sessionOptionSchema,
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
  /** Client-generated id echoed back in `input-ack` — drives the phone's
   *  outbox (pending → published → confirmed → failed). */
  inputId: z.string().optional(),
});

/** Answer to a `permission_request` entry: one of its `options[].id`. */
export const permissionResponseMessageSchema = z.object({
  ...versionFields,
  type: z.literal('permission-response'),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  optionId: z.string().min(1),
});

/** The answer to one question: chosen option indices (into the question's
 *  `options`), or free text. */
export const questionAnswerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('options'), selected: z.array(z.number().int().nonnegative()) }),
  z.object({ kind: z.literal('text'), text: z.string() }),
]);
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;

/** Answer to question `index` of a `question` ask (`requestId`). */
export const questionResponseMessageSchema = z.object({
  ...versionFields,
  type: z.literal('question-response'),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  index: z.number().int().nonnegative(),
  answer: questionAnswerSchema,
});

/** Answer to a `plan_approval` entry: one of its `options[].id`. */
export const planResponseMessageSchema = z.object({
  ...versionFields,
  type: z.literal('plan-response'),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  optionId: z.string().min(1),
});

/** Change a session option. `value` must be one the session's agent
 *  advertises (a mode / effort id, or a model id). */
export const setOptionMessageSchema = z.object({
  ...versionFields,
  type: z.literal('set-option'),
  sessionId: z.string().min(1),
  option: sessionOptionSchema,
  value: z.string().min(1),
});

// --- Transcript sync ---

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

/** Phone → bridge: acknowledges one delivered sync chunk. */
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
  /** The agent descriptor id to run on. */
  agent: z.string().min(1),
  /** Initial mode / effort (ids the agent advertises); absent = its default. */
  mode: z.string().optional(),
  effort: z.string().optional(),
  model: z.string().optional(),
  /** Attach on-device test MCP tools (adb) — test sessions only. */
  testSession: z.boolean().optional(),
  /** Working directory, absolute or relative to a workspace root. Confined
   *  bridge-side to the workspace roots. */
  cwd: z.string().optional(),
  /** Create `cwd` (and `git init` it) when it doesn't exist yet. */
  createCwd: z.boolean().optional(),
  /** Custom provider profile; only for agents with `supports.providers`. */
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

// --- Folder management ---

/** Create a new project folder under a workspace root and `git init` it.
 *  Answered with `folder-ack`; the next heartbeat carries the new `folders[]`. */
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

/** Chunked upload (pre-Blossom fallback). */
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

/** Ask for an agent's live model list (agents with `supports.models`). */
export const modelsRequestMessageSchema = z.object({
  ...versionFields,
  type: z.literal('models-request'),
  agent: z.string().min(1),
});

// --- Credentials / device config / pairing ---

/** Store or clear credentials. `agent` names the agent they belong to; absent
 *  = the bridge's own credentials (e.g. a GitHub token). `values` maps
 *  credential ids (from the advertised `credentials`) to a new secret, or
 *  `null` to clear; ids not listed are left unchanged. The only message a
 *  credential secret ever rides. */
export const setCredentialsMessageSchema = z.object({
  ...versionFields,
  type: z.literal('set-credentials'),
  agent: z.string().min(1).optional(),
  values: credentialValuesSchema,
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

/** Upsert or delete one provider profile stored bridge-side. `profile: null`
 *  deletes the whole profile. Answered with `provider-profile-ack`; the bridge
 *  then broadcasts a fresh redacted `provider-profiles` list. */
export const setProviderProfileMessageSchema = z.object({
  ...versionFields,
  type: z.literal('set-provider-profile'),
  profileId: z.string().min(1),
  profile: z
    .object({
      label: z.string().min(1),
      /** CDX-071: https, or http ONLY on loopback — validated on the way out
       *  too, so a cleartext profile fails at the sender. */
      baseUrl: providerBaseUrlSchema,
      /** Tri-state secret: undefined = keep the stored token, null = delete
       *  it, string = set it. The ONLY message the token ever rides on. */
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
  permissionResponseMessageSchema,
  questionResponseMessageSchema,
  planResponseMessageSchema,
  setOptionMessageSchema,
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
export type PermissionResponseMessage = z.infer<typeof permissionResponseMessageSchema>;
export type QuestionResponseMessage = z.infer<typeof questionResponseMessageSchema>;
export type PlanResponseMessage = z.infer<typeof planResponseMessageSchema>;
export type SetOptionMessage = z.infer<typeof setOptionMessageSchema>;
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
