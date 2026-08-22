import { z } from 'zod';

/** Permission mode of a session. `bypassPermissions` is intentionally absent —
 *  the bridge coerces it to `default` (matches the old behaviour). */
export const permissionModeSchema = z.enum(['default', 'acceptEdits', 'plan']);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

export const effortLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'auto']);
export type EffortLevel = z.infer<typeof effortLevelSchema>;

export const sessionStateSchema = z.enum([
  'idle',
  'running',
  'waiting_permission',
  'waiting_question',
  /** v10: set on every session when the bridge shuts down cleanly — replaces the
   *  old empty-list-on-deactivate, which the phone couldn't distinguish from
   *  "your sessions are gone". */
  'offline',
]);
export type SessionState = z.infer<typeof sessionStateSchema>;

export const remoteSessionInfoSchema = z.object({
  id: z.string().min(1),
  slug: z.string(),
  cwd: z.string(),
  lastActivity: z.string(),
  lineCount: z.number().int().nonnegative(),
  title: z.string().nullable(),
  project: z.string(),
  permissionMode: permissionModeSchema.optional(),
  effortLevel: effortLevelSchema.optional(),
  model: z.string().optional(),
  /** Real context-window size (tokens) resolved by the SDK. */
  contextWindow: z.number().int().positive().optional(),
  /** SDK-authoritative context usage, 0–100. */
  contextPercentage: z.number().min(0).max(100).optional(),
  committed: z.boolean().optional(),
  state: sessionStateSchema.optional(),
  /** v10: highest transcript seq the bridge has persisted for this session.
   *  The phone compares against its local haveRanges to decide whether a sync
   *  is needed — no blind full-history refetches. */
  seqHigh: z.number().int().nonnegative().optional(),
  /** CDX-062: id of the custom provider profile this session was bound to at
   *  creation (absent = Anthropic). */
  providerId: z.string().optional(),
  /** CDX-062: human-readable provider label, resolved bridge-side at publish
   *  time — so the display name survives even after the profile is deleted. */
  providerLabel: z.string().optional(),
});
export type RemoteSessionInfo = z.infer<typeof remoteSessionInfoSchema>;

export const authStatusSchema = z.object({
  hasAnthropicKey: z.boolean(),
  hasGithubPat: z.boolean(),
  hasEnvKey: z.boolean(),
});
export type AuthStatus = z.infer<typeof authStatusSchema>;

// --- Custom AI provider profiles (CDX-062) ---

/** One model offered by a custom provider profile (same shape as the `models`
 *  message entries). */
export const providerModelSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
});
export type ProviderModel = z.infer<typeof providerModelSchema>;

/**
 * CDX-071: hostnames for which plain `http://` is still accepted as a provider
 * base URL. A local model server (Ollama, LM Studio, llama.cpp) listens on
 * loopback and has no certificate, so demanding TLS there would ban a real and
 * entirely safe use case — traffic never leaves the machine. Anything else is
 * a network hop, and the profile's auth token rides it as
 * `Authorization: Bearer <token>`, so it MUST be TLS.
 *
 * Loopback ONLY, matched exactly: `0.0.0.0` is a bind address, not a
 * destination, and a name like `evil.localhost` resolves wherever its DNS
 * says. `new URL()` reports IPv6 hosts bracketed, hence both `::1` forms.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** The message BOTH ends show when a base URL is rejected. Exported so the
 *  phone's own pre-send validation can render the identical sentence. */
export const PROVIDER_BASE_URL_ERROR =
  'Base URL must be https:// (http:// is allowed only for localhost, 127.0.0.1 or [::1])';

/**
 * Is `raw` an acceptable custom-provider base URL? Exported as a plain
 * predicate so the phone can gate its Save button on exactly the rule the wire
 * enforces, instead of re-deriving a looser one (pre-CDX-071 the phone only
 * checked "non-empty", and an `http://` profile put the operator's provider
 * token on the wire in cleartext from every session AND from the bridge's
 * token-validation POST).
 */
export function isValidProviderBaseUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

/** A custom provider's API base. See isValidProviderBaseUrl for the rule. */
export const providerBaseUrlSchema = z
  .string()
  .min(1)
  .refine(isValidProviderBaseUrl, { message: PROVIDER_BASE_URL_ERROR });

/** The REDACTED wire shape of a stored provider profile (what `provider-profiles`
 *  carries). The auth token NEVER rides the wire bridge→phone — the phone only
 *  learns `hasToken`; the secret itself stays in the bridge host's storage.
 *
 *  CDX-071: `baseUrl` stays a bare non-empty string HERE on purpose. The
 *  https rule is a WRITE gate (set-provider-profile, below) — a profile
 *  stored before that gate existed must still be listed on the phone so the
 *  operator can see it and fix or delete it. Tightening the read echo too
 *  would make the bridge unable to publish its own stored list, hiding the
 *  very profile that needs fixing. */
export const providerProfileInfoSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  baseUrl: z.string().min(1),
  models: z.array(providerModelSchema).min(1),
  defaultModel: z.string().optional(),
  hasToken: z.boolean(),
});
export type ProviderProfileInfo = z.infer<typeof providerProfileInfoSchema>;

