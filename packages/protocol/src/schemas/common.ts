/**
 * Shared wire building blocks — v11 mirror of `crates/protocol/src/common.rs`,
 * which is authoritative. v11 is agent-neutral: what an agent can do is DATA
 * the bridge advertises per agent (`agentDescriptorSchema`), and a transcript
 * entry is a typed `entryType` variant rather than a loose metadata record.
 * An unknown enum value is a decode error; unknown extra fields are stripped.
 */
import { z } from 'zod';

// --- agents ---

/** One selectable value of a per-agent option (a mode, an effort level, a
 *  plan-approval choice). `id` rides the wire; `label` is for display. */
export const optionChoiceSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
});
export type OptionChoice = z.infer<typeof optionChoiceSchema>;

/** Optional features an agent supports. A client offers a feature only when
 *  the session's agent advertises it. */
export const agentSupportsSchema = z.object({
  /** `models-request` returns a live model list for this agent. */
  models: z.boolean().default(false),
  /** `usage-request` returns subscription usage for this agent's sessions. */
  usage: z.boolean().default(false),
  /** Sessions may be bound to a custom provider profile (`providerId`). */
  providers: z.boolean().default(false),
  /** `gsd-request` returns GSD workflow state for this agent's sessions. */
  gsd: z.boolean().default(false),
  /** `interrupt` stops the running turn. */
  interrupt: z.boolean().default(false),
});
export type AgentSupports = z.infer<typeof agentSupportsSchema>;

/** A credential the bridge holds for an agent (or for itself), by id. The
 *  secret never rides bridge→phone; only whether it is set. */
export const credentialStatusSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** Set — by the phone or by the bridge's own environment. */
  present: z.boolean(),
  /** Present only because the bridge's environment provides it (the phone
   *  cannot clear it). */
  fromEnv: z.boolean().optional(),
  /** The bridge checked the stored value against the provider; absent when
   *  it was not checked. */
  valid: z.boolean().optional(),
});
export type CredentialStatus = z.infer<typeof credentialStatusSchema>;

/** An agent backend a bridge can run sessions on, advertised in the session
 *  list heartbeat. Clients build their pickers from this. */
export const agentDescriptorSchema = z.object({
  /** Stable id, e.g. `claude-code`, `opencode`. */
  id: z.string().min(1),
  displayName: z.string(),
  /** Permission / operating modes, in picker order. Empty = no switchable mode. */
  modes: z.array(optionChoiceSchema).default([]),
  /** Reasoning-effort levels, in picker order. Empty = not configurable. */
  efforts: z.array(optionChoiceSchema).default([]),
  defaultMode: z.string().optional(),
  supports: agentSupportsSchema.default({}),
  /** Credentials this agent can use, with their current status. */
  credentials: z.array(credentialStatusSchema).default([]),
});
export type AgentDescriptor = z.infer<typeof agentDescriptorSchema>;

// --- sessions ---

export const sessionStateSchema = z.enum([
  'idle',
  'running',
  'waiting_permission',
  'waiting_question',
  /** Set on every session when the bridge shuts down cleanly. */
  'offline',
]);
export type SessionState = z.infer<typeof sessionStateSchema>;

/** The per-session options `set-option` changes and `option-confirmed`
 *  reports. Values are agent-defined strings (see `agentDescriptorSchema`). */
export const sessionOptionSchema = z.enum(['mode', 'effort', 'model']);
export type SessionOption = z.infer<typeof sessionOptionSchema>;

export const remoteSessionInfoSchema = z.object({
  id: z.string().min(1),
  /** The agent descriptor id this session runs on. */
  agent: z.string().min(1),
  slug: z.string(),
  cwd: z.string(),
  lastActivity: z.string(),
  lineCount: z.number().int().nonnegative(),
  title: z.string().nullable(),
  project: z.string(),
  mode: z.string().optional(),
  effort: z.string().optional(),
  model: z.string().optional(),
  /** Real context-window size (tokens). */
  contextWindow: z.number().int().nonnegative().optional(),
  /** Context usage, 0–100. */
  contextPercentage: z.number().optional(),
  committed: z.boolean().optional(),
  state: sessionStateSchema.optional(),
  /** Highest transcript seq the bridge has persisted for this session. */
  seqHigh: z.number().int().nonnegative().optional(),
  /** Bound custom provider profile (absent = the agent's own provider). */
  providerId: z.string().optional(),
  providerLabel: z.string().optional(),
});
export type RemoteSessionInfo = z.infer<typeof remoteSessionInfoSchema>;