export const outputEntryTypeSchema = z.enum([
  'text',
  'tool_use',
  'tool_result',
  'system',
  'error',
  'progress',
  /** Extended-thinking block from the model — rendered collapsed on the phone
   *  (was silently dropped pre-CDX; the 3c UI noted the gap). */
  'thinking',
  /** CDX-050: a file-edit diff card (Edit/Write/MultiEdit tool input rendered
   *  as colored +/− lines). Carries the structured payload in `diff`; emission
   *  is gated on the phone-side 'diff' capability (see capabilities.ts) —
   *  pre-CDX-050 phones reject the unknown entryType wholesale. */
  'diff',
]);
export type OutputEntryType = z.infer<typeof outputEntryTypeSchema>;

/** One rendered diff line. 'add' → green +, 'del' → red −, 'context' →
 *  unchanged/separator line (muted). */
export const diffLineSchema = z.object({
  type: z.enum(['add', 'del', 'context']),
  text: z.string(),
});
export type DiffLine = z.infer<typeof diffLineSchema>;

/** Structured payload of an entryType 'diff' entry (CDX-050). Kept flat and
 *  small — a lines array, not full unified-diff hunks: it is derived from the
 *  Edit/Write tool INPUT (old_string/new_string/content), which has no line
 *  numbers to anchor real hunk headers to. */
export const diffDataSchema = z.object({
  /** File path as the tool saw it (absolute or repo-relative). */
  path: z.string().min(1),
  lines: z.array(diffLineSchema),
  /** True when the edit was larger than the wire cap and lines were dropped. */
  truncated: z.boolean().optional(),
});
export type DiffData = z.infer<typeof diffDataSchema>;

export const outputEntrySchema = z.object({
  entryType: outputEntryTypeSchema,
  content: z.string(),
  timestamp: z.string(),
  metadata: z.record(z.unknown()).optional(),
  /** Present iff entryType === 'diff' — the structured diff payload. `content`
   *  then carries a plain-text +/− fallback rendering of the same lines. */
  diff: diffDataSchema.optional(),
});
export type OutputEntry = z.infer<typeof outputEntrySchema>;

/** A single claude.ai plan rate-limit window. */
export const usageWindowSchema = z.object({
  utilization: z.number().nullable(),
  resetsAt: z.string().nullable(),
});
export type UsageWindow = z.infer<typeof usageWindowSchema>;

export const usageDataSchema = z.object({
  available: z.boolean(),
  subscriptionType: z.string().nullable(),
  fiveHour: usageWindowSchema.optional(),
  sevenDay: usageWindowSchema.optional(),
  sevenDayOpus: usageWindowSchema.optional(),
  sevenDaySonnet: usageWindowSchema.optional(),
  sessionCostUsd: z.number().optional(),
  fetchedAt: z.string(),
});
export type UsageData = z.infer<typeof usageDataSchema>;

// --- GSD workflow state ---

export const gsdPhaseSchema = z.object({
  number: z.string(),
  name: z.string(),
  diskStatus: z.string(),
  plans: z.number().int().nonnegative(),
  summaries: z.number().int().nonnegative(),
  recentlyTouched: z.boolean(),
  action: z.string().nullable(),
  command: z.string().nullable(),
  planCount: z.number().int().nullable(),
  needsYou: z.number().int().nullable(),
});
export type GsdPhase = z.infer<typeof gsdPhaseSchema>;

export const gsdExecutionSchema = z.object({
  phase: z.string(),
  plansTotal: z.number().int().nonnegative(),
  plansDone: z.number().int().nonnegative(),
  currentPlan: z.string().nullable(),
  tasksDone: z.number().int().nonnegative(),
  tasksTotal: z.number().int().nullable(),
  lastTask: z.string().nullable(),
});
export type GsdExecution = z.infer<typeof gsdExecutionSchema>;

export const gsdActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  command: z.string(),
  recommended: z.boolean(),
});
export type GsdAction = z.infer<typeof gsdActionSchema>;

export const gsdStateSchema = z.object({
  installed: z.boolean(),
  available: z.boolean(),
  hasGit: z.boolean(),
  situation: z.string(),
  summary: z.string(),
  milestone: z.string().nullable(),
  currentPhase: z.string().nullable(),
  totalPhases: z.number().int().nullable(),
  percent: z.number(),
  phases: z.array(gsdPhaseSchema),
  actions: z.array(gsdActionSchema),
  recommended: z.string().nullable(),
  paused: z.boolean(),
  blockers: z.array(z.string()),
  verifyFailed: z.boolean(),
  execution: gsdExecutionSchema.nullable(),
});
export type GsdState = z.infer<typeof gsdStateSchema>;

// --- Device / mesh config ---

export const deviceConfigSchema = z.object({
  label: z.string(),
  role: z.enum(['controller', 'test-target']).optional(),
  serial: z.string().optional(),
  meshIp: z.string().optional(),
  meshPubkey: z.string().optional(),
  appUnderTest: z.enum(['kubo', 'veil', 'custom']),
  customPackage: z.string().optional(),
  customBuildCmd: z.string().optional(),
  projectDir: z.string().optional(),
});
export type DeviceConfig = z.infer<typeof deviceConfigSchema>;

// --- Pairing (QR payload + stored peer records; not wire messages) ---

export interface PairingInfo {
  npub: string;
  relays: string[];
  machine: string;
  token?: string;
  /** Mesh admin device id (npub) for nvpn's manual-join flow, when the mesh
   *  is available (CDX-028: replaces the removed `nvpn://invite/...` bearer
   *  invite). Pairs with `netid`. */
  meshAdmin?: string;
  /** Active mesh network id. */
  netid?: string;
}

export interface PairedPhone {
  npub: string;
  pubkeyHex: string;
  label: string;
  pairedAt: string;
}