// --- Custom AI provider profiles (CDX-062) ---

/** One model offered by a custom provider profile. */
export const providerModelSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
});
export type ProviderModel = z.infer<typeof providerModelSchema>;

/**
 * CDX-071: hostnames for which plain `http://` is still accepted as a provider
 * base URL. A local model server listens on loopback and has no certificate,
 * and its traffic never leaves the machine. Anything else is a network hop
 * carrying the profile's bearer token, so it MUST be TLS.
 *
 * Loopback ONLY, matched exactly: `0.0.0.0` is a bind address, not a
 * destination, and a name like `evil.localhost` resolves wherever its DNS
 * says. `new URL()` reports IPv6 hosts bracketed, hence both `::1` forms.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** The message BOTH ends show when a base URL is rejected. */
export const PROVIDER_BASE_URL_ERROR =
  'Base URL must be https:// (http:// is allowed only for localhost, 127.0.0.1 or [::1])';

/** Is `raw` an acceptable custom-provider base URL? https anywhere, http only
 *  on loopback. */
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

/** The REDACTED wire shape of a stored provider profile (`hasToken` only — the
 *  token never rides bridge→phone). `baseUrl` stays a bare non-empty string on
 *  read so a profile stored before the https rule is still listable (and
 *  fixable); the rule is a WRITE gate. */
export const providerProfileInfoSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  baseUrl: z.string().min(1),
  models: z.array(providerModelSchema),
  defaultModel: z.string().optional(),
  hasToken: z.boolean(),
});
export type ProviderProfileInfo = z.infer<typeof providerProfileInfoSchema>;

// --- transcript entries ---

/** One rendered diff line. */
export const diffLineSchema = z.object({
  type: z.enum(['add', 'del', 'context']),
  text: z.string(),
});
export type DiffLine = z.infer<typeof diffLineSchema>;

/** Who wrote a text entry. */
export const roleSchema = z.enum(['user', 'agent']);
export type Role = z.infer<typeof roleSchema>;

/** What a tool call does, normalized across agents (the Agent Client
 *  Protocol's tool kinds). Clients branch on this, not on tool names. */
export const toolKindSchema = z.enum([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]);
export type ToolKind = z.infer<typeof toolKindSchema>;

/** What choosing a permission option does — lets a client style and order the
 *  choices without knowing the agent. */
export const permissionOptionKindSchema = z.enum([
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
]);
export type PermissionOptionKind = z.infer<typeof permissionOptionKindSchema>;

export const permissionOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: permissionOptionKindSchema,
});
export type PermissionOption = z.infer<typeof permissionOptionSchema>;

export const questionOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
});
export type QuestionOption = z.infer<typeof questionOptionSchema>;

/** Session lifecycle notices a client shows as a marker line. */
export const noticeKindSchema = z.enum([
  'session_restart',
  'session_died',
  'session_failed',
  'auth_error',
  'screenshot',
]);
export type NoticeKind = z.infer<typeof noticeKindSchema>;

/** Identifies the sub-agent that produced an entry. */
export const subagentSchema = z.object({
  label: z.string().optional(),
});
export type Subagent = z.infer<typeof subagentSchema>;

/** Fields every entry carries alongside its typed body. */
const entryEnvelope = {
  timestamp: z.string(),
  /** Set when a sub-agent (not the session's main agent) produced it. */
  subagent: subagentSchema.optional(),
  /** Agent-specific data no client depends on — the one sanctioned escape
   *  hatch; anything a client renders belongs in a typed field instead. */
  agentExtras: z.unknown().optional(),
};

/** One transcript entry, tagged by `entryType`. */
export const outputEntrySchema = z.discriminatedUnion('entryType', [
  /** Conversation text. Agent text written alongside tool calls may set
   *  `collapsible`, letting a client fold it into the tool group. */
  z.object({
    ...entryEnvelope,
    entryType: z.literal('text'),
    role: roleSchema,
    text: z.string(),
    collapsible: z.boolean().optional(),
  }),
  /** A plan the agent proposes (rendered as markdown, never collapsed). */
  z.object({ ...entryEnvelope, entryType: z.literal('plan'), text: z.string() }),
  /** Model reasoning. `redacted` = the provider withheld the content. */
  z.object({
    ...entryEnvelope,
    entryType: z.literal('thinking'),
    text: z.string(),
    redacted: z.boolean().optional(),
  }),
  z.object({
    ...entryEnvelope,
    entryType: z.literal('tool_call'),
    callId: z.string(),
    /** The agent's own tool name (display only — clients branch on `kind`). */
    toolName: z.string(),
    kind: toolKindSchema,
    /** One-line human summary, e.g. `npm test` or `src/main.rs`. */
    title: z.string(),
    /** Files or paths the call touches. */
    locations: z.array(z.string()).optional(),
    /** The agent's raw tool input, for detailed rendering. */
    rawInput: z.unknown().optional(),
  }),
  z.object({
    ...entryEnvelope,
    entryType: z.literal('tool_result'),
    callId: z.string(),
    text: z.string(),
    isError: z.boolean().optional(),
  }),
  /** A file change, as add/del/context lines. */
  z.object({
    ...entryEnvelope,
    entryType: z.literal('diff'),
    path: z.string(),
    lines: z.array(diffLineSchema),
    truncated: z.boolean().optional(),
    callId: z.string().optional(),
  }),
  /** The agent is waiting for the user to allow or deny a tool call. Answered
   *  with `permission-response` using one of `options`. */
  z.object({
    ...entryEnvelope,
    entryType: z.literal('permission_request'),
    requestId: z.string(),
    toolName: z.string(),
    kind: toolKindSchema,
    title: z.string(),
    description: z.string().optional(),
    locations: z.array(z.string()).optional(),
    rawInput: z.unknown().optional(),
    options: z.array(permissionOptionSchema),
  }),
  /** One question of a (possibly multi-question) ask, all sharing
   *  `requestId`. Answered with `question-response`. */
  z.object({
    ...entryEnvelope,
    entryType: z.literal('question'),
    requestId: z.string(),
    index: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
    header: z.string().optional(),
    question: z.string(),
    options: z.array(questionOptionSchema).default([]),
    multiSelect: z.boolean().optional(),
  }),
  /** The agent finished planning and asks how to proceed. Answered with
   *  `plan-response` using one of `options`. */
  z.object({
    ...entryEnvelope,
    entryType: z.literal('plan_approval'),
    requestId: z.string(),
    options: z.array(optionChoiceSchema),
  }),
  /** A permission request, question or plan approval was answered (or
   *  cancelled); `summary` is a short human description of the outcome. */
  z.object({
    ...entryEnvelope,
    entryType: z.literal('resolved'),
    requestId: z.string(),
    summary: z.string(),
  }),
  z.object({ ...entryEnvelope, entryType: z.literal('notice'), kind: noticeKindSchema, text: z.string() }),
  /** A one-line status message from the bridge or agent. */
  z.object({ ...entryEnvelope, entryType: z.literal('status'), text: z.string() }),
  z.object({ ...entryEnvelope, entryType: z.literal('error'), text: z.string() }),
  /** The agent's turn ended; it is waiting for input. */
  z.object({ ...entryEnvelope, entryType: z.literal('turn_complete') }),
]);
export type OutputEntry = z.infer<typeof outputEntrySchema>;
export type EntryType = OutputEntry['entryType'];
/** The entry variant with the given `entryType`. */
export type EntryOf<T extends EntryType> = Extract<OutputEntry, { entryType: T }>;

// --- usage ---

export const usageWindowSchema = z.object({
  /** e.g. "5h", "7d", "7d Opus". */
  label: z.string(),
  /** 0–100. */
  utilization: z.number().nullable().optional(),
  resetsAt: z.string().nullable().optional(),
});
export type UsageWindow = z.infer<typeof usageWindowSchema>;

export const usageDataSchema = z.object({
  available: z.boolean(),
  /** Subscription / plan name, when the agent's provider reports one. */
  plan: z.string().optional(),
  windows: z.array(usageWindowSchema).default([]),
  sessionCostUsd: z.number().optional(),
  fetchedAt: z.string(),
});
export type UsageData = z.infer<typeof usageDataSchema>;

/** Credential writes by id: a string sets it, `null` clears it, an absent id
 *  is left unchanged. */
export const credentialValuesSchema = z.record(z.string().nullable());
export type CredentialValues = z.infer<typeof credentialValuesSchema>;

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
   *  is available (CDX-028). Pairs with `netid`. */
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
