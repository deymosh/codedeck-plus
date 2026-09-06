/**
 * BridgeCore — the headless bridge orchestrator.
 *
 * Wires everything the previous phases built into one engine (the shape is
 * ported from the old bridge's core.ts, the plumbing is the rebuild):
 *
 *   phone ──relay──> BridgePool → CommandIngest → BridgeCore ─┬→ SessionRunner → SdkFacade
 *                                                             ├→ SessionRegistry / TranscriptStore
 *                                                             ├→ SyncServer
 *                                                             └→ workspace/folders
 *   SessionRunner events → BridgeCore → Publisher ──relay──> phone
 *
 * Key guarantees:
 * - On start: registry loads from disk and every persisted session is resumed
 *   (resume-on-boot) — a bridge restart no longer forgets sessions.
 * - The 30515 heartbeat always carries the full session list + capabilities +
 *   folders; it is republished on changes and on an interval.
 * - Graceful shutdown publishes the session list with every session
 *   `state:'offline'` and `machineOffline:true` — NEVER an empty list (the old
 *   empty-list-on-deactivate was a data-loss vector on the phone).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Filter } from 'nostr-tools/filter';
import type { NostrEvent } from 'nostr-tools/core';
import {
  ALL_BRIDGE_CAPABILITIES,
  CAPABILITIES,
  createRelayAuthSigner,
  isValidProviderBaseUrl,
  PROTOCOL_VERSION,
  PROVIDER_BASE_URL_ERROR,
  type CreateFolderMessage,
  type CreateSessionMessage,
  type PairedPhone,
  type PairRequestMessage,
  type ProviderModel,
  type ProviderProfileInfo,
  type RemoteSessionInfo,
  type SessionListMessage,
  type SetCredentialsMessage,
  type SetDeviceConfigMessage,
  type SetProviderProfileMessage,
} from '@codedeck/protocol';
import type { BridgeHost, PairingHandle } from './host';
import { keypairFromSecret, npubFromHex, type Keypair } from './nostr/crypto';
import {
  BridgePool,
  type BridgePoolCallbacks,
  type BridgePoolOptions,
  type ConnectionStatus,
  type SubscriptionHandle,
} from './nostr/pool';
import { Publisher } from './nostr/publisher';
import { createTorWebSocket } from './nostr/transport';
import {
  buildCommandsFilter,
  buildPairingFilter,
  sinceForConnect,
  CommandIngest,
  type CommandHandlers,
} from './nostr/ingest';
import { buildPairingUrl, DEFAULT_PAIRING_WINDOW_MS } from './pairing';
import { TranscriptStore } from './session/transcript';
import { SessionRegistry } from './session/registry';
import { PermissionBroker, type PermissionCard } from './session/permissions';
import { SessionRunner, type SessionRunnerEvents } from './session/runner';
import { SyncServer, type SyncTimers } from './sync/server';
import type { SdkFacade } from './sdk/facade';
import {
  createProjectFolder,
  listAllWorkspaceFolders,
  resolveSessionCwdMulti,
} from './workspace/folders';
import { getGsdState, type GsdStateProvider } from './workspace/gsdState';
import { ImageUploadHandler } from './images';
import { createMeshAdmin, type MeshAdmin } from './mesh/meshAdmin';
import { createDeviceActions, type DeviceActions } from './mesh/deviceActions';
import { createDeviceMcpServer } from './mesh/deviceMcp';
import { buildScreenshotEntry } from './mesh/screenshotDelivery';
import { registerPhoneOnRelay } from './relayAdmin';

/** The slice of BridgePool the orchestrator uses — injectable for tests. */
export interface BridgeCorePool {
  connect(): void;
  dispose(): void;
  resubscribe(): void;
  publish(event: NostrEvent): Promise<string>[];
  readonly relays: readonly string[];
  notePublishSuccess?(): void;
  /**
   * Open an extra, caller-owned subscription (the authorless pairing-window
   * filter). Optional so minimal test pools still typecheck; pairing requires
   * it (openPairingWindow throws otherwise). The real BridgePool has it.
   */
  openSubscription?(
    filter: Filter,
    params: {
      onevent: (event: NostrEvent) => void;
      oneose?: () => void;
      onclose?: (reasons: unknown) => void;
    },
  ): SubscriptionHandle;
}

export type PoolFactory = (
  options: BridgePoolOptions,
  callbacks: BridgePoolCallbacks,
) => BridgeCorePool;

const STORAGE_KEY_PAIRED_PHONES = 'pairedPhones';
const STORAGE_KEY_LAST_SEEN = 'lastSeenTimestamp';
const STORAGE_KEY_PROCESSED_IDS = 'processedEventIds';
/** Host-storage key for phone-set credentials. Values are secrets: stored,
 *  never logged, never echoed back over the wire. */
const STORAGE_KEY_CREDENTIALS = 'credentials';
/** Host-storage key for phone-managed custom AI provider profiles (CDX-062).
 *  `authToken` values are secrets: stored, never logged, never echoed back
 *  over the wire (the phone only ever learns `hasToken`). Hosts must route
 *  this key to secret storage (VSCode keychain / 0600 state.json). */
const STORAGE_KEY_PROVIDER_PROFILES = 'providerProfiles';
/** Per-phone device config prefix (`deviceConfig.<phonePubkeyHex>`). */
const STORAGE_KEY_DEVICE_CONFIG_PREFIX = 'deviceConfig.';

/** How often the 30515 heartbeat republishes even with no changes. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

/** How often session `committed` flags are reconciled with real git state
 *  (catches manual commits made in a terminal; agent commits hit the runner's
 *  fast path). Ported cadence. */
export const DEFAULT_GIT_POLL_INTERVAL_MS = 10_000;

/** CDX-013 retention: per-session transcript entry cap enforced by the sweep
 *  (config `transcriptKeepLast`; 0 disables). 5000 entries ≈ several days of
 *  heavy use per session, well beyond what the phone renders. */
export const DEFAULT_TRANSCRIPT_KEEP_LAST = 5000;

/** CDX-013 retention: sweep interval (boot sweep always runs). */
export const DEFAULT_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface StoredCredentials {
  anthropicApiKey?: string;
  githubPat?: string;
  updatedAt?: string;
}

/**
 * One stored custom AI provider profile (CDX-062, D1): phone-managed,
 * bridge-stored under STORAGE_KEY_PROVIDER_PROFILES as `{profiles: [...]}`.
 * `authToken` is a SECRET — never logged, never on the wire bridge→phone.
 */
export interface ProviderProfile {
  id: string;
  label: string;
  /** Anthropic-compatible API base, e.g. `https://api.moonshot.ai/anthropic`. */
  baseUrl: string;
  /** The provider's API token. Absent = stored without a token (sessions
   *  cannot spawn on it until one is set). SECRET: never log. */
  authToken?: string;
  models: ProviderModel[];
  defaultModel?: string;
  updatedAt?: string;
}

/** The on-disk shape under STORAGE_KEY_PROVIDER_PROFILES. */
interface StoredProviderProfiles {
  profiles: ProviderProfile[];
}

/**
 * Build the Claude Code subprocess environment from phone-set credentials
 * (ported from the old standalone bridge's buildSessionEnv, CDX-011 closing
 * the CDX-005 deferral). Returns undefined when no credential is stored — the
 * subprocess then simply inherits process.env (no behavior change). When
 * anything IS stored, the base env is spread first (the SDK REPLACES the env
 * wholesale) and:
 * - ANTHROPIC_API_KEY: env wins over stored (same precedence as the ack's
 *   `hasAnthropicKey` — the bridge operator's env key is authoritative);
 * - GITHUB_TOKEN: stored PAT wins (that's the point of setting it).
 * Secrets: the returned object must NEVER be logged.
 */
export function sessionEnvFromCredentials(
  stored: { anthropicApiKey?: string; githubPat?: string },
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string> | undefined {
  if (!stored.anthropicApiKey && !stored.githubPat) return undefined;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) env[key] = value;
  }
  const apiKey = baseEnv.ANTHROPIC_API_KEY || stored.anthropicApiKey;
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
  if (stored.githubPat) env.GITHUB_TOKEN = stored.githubPat;
  return env;
}

/**
 * CDX-071: the env-name namespaces the Claude Code CLI (and the cloud SDKs it
 * embeds) use to pick an API backend, carry a credential, or override a model.
 * A provider-bound session inherits NOTHING from these — see
 * sanitizeProviderBaseEnv.
 *
 * Prefixes, not names, because names are unbounded: the installed SDK 0.3.222
 * bundle registers **558** distinct vars under these prefixes, and its own
 * internal inventories (the arrays it uses for provider selection, base URLs,
 * credentials and model overrides) already list `CLAUDE_CODE_USE_MANTLE`,
 * `CLAUDE_CODE_USE_GATEWAY`, `CLAUDE_CODE_USE_ANTHROPIC_AWS`,
 * `ANTHROPIC_UNIX_SOCKET`, `ANTHROPIC_FOUNDRY_AUTH_TOKEN`,
 * `AWS_BEARER_TOKEN_BEDROCK`, `CLAUDE_CODE_HFI_BEARER_TOKEN` … none of which
 * appear in any published table. Every CLI release adds more. A denylist over
 * that namespace is a list we would lose track of on the next upgrade; a
 * prefix drop is the same list inverted, and a NEW routing var added upstream
 * is dropped by default instead of silently honoured.
 */
const VENDOR_ENV_PREFIXES = [
  'ANTHROPIC_',
  'CLAUDE_',
  'AWS_',
  'AZURE_',
  'BEDROCK_',
  'CLOUDSDK_',
  'GCLOUD_',
  'GOOGLE_',
  'VERTEX_',
] as const;

/**
 * Routing/credential vars that carry no vendor prefix. `CLOUD_ML_REGION` is
 * the proof that the prefix rule alone is not enough: it is a *Google Cloud*
 * name, and the CLI lists it in the same internal array as
 * `CLAUDE_CODE_USE_VERTEX` — i.e. it participates in choosing the backend.
 */
const VENDOR_ENV_EXACT = new Set(['CLOUD_ML_REGION', 'USE_LOCAL_OAUTH', 'USE_STAGING_OAUTH']);

/**
 * The allowlist *inside* the vendor namespace: deliberately tiny, and every
 * entry is location-, shell- or privacy-shaped — never routing, never a
 * credential, never a model id.
 *
 * - CLAUDE_CONFIG_DIR: the operator's CLI config/state root (settings.json,
 *   projects, prompt history, MCP config). Dropping it silently relocates the
 *   session to `~/.claude` — a functional break — and buys nothing: the
 *   credentials file it also holds is equally reachable at the default path.
 * - CLAUDE_CODE_SHELL / CLAUDE_CODE_GIT_BASH_PATH: which shell the Bash tool
 *   runs. Dropping the Windows one leaves the CLI with no shell at all.
 * - CLAUDE_CODE_TMPDIR: scratch location, often the only writable dir on a
 *   locked-down box.
 * - CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: a privacy switch. Dropping it
 *   turns traffic the operator switched OFF back on — the one direction where
 *   "fall back to the CLI default" is the wrong default.
 *
 * Deliberately NOT kept: CLAUDE_CODE_MAX_OUTPUT_TOKENS and friends (a
 * Claude-tuned cap is not obviously right at a third-party provider, and the
 * CLI default applies), and CLAUDE_CODE_CLIENT_CERT / CLIENT_KEY /
 * KEY_PASSPHRASE / CERT_STORE — an mTLS client certificate is an IDENTITY, and
 * offering the operator's to an arbitrary third-party host is exactly the
 * class of leak this function exists to stop. If someone's own gateway needs
 * mTLS, that belongs in the profile, not in ambient env.
 */
const VENDOR_ENV_KEEP = new Set([
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_SHELL',
  'CLAUDE_CODE_GIT_BASH_PATH',
  'CLAUDE_CODE_TMPDIR',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
]);

/**
 * CDX-071: the base environment for a session bound to a CUSTOM provider —
 * everything inherited EXCEPT the vendor routing/credential namespace.
 *
 * Why this exists (the pre-fix bug): CDX-062 spread all of `process.env` and
 * deleted two names. Claude Code's documented auth precedence puts cloud
 * provider credentials ABOVE `ANTHROPIC_AUTH_TOKEN`, so an operator with
 * `CLAUDE_CODE_USE_BEDROCK=1` exported got a "Kimi" session that silently ran
 * on Bedrock and billed their AWS account, with `ANTHROPIC_BASE_URL` ignored
 * and no error anywhere. And `ANTHROPIC_CUSTOM_HEADERS` — where LLM-gateway
 * users keep a gateway credential or tenant key — was forwarded verbatim, as
 * HTTP headers, to whatever third-party host the profile named.
 *
 * NOT scrubbed, on purpose: everything outside the namespace. PATH, HOME,
 * SHELL, TERM, LANG/LC_*, TMPDIR, XDG_*, SSH_AUTH_SOCK, HTTP(S)_PROXY,
 * NO_PROXY, ALL_PROXY, NODE_EXTRA_CA_CERTS, NODE_OPTIONS,
 * NODE_TLS_REJECT_UNAUTHORIZED, GITHUB_TOKEN and every unrelated toolchain var
 * survive untouched — a session that cannot resolve a hostname or find `git`
 * is not more secure, and the proxy/CA settings are the operator's network
 * reality, applied identically on the Anthropic path today.
 *
 * Known, accepted cost: `aws` / `gcloud` invoked from the Bash tool inside a
 * provider-bound session loses AWS_PROFILE / AWS_REGION / credentials and
 * GOOGLE_APPLICATION_CREDENTIALS. That is the conservative direction — a
 * failing `aws` command is visible in the transcript within seconds, whereas a
 * silently mis-billed Bedrock session is invisible until the invoice.
 */
export function sanitizeProviderBaseEnv(
  baseEnv: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (!VENDOR_ENV_KEEP.has(upper)) {
      if (VENDOR_ENV_EXACT.has(upper)) continue;
      if (VENDOR_ENV_PREFIXES.some((p) => upper.startsWith(p))) continue;
    }
    env[key] = value;
  }
  return env;
}

/**
 * Build the Claude Code subprocess environment for a session, provider-aware
 * (CDX-062, D4). No profile → delegate to sessionEnvFromCredentials (ZERO
 * behavior change for Anthropic sessions — that path is byte-identical to
 * pre-CDX-071). With a profile:
 * - start from sanitizeProviderBaseEnv(baseEnv): the whole vendor
 *   routing/credential namespace is dropped, so no inherited Bedrock/Vertex/
 *   Foundry/gateway flag, base URL, API key, OAuth token, custom header or
 *   model override can outrank or contaminate what we set next;
 * - set ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN from the profile — throws
 *   when the profile has no stored token (the caller fails the spawn loudly;
 *   a silent fallback to the Anthropic key would bill the wrong account), and
 *   throws when the stored baseUrl fails isValidProviderBaseUrl (CDX-071
 *   amendment): the https rule used to live ONLY on the set-provider-profile
 *   decode, so a row written before that gate kept its `http://` base and this
 *   function still handed the subprocess a cleartext destination for
 *   `Authorization: Bearer <token>`. Enforcing it HERE makes the rule an
 *   invariant of the seam the token actually crosses — fresh spawn, restart,
 *   and resume-on-boot alike — instead of a property of how the row was
 *   written. Refusal is loud on purpose: no scheme upgrade (we cannot know the
 *   host serves TLS on the same port/path) and no silent skip;
 * - set the background/haiku-class model = defaultModel ?? models[0] under
 *   BOTH names (CDX-071): `ANTHROPIC_DEFAULT_HAIKU_MODEL` is the current one,
 *   `ANTHROPIC_SMALL_FAST_MODEL` is documented as deprecated in favour of it
 *   but is still read by the installed SDK, so setting both means neither a
 *   CLI upgrade nor a downgrade can silently send background tasks to a Claude
 *   model id the provider does not serve. The Sonnet/Opus/Fable alias
 *   overrides are deliberately left unset: a session binds to one explicit
 *   model id, and remapping the aliases is a behavior change that needs its
 *   own device oracle;
 * - GITHUB_TOKEN stored-wins, unchanged.
 * The returned object contains SECRETS — never log it.
 */
export function buildSessionEnv(
  stored: { anthropicApiKey?: string; githubPat?: string },
  profile?: ProviderProfile,
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string> | undefined {
  if (!profile) return sessionEnvFromCredentials(stored, baseEnv);
  // CDX-071 amendment: checked BEFORE the token, because this is the one that
  // decides whether the token may exist on this wire at all. The baseUrl is
  // NOT a secret (it is already logged and published redacted), so naming it
  // in the message is what makes the failure actionable.
  if (!isValidProviderBaseUrl(profile.baseUrl)) {
    throw new Error(
      `provider profile '${profile.id}' has an insecure base URL (${profile.baseUrl}) — ` +
        `${PROVIDER_BASE_URL_ERROR}. Its API token would travel in cleartext, so the session is refused.`,
    );
  }
  if (!profile.authToken) {
    throw new Error(`provider profile '${profile.id}' has no stored auth token`);
  }
  const env = sanitizeProviderBaseEnv(baseEnv);
  env.ANTHROPIC_BASE_URL = profile.baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = profile.authToken;
  const smallModel = profile.defaultModel ?? profile.models[0]!.id;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = smallModel;
  env.ANTHROPIC_SMALL_FAST_MODEL = smallModel;
  if (stored.githubPat) env.GITHUB_TOKEN = stored.githubPat;
  return env;
}

/** Folder scans cached across session-list publishes (ported): folders change
 *  on the timescale of starting a project, not of a heartbeat. */
const FOLDER_CACHE_TTL_MS = 30_000;

// --- Pairing window types ---

export type PairingCloseReason = 'paired' | 'expired' | 'closed';

export interface PairingWindowOptions {
  /** Window lifetime; default DEFAULT_PAIRING_WINDOW_MS (10 min). */
  durationMs?: number;
  /** One-time token override — injectable for tests. */
  token?: string;
  /** Bundle mesh manual-join info into the QR (host-provided; core stays
   *  mesh-free): the active network id + this machine's admin device id
   *  (npub), both from `meshAdmin.onboardingInfo()`. CDX-028: replaces the
   *  removed nvpn bearer-invite. */
  mesh?: { adminDeviceId: string; netid: string };
  /** Fired after a phone pairs successfully (persisted + acked). */
  onPaired?: (phone: PairedPhone) => void;
  /** Fired exactly once when the window closes, with why. */
  onClosed?: (reason: PairingCloseReason) => void;
}

export interface PairingWindowInfo {
  /** Full pairing URL (QR content). */
  url: string;
  /** Mesh-redacted URL, safe to render as text. */
  displayUrl: string;
  token: string;
  expiresAt: Date;
}

/** CDX-039: how long to wait before re-establishing a pairing subscription the
 *  relays dropped. Matches BridgePool's reconnect floor. */
const PAIRING_RESUBSCRIBE_MS = 2_000;

/** Per-relay publish timeout when routed through torProxyUrl — Tor's circuit
 *  build + extra hops routinely exceed Publisher's 5s direct-connection
 *  default (see Publisher.DEFAULT_RELAY_PUBLISH_TIMEOUT_MS). */
const TOR_RELAY_PUBLISH_TIMEOUT_MS = 10_000;

/** BridgePool reconnect backoff when routed through torProxyUrl — a fresh
 *  Tor circuit routinely takes longer than the 2s direct-connection retry
 *  floor, so retrying that fast just burns attempts before a circuit can
 *  finish building. */
const TOR_RECONNECT_BASE_MS = 8_000;
const TOR_RECONNECT_MAX_MS = 60_000;

interface PairingWindowState {
  token: string;
  /** CDX-039: generation guard, same idea as BridgePool's connectionEpoch — a
   *  subscription we deliberately replaced still calls back on the way out. */
  epoch: number;
  sub: SubscriptionHandle;
  timer: ReturnType<typeof setTimeout> | null;
  /** CDX-039: pending re-subscribe after the relays dropped the window. */
  resubscribeTimer: ReturnType<typeof setTimeout> | null;
  /** Re-open the authorless subscription for THIS window (same filter). */
  reopenSub: () => SubscriptionHandle;
  hostHandle: PairingHandle;
  onPaired?: (phone: PairedPhone) => void;
  onClosed?: (reason: PairingCloseReason) => void;
}

export interface BridgeCoreOptions {
  host: BridgeHost;
  /** The bridge identity keypair's secret key. */
  secretKey: Uint8Array;
  facade: SdkFacade;
  /** Injectable relay pool for tests. Defaults to the real BridgePool. */
  poolFactory?: PoolFactory;
  /** Heartbeat republish interval; 0 disables the timer (tests). */
  heartbeatIntervalMs?: number;
  /** Injectable timer seam for the sync server (tests). */
  syncTimers?: SyncTimers;
  /** Pending permission/question timeout override (tests). */
  permissionTimeoutMs?: number;
  /** GSD snapshot provider for gsd-request. Defaults to the gsd-tools reader
   *  (workspace/gsdState.ts). Injectable for tests / custom hosts. */
  gsdProvider?: GsdStateProvider;
  /** Injectable fetch (relay auto-register, credentials key validation). */
  fetchFn?: typeof fetch;
  /** Git-commit reconcile interval; 0 disables the timer (tests). */
  gitPollIntervalMs?: number;
  /** CDX-013: transcript retention sweep interval; 0 disables the timer
   *  (the boot sweep still runs). Default 24h. */
  retentionIntervalMs?: number;
  /** Injectable git-HEAD reader passed through to runners (tests). */
  gitHead?: (cwd: string) => Promise<string | null>;
  /** Injectable mesh admin (tests). Default: built from host config
   *  (nvpnPath / meshAdminEnabled) — a no-op when nvpn is absent. */
  meshAdmin?: MeshAdmin;
  /** Injectable device-action surface (tests). Default: real adb via
   *  host config `adbPath` / CODEDECK_ADB_PATH. */
  deviceActions?: DeviceActions;
  now?: () => number;
}

export class BridgeCore {
  readonly keypair: Keypair;
  /** Mesh (nvpn) admin — public so hosts can put mesh manual-join info in the
   *  pairing QR (`core.meshAdmin.onboardingInfo()` → `openPairingWindow({ mesh })`). */
  readonly meshAdmin: MeshAdmin;
  /** adb device actions (test sessions) — public for host diagnostics. */
  readonly deviceActions: DeviceActions;

  // Wired in start(); public so hosts (CLI / extension) can reach the engine parts.
  transcript!: TranscriptStore;
  registry!: SessionRegistry;
  broker!: PermissionBroker;
  syncServer!: SyncServer;
  pool!: BridgeCorePool;
  publisher!: Publisher;
  ingest!: CommandIngest;

  private readonly host: BridgeHost;
  private readonly facade: SdkFacade;
  private readonly poolFactory: PoolFactory;
  private readonly heartbeatIntervalMs: number;
  private readonly syncTimers?: SyncTimers;
  private readonly permissionTimeoutMs?: number;
  private readonly gsdProvider: GsdStateProvider;
  private readonly fetchFn?: typeof fetch;
  private readonly gitPollIntervalMs: number;
  private readonly retentionIntervalMs: number;
  private readonly gitHead?: (cwd: string) => Promise<string | null>;
  private readonly now: () => number;

  private readonly runners = new Map<string, SessionRunner>();

  /**
   * CDX-050: capability strings each phone advertised on its most recent
   * command this boot (`caps`; `[]` for pre-CDX-050 phones, which omit the
   * field). `diff` is the ONLY string consulted here — see phonesSupportDiff();
   * `chunked` is stored but never read (transport beacon, see capabilities.ts).
   * In-memory, per-boot, keyed by phone pubkey hex; never persisted or pruned.
   */
  private readonly phoneCaps = new Map<string, readonly string[]>();
  private paired: PairedPhone[] = [];
  /** Phone-set credentials, loaded at boot + kept current by set-credentials.
   *  Feeds sessionEnvFromCredentials at every SDK spawn. NEVER logged. */
  private storedCredentials: StoredCredentials = {};
  /** CDX-062: phone-managed custom provider profiles, loaded at boot + kept
   *  current by set-provider-profile. Looked up LIVE at every SDK spawn (token
   *  rotation reaches restarts). Token values NEVER logged. */
  private providerProfiles = new Map<string, ProviderProfile>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private gitPollTimer: ReturnType<typeof setInterval> | null = null;
  private retentionTimer: ReturnType<typeof setInterval> | null = null;
  private folderCache: { folders: string[]; at: number } | null = null;
  private pairing: PairingWindowState | null = null;
  /** CDX-039: bumped per pairing window, so a superseded window's subscription
   *  callbacks cannot resurrect themselves against the current one. */
  private pairingEpoch = 0;
  /** CDX-013: budget for negative pair-acks (window-closed / bad-token).
   *  Unpaired senders can trigger these at will — each one is a relay publish,
   *  i.e. free write amplification. After the budget is spent within the
   *  window, further rejections are logged but not acked. */
  private pairNack = { windowStart: 0, count: 0 };
  private images!: ImageUploadHandler;
  private stopped = false;

  private constructor(options: BridgeCoreOptions) {
    this.host = options.host;
    this.facade = options.facade;
    this.keypair = keypairFromSecret(options.secretKey);
    this.poolFactory = options.poolFactory ?? ((o, c) => new BridgePool(o, c));
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.syncTimers = options.syncTimers;
    this.permissionTimeoutMs = options.permissionTimeoutMs;
    this.gsdProvider = options.gsdProvider ?? getGsdState;
    this.fetchFn = options.fetchFn;
    this.gitPollIntervalMs = options.gitPollIntervalMs ?? DEFAULT_GIT_POLL_INTERVAL_MS;
    this.retentionIntervalMs = options.retentionIntervalMs ?? DEFAULT_RETENTION_INTERVAL_MS;
    this.gitHead = options.gitHead;
    this.now = options.now ?? Date.now;
    this.meshAdmin =
      options.meshAdmin ??
      createMeshAdmin({
        ...(this.host.config.nvpnPath ? { nvpnPath: this.host.config.nvpnPath } : {}),
        ...(this.host.config.meshAdminEnabled !== undefined
          ? { enabled: this.host.config.meshAdminEnabled }
          : {}),
        log: (msg) => this.log(msg),
      });
    this.deviceActions =
      options.deviceActions ??
      createDeviceActions({
        ...(this.host.config.adbPath ? { adbPath: this.host.config.adbPath } : {}),
        log: (msg) => this.log(msg),
      });
  }

  /** Boot the bridge: load state, resume sessions, connect, heartbeat. */
  static async start(options: BridgeCoreOptions): Promise<BridgeCore> {
    const core = new BridgeCore(options);
    await core.init();
    return core;
  }

  private async init(): Promise<void> {
    const stateDir = this.host.sessionStateDir();
    const log = this.log;

    this.paired = await this.loadPairedPhones();
    // Credentials stored by a phone in an earlier run must reach sessions
    // spawned this run (incl. resume-on-boot below) — load before any runner.
    try {
      const rawCreds = await this.host.storage.get(STORAGE_KEY_CREDENTIALS);
      if (rawCreds) this.storedCredentials = JSON.parse(rawCreds) as StoredCredentials;
    } catch {
      /* corrupt store — sessions inherit process.env until the next set-credentials */
    }
    // CDX-062: provider profiles stored by a phone in an earlier run must
    // reach sessions spawned this run (incl. resume-on-boot) — load them
    // beside the credentials, corrupt-tolerant.
    try {
      const rawProfiles = await this.host.storage.get(STORAGE_KEY_PROVIDER_PROFILES);
      if (rawProfiles) {
        const parsed = JSON.parse(rawProfiles) as Partial<StoredProviderProfiles>;
        for (const profile of Array.isArray(parsed.profiles) ? parsed.profiles : []) {
          if (profile && typeof profile.id === 'string' && profile.id.length > 0) {
            this.providerProfiles.set(profile.id, profile);
          }
        }
      }
    } catch {
      /* corrupt store — no profiles until the next set-provider-profile */
    }
    const lastSeen = Number((await this.host.storage.get(STORAGE_KEY_LAST_SEEN)) ?? '0') || 0;
    const processedIds = await this.loadProcessedIds();

    this.transcript = await TranscriptStore.open(stateDir, log);
    this.registry = new SessionRegistry(stateDir, log);

    this.broker = new PermissionBroker(
      {
        onPermissionCard: (card) => this.publishPermissionCard(card),
        // AskUserQuestion + ExitPlanMode cards are already emitted by the SDK
        // adapter inside the output stream — no extra out-of-band entry needed.
        onQuestionCard: () => {},
        onPlanCard: () => {},
        onAutoModeChange: (sessionId, mode) => {
          this.runners.get(sessionId)?.applyAutoModeChange(mode);
          void this.publishToPhones({ type: 'mode-confirmed', sessionId, mode });
        },
        onPendingChanged: (sessionId) => {
          if (this.stopped) return;
          const runner = this.runners.get(sessionId);
          void (async () => {
            await runner?.refreshRegistryState();
            await this.publishSessionList();
          })();
        },
        log,
      },
      this.permissionTimeoutMs !== undefined ? { timeoutMs: this.permissionTimeoutMs } : undefined,
    );

    this.ingest = new CommandIngest({
      secretKey: this.keypair.secretKey,
      handlers: this.commandHandlers(),
      // CDX-050: every valid command refreshes the sender's capability record.
      onPhoneCaps: (phone, caps) => {
        this.phoneCaps.set(phone, caps);
      },
      isPairedPhone: (pk) => this.paired.some((p) => p.pubkeyHex === pk),
      log,
      now: this.now,
      lastSeenTimestamp: lastSeen,
      // Seed the dedup set: the reconnect filter's `since = lastSeen − 5s`
      // grace makes the relay replay recently-processed commands after a
      // restart — without the persisted ids they would be RE-EXECUTED
      // (duplicate sessions, re-sent inputs). Found by the CDX-008 contract test.
      processedEventIds: processedIds,
    });

    const { torProxyUrl } = this.host.config;
    try {
      this.pool = this.poolFactory(
        {
          relays: [...this.host.config.relays],
          // NIP-42: answer AUTH challenges (e.g. a Haven relay) with the
          // bridge's own identity keypair — the same pubkey already used for
          // pairing/publishing, so a relay only needs ONE allowlisted pubkey.
          // Harmless to hand out unconditionally: a relay that never
          // challenges never calls this.
          automaticallyAuth: createRelayAuthSigner(this.keypair.secretKey),
          ...(torProxyUrl
            ? {
                websocketImplementation: createTorWebSocket(torProxyUrl),
                reconnectBaseMs: TOR_RECONNECT_BASE_MS,
                reconnectMaxMs: TOR_RECONNECT_MAX_MS,
              }
            : {}),
        },
        {
          buildFilter: () => {
            const phones = this.phonePubkeys();
            if (phones.length === 0) return null;
            return buildCommandsFilter({
              bridgePubkey: this.keypair.pubkeyHex,
              phonePubkeys: phones,
              since: sinceForConnect(
                this.ingest.lastSeenTimestamp,
                Math.floor(this.now() / 1000),
              ),
            });
          },
          onEvent: (event) => this.ingest.handleEvent(event),
          onStatus: (status: ConnectionStatus, message?: string) => {
            log(`[BridgeCore] Relay status: ${status}${message ? ` (${message})` : ''}`);
          },
          log,
        },
      );
    } catch (err) {
      // Construction failure here is not recoverable at startup — BridgePool's
      // own constructor does no I/O and shouldn't throw, but this is the one
      // spot a bad Tor proxy URL or similar misconfiguration would surface.
      log(`[BridgeCore] Failed to construct relay pool: ${err}`);
      throw err;
    }

    this.publisher = new Publisher({
      secretKey: this.keypair.secretKey,
      machineName: this.host.config.machineName,
      transport: this.pool,
      log,
      now: this.now,
      // Tor's circuit build + extra hops routinely exceed the 5s
      // direct-connection default, causing publishes to be declared failed
      // (and retried) well before the relay actually replies.
      ...(torProxyUrl ? { publishTimeoutMs: TOR_RELAY_PUBLISH_TIMEOUT_MS } : {}),
    });

    this.syncServer = new SyncServer({
      transcript: this.transcript,
      send: (msg, phone) => this.publisher.publishToPhones(msg, [phone]),
      log,
      ...(this.syncTimers ? { timers: this.syncTimers } : {}),
    });

    this.images = new ImageUploadHandler({
      // Ported location: `<first workspace root>/.codedeck/uploads` — the file
      // must be readable by the session's Read tool, so it lives in the
      // workspace, not the private state dir.
      uploadsDir: () => path.join(this.workspaceRoots()[0]!, '.codedeck', 'uploads'),
      sendInput: (sessionId, text) => this.runners.get(sessionId)?.sendInput(text) ?? false,
      log,
      ...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
      now: this.now,
    });

    this.host.onShutdown(() => this.shutdown());

    this.resumeOnBoot();
    this.pool.connect();
    await this.publishSessionList();

    if (this.heartbeatIntervalMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        void this.persistCursor();
        void this.publishSessionList();
      }, this.heartbeatIntervalMs);
      this.heartbeatTimer.unref?.();
    }

    if (this.gitPollIntervalMs > 0) {
      // Reconcile every session's `committed` flag with real git state so the
      // badge appears whether the commit was made by the agent or manually in
      // a terminal (ported poll; runner.detectCommit publishes via
      // onStateChanged when it flips).
      this.gitPollTimer = setInterval(() => {
        for (const runner of this.runners.values()) {
          void runner.detectCommit();
        }
      }, this.gitPollIntervalMs);
      this.gitPollTimer.unref?.();
    }

    // CDX-013 transcript retention: boot sweep + daily interval.
    void this.runTranscriptRetention();
    if (this.retentionIntervalMs > 0) {
      this.retentionTimer = setInterval(() => {
        void this.runTranscriptRetention();
      }, this.retentionIntervalMs);
      this.retentionTimer.unref?.();
    }
  }

  /**
   * CDX-013 retention: delete transcripts whose session is gone from the
   * registry (orphans from a crash between registry.remove and
   * transcript.remove), and cap every live session's transcript to
   * `transcriptKeepLast` entries (config; 0 disables). Prune keeps original
   * seqs, so phone sync stays coherent — it just cannot backfill further than
   * the cap, by design.
   */
  private async runTranscriptRetention(): Promise<void> {
    const keepLast = this.host.config.transcriptKeepLast ?? DEFAULT_TRANSCRIPT_KEEP_LAST;
    if (keepLast <= 0) return;
    try {
      const live = new Set(this.registry.list().map((r) => r.sessionId));
      for (const sessionId of this.transcript.sessions()) {
        if (this.stopped) return;
        if (!live.has(sessionId)) {
          this.log(`[BridgeCore] Retention: removing orphaned transcript ${sessionId}`);
          await this.transcript.remove(sessionId);
          continue;
        }
        await this.transcript.prune(sessionId, keepLast);
      }
    } catch (err) {
      this.log(`[BridgeCore] Transcript retention sweep failed: ${err}`);
    }
  }

  /**
   * Resume every registry-persisted session via the facade's resume support —
   * the fix for bridge-restart amnesia. Sessions come back 'idle' and pick up
   * where their SDK transcript left off.
   */
  private resumeOnBoot(): void {
    for (const record of this.registry.list()) {
      if (this.runners.has(record.sessionId)) continue;
      this.log(`[BridgeCore] Resuming session ${record.sessionId} (sdk: ${record.sdkSessionId ?? 'unknown'})`);
      const runner = this.makeRunner({
        sessionId: record.sessionId,
        cwd: record.cwd,
        // CDX-062: the runner also rehydrates this from the record itself;
        // passing it keeps makeRunner's wiring explicit.
        ...(record.providerId ? { providerId: record.providerId } : {}),
        resume: true,
      });
      this.runners.set(record.sessionId, runner);
      runner.start();
    }
  }

  // --- Public surface for hosts ---

  get machineName(): string {
    return this.host.config.machineName;
  }

  pairedPhones(): PairedPhone[] {
    return [...this.paired];
  }

  runnerCount(): number {
    return this.runners.size;
  }

  runner(sessionId: string): SessionRunner | undefined {
    return this.runners.get(sessionId);
  }

  /** Register a newly paired phone: persist, resubscribe, greet with a heartbeat. */
  async addPairedPhone(phone: PairedPhone): Promise<void> {
    if (!this.paired.some((p) => p.pubkeyHex === phone.pubkeyHex)) {
      this.paired.push(phone);
      await this.savePairedPhones();
    }
    this.pool.resubscribe();
    await this.publishSessionList();
  }

  async removePairedPhone(pubkeyHex: string): Promise<void> {
    this.paired = this.paired.filter((p) => p.pubkeyHex !== pubkeyHex);
    await this.savePairedPhones();
    this.pool.resubscribe();
  }

  // --- Pairing window (the CDX-005 pairing flow, ported from the old bridge) ---

  /**
   * Open a time-boxed pairing window: subscribe with the authorless pairing
   * filter (the ONLY path an unpaired phone can reach this bridge), hand the
   * pairing URL to `host.presentPairing` (webview QR / terminal QR), and accept
   * exactly the pair-request that echoes this window's one-time token.
   * Re-opening replaces the prior window (ported behavior). On success the
   * phone is persisted to the paired set and greeted with a pair-ack +
   * heartbeat; the window auto-closes after `durationMs`.
   */
  openPairingWindow(opts: PairingWindowOptions = {}): PairingWindowInfo {
    if (this.stopped) {
      throw new Error('BridgeCore is shut down — cannot open a pairing window');
    }
    if (!this.pool.openSubscription) {
      throw new Error(
        'BridgeCore: this pool does not implement openSubscription — pairing window unavailable',
      );
    }
    this.closePairingWindow();

    const token = opts.token ?? randomBytes(16).toString('hex');
    const durationMs = opts.durationMs ?? DEFAULT_PAIRING_WINDOW_MS;
    const { url, displayUrl } = buildPairingUrl({
      npub: this.keypair.npub,
      relays: this.host.config.relays,
      machine: this.host.config.machineName,
      token,
      ...(opts.mesh ? { meshAdmin: opts.mesh.adminDeviceId, netid: opts.mesh.netid } : {}),
    });
    const expiresAt = new Date(this.now() + durationMs);

    const epoch = ++this.pairingEpoch;
    // CDX-039: `since` is pinned to the window's start, so a re-subscribe after
    // a relay drop replays anything a phone sent during the outage instead of
    // opening a hole in the middle of the window.
    const filter = buildPairingFilter({
      bridgePubkey: this.keypair.pubkeyHex,
      nowSec: Math.floor(this.now() / 1000),
    });
    const openSub = (): SubscriptionHandle =>
      this.pool.openSubscription!(filter, {
        onevent: (event) => this.ingest.handlePairingEvent(event),
        oneose: () => this.log('[BridgeCore] Pairing window open — listening for pair requests'),
        onclose: (reasons) => this.onPairingSubscriptionClosed(epoch, reasons),
      });

    const hostHandle = this.host.presentPairing({ url, displayUrl, expiresAt });
    const timer = setTimeout(() => {
      this.log('[BridgeCore] Pairing window expired');
      this.closePairingWindow('expired');
    }, durationMs);
    timer.unref?.();

    this.pairing = {
      token,
      epoch,
      sub: openSub(),
      timer,
      resubscribeTimer: null,
      reopenSub: openSub,
      hostHandle,
      ...(opts.onPaired ? { onPaired: opts.onPaired } : {}),
      ...(opts.onClosed ? { onClosed: opts.onClosed } : {}),
    };
    this.log(`[BridgeCore] Pairing window opened for ${Math.round(durationMs / 1000)}s`);
    return { url, displayUrl, token, expiresAt };
  }

  /**
   * CDX-039: the authorless pairing subscription is the ONLY path an unpaired
   * phone can reach this bridge, and `openSubscription` is deliberately not
   * auto-reconnected. When the relays drop it the window is still nominally
   * open — the QR is still on screen, the countdown still runs — but nothing
   * can ever arrive. From the operator's seat that is indistinguishable from
   * "the phone can't reach the relay", and the only trace was a bare debug
   * line. So: say it at warn level, in words that name the consequence, and
   * re-establish the subscription for the rest of the window.
   */
  private onPairingSubscriptionClosed(epoch: number, reasons: unknown): void {
    const win = this.pairing;
    // Our own teardown (closePairingWindow nulls `pairing` before closing the
    // sub), or a window we already replaced.
    if (!win || win.epoch !== epoch) return;

    this.host.log(
      'warn',
      `[BridgeCore] Pairing subscription dropped by the relays (${JSON.stringify(reasons)}). ` +
      'The pairing window is still open but UNREACHABLE until it is restored — ' +
      `a phone that scans right now will not be heard. Re-subscribing in ${PAIRING_RESUBSCRIBE_MS}ms.`,
    );

    if (win.resubscribeTimer) return; // one attempt in flight is enough
    win.resubscribeTimer = setTimeout(() => {
      const current = this.pairing;
      if (!current || current.epoch !== epoch) return;
      current.resubscribeTimer = null;
      try {
        current.sub = current.reopenSub();
        this.log('[BridgeCore] Pairing subscription re-established');
      } catch (err) {
        this.host.log('warn', `[BridgeCore] Pairing re-subscribe failed: ${err}`);
      }
    }, PAIRING_RESUBSCRIBE_MS);
    win.resubscribeTimer.unref?.();
  }

  /** Close/revoke the pairing window (idempotent). Tears down the authorless
   *  subscription and the host's pairing presentation. */
  closePairingWindow(reason: PairingCloseReason = 'closed'): void {
    const win = this.pairing;
    if (!win) return;
    this.pairing = null;
    if (win.timer) clearTimeout(win.timer);
    if (win.resubscribeTimer) clearTimeout(win.resubscribeTimer);
    win.sub.close();
    try {
      win.hostHandle.close();
    } catch (err) {
      this.log(`[BridgeCore] Pairing presentation close failed: ${err}`);
    }
    win.onClosed?.(reason);
  }

  get pairingWindowOpen(): boolean {
    return this.pairing !== null;
  }

  /**
   * Validate a pair-request against the open window's token. The paired
   * identity is the EVENT AUTHOR's pubkey — never the payload's claim. Ordering
   * ported from the old extension: close the window (tearing down the
   * authorless subscription) BEFORE addPairedPhone resubscribes the main
   * filter, then ack to the now-paired phone.
   */
  private async handlePairRequest(msg: PairRequestMessage, fromPubkey: string): Promise<void> {
    const machine = this.host.config.machineName;
    const win = this.pairing;
    if (!win) {
      this.log(`[BridgeCore] Rejecting pair-request from ${fromPubkey.slice(0, 8)}… — no pairing window open`);
      if (this.allowPairNack()) {
        await this.publisher.publishToPhones(
          { type: 'pair-ack', machine, ok: false, reason: 'window-closed' },
          [fromPubkey],
        );
      }
      return;
    }
    if (msg.token !== win.token) {
      this.log(`[BridgeCore] Rejecting pair-request from ${fromPubkey.slice(0, 8)}… — bad token`);
      if (this.allowPairNack()) {
        await this.publisher.publishToPhones(
          { type: 'pair-ack', machine, ok: false, reason: 'bad-token' },
          [fromPubkey],
        );
      }
      return;
    }

    const label = msg.label || 'Phone';
    const phone: PairedPhone = {
      npub: npubFromHex(fromPubkey),
      pubkeyHex: fromPubkey,
      label,
      pairedAt: new Date(this.now()).toISOString(),
    };
    this.log(`[BridgeCore] Pairing phone "${label}" (${fromPubkey.slice(0, 8)}…)`);
    const onPaired = win.onPaired;
    this.closePairingWindow('paired');
    await this.addPairedPhone(phone); // persist + resubscribe + greeting heartbeat
    // The ack carries the bridge's relays + host so a manual-npub pairing
    // (whose URL had no relay list) still learns where this bridge lives.
    await this.publisher.publishToPhones({
      type: 'pair-ack',
      machine,
      ok: true,
      relays: [...this.host.config.relays],
      host: this.host.config.host,
    }, [fromPubkey]);
    this.host.notify('info', `Phone "${label}" paired`);
    onPaired?.(phone);
    // Auto-register the new pubkey on a write-restricted relay (ported
    // relayAdmin flow). Fire-and-forget: failure logs + notifies, NEVER blocks
    // or fails the pairing.
    this.registerPhonePubkeyOnRelay(fromPubkey, label);
  }

  /** CDX-013: at most MAX_PAIR_NACKS negative pair-acks per window — the
   *  legitimate failure UX (a handful of retries) fits comfortably; a flood
   *  stops being amplified into relay writes. */
  private static readonly MAX_PAIR_NACKS = 5;
  private static readonly PAIR_NACK_WINDOW_MS = 10 * 60_000;

  private allowPairNack(): boolean {
    const now = this.now();
    if (now - this.pairNack.windowStart >= BridgeCore.PAIR_NACK_WINDOW_MS) {
      this.pairNack = { windowStart: now, count: 0 };
    }
    this.pairNack.count++;
    if (this.pairNack.count > BridgeCore.MAX_PAIR_NACKS) {
      this.log('[BridgeCore] Negative pair-ack budget spent — dropping rejection silently');
      return false;
    }
    return true;
  }

  /**
   * Best-effort auto-registration for a freshly paired phone, on every service
   * that gates by pubkey. Both are no-ops unless configured, and neither can
   * block or fail the pairing.
   */
  private registerPhonePubkeyOnRelay(pubkeyHex: string, label: string): void {
    this.autoRegisterPhone(pubkeyHex, label, {
      endpoint: this.host.config.relayRegisterEndpoint,
      token: this.host.config.relayRegisterToken,
      logName: 'Relay',
      service: 'relay',
      consequence: 'it may not be able to publish there',
    });
    // CDX-093: the media server runs the same admin contract over a KV namespace
    // the relay happens to share — so relay registration used to grant Blossom
    // uploads by accident. When relay2 went open-write and Blossom did not, that
    // accident stopped holding and every image upload 403'd, silently falling
    // back to relay chunking. Registering explicitly is what survives the next
    // time those two write policies drift apart.
    this.autoRegisterPhone(pubkeyHex, label, {
      endpoint: this.host.config.blossomRegisterEndpoint,
      token: this.host.config.blossomRegisterToken,
      logName: 'Blossom',
      service: 'image server',
      consequence: 'image uploads may fall back to slow relay chunking',
    });
  }

  private autoRegisterPhone(
    pubkeyHex: string,
    label: string,
    opts: {
      endpoint?: string;
      token?: string;
      logName: string;
      service: string;
      consequence: string;
    },
  ): void {
    const { endpoint, token } = opts;
    if (!endpoint || !token) return;
    void registerPhoneOnRelay(pubkeyHex, {
      endpoint,
      token,
      ...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
    }).then((result) => {
      if (result.ok) {
        this.log(
          `[BridgeCore] Phone ${pubkeyHex.slice(0, 8)}… ${result.status} on ${opts.service} ${endpoint}`,
        );
      } else {
        this.log(
          `[BridgeCore] ${opts.logName} auto-register failed for ${pubkeyHex.slice(0, 8)}…: ${result.reason}`,
        );
        this.host.notify(
          'warn',
          `Phone "${label}" paired, but registering it on the ${opts.service} failed (${result.reason}) — ${opts.consequence}.`,
        );
      }
    });
  }

  /**
   * Graceful shutdown: truthful final publish, then teardown. The session list
   * goes out with every session `state:'offline'` + `machineOffline:true` —
   * never an empty list.
   */
  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.log('[BridgeCore] Shutting down');

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.gitPollTimer) {
      clearInterval(this.gitPollTimer);
      this.gitPollTimer = null;
    }
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
    this.images.dispose();
    this.closePairingWindow();
    this.syncServer.close();

    for (const runner of this.runners.values()) {
      await runner.close();
    }
    this.runners.clear();

    // CDX-013: drain in-flight transcript writes before the process can exit —
    // a half-written append read by the next boot's recoverFile would strand a
    // seq the phone already saw live (soak-surfaced seq conflict).
    await this.transcript.idle();

    await this.registry.markOffline();
    await this.persistCursor();
    await this.publishSessionList({ offline: true });
    this.pool.dispose();
  }

  // --- Session list heartbeat ---

  /** Publish the 30515 heartbeat: sessions + capabilities + folders (+ tombstones). */
  async publishSessionList(opts: { offline?: boolean } = {}): Promise<void> {
    if (this.stopped && !opts.offline) return;
    const phones = this.phonePubkeys();
    if (phones.length === 0) return;

    const removed = this.registry.removedSessions();
    const msg: SessionListMessage = {
      type: 'sessions',
      machine: this.host.config.machineName,
      host: this.host.config.host,
      sessions: this.remoteSessions(),
      protocolVersion: PROTOCOL_VERSION,
      // The full set. Only `images` and `custom-providers` are read by the phone
      // as gates; the rest are presence markers the phone detects via payload
      // data instead (see the tier note in capabilities.ts).
      capabilities: [...ALL_BRIDGE_CAPABILITIES],
      folders: this.workspaceFolders(),
      // CDX-031: `folders` lists what is INSIDE the roots, so with several
      // `--workspace` roots the phone could reach every root's subfolders but
      // never a root itself — roots 2..N were unreachable, and two flat
      // project roots advertised nothing at all. The roots go on the wire too.
      roots: this.workspaceRoots(),
      ...(removed.length > 0 ? { removedSessions: removed } : {}),
      ...(opts.offline ? { machineOffline: true } : {}),
    };
    await this.publisher.publishToPhones(msg, phones);
  }

  /**
   * Host hook: the workspace roots changed under us (VSCode folder add/remove
   * events, a config edit). Drops the folder cache — the roots feed the scan,
   * but the cache doesn't key on them — and republishes the heartbeat so the
   * phone's folder picker updates now, not up to FOLDER_CACHE_TTL_MS later.
   */
  async refreshFolders(): Promise<void> {
    this.folderCache = null;
    await this.publishSessionList();
  }

  /**
   * Registry sessions as RemoteSessionInfo, decorated with the CDX-062
   * providerLabel — resolved LIVE against the profile map at publish time, so
   * a deleted profile degrades to showing the raw id instead of vanishing.
   */
  private remoteSessions(): RemoteSessionInfo[] {
    return this.registry.toRemoteSessionInfo(this.transcript).map((info) => {
      if (!info.providerId) return info;
      const label = this.providerProfiles.get(info.providerId)?.label ?? info.providerId;
      return { ...info, providerLabel: label };
    });
  }

  private sessionInfo(sessionId: string): RemoteSessionInfo | undefined {
    return this.remoteSessions().find((s) => s.id === sessionId);
  }

  // --- Command dispatch (validated ingest → engine) ---

  private commandHandlers(): CommandHandlers {
    return {
      onInput: async (msg) => {
        const runner = this.runners.get(msg.sessionId);
        const sent = runner ? runner.sendInput(msg.text) : false;
        if (!sent) {
          this.log(`[BridgeCore] No live session for input to ${msg.sessionId}`);
          await this.publishToPhones({
            type: 'input-failed',
            sessionId: msg.sessionId,
            // 'no-session': the bridge knows no such session at all;
            // 'error': the runner exists but rejected the input (dead/ended).
            reason: runner ? 'error' : 'no-session',
            ...(msg.inputId ? { inputId: msg.inputId } : {}),
          });
          return;
        }
        if (msg.inputId) {
          await this.publishToPhones({
            type: 'input-ack',
            sessionId: msg.sessionId,
            inputId: msg.inputId,
          });
        }
      },

      onQuestionInput: async (msg) => {
        const runner = this.runners.get(msg.sessionId);
        const sent = runner ? runner.sendQuestionInput(msg.text) : false;
        if (!sent) {
          await this.publishToPhones({
            type: 'input-failed',
            sessionId: msg.sessionId,
            reason: runner ? 'error' : 'no-session',
          });
        }
      },

      onPermissionResponse: (msg) => {
        this.broker.resolvePermission(msg.requestId, msg.allow, msg.modifier);
      },

      onKeypress: async (msg) => {
        await this.runners.get(msg.sessionId)?.handleKeypress(msg.key, msg.context);
      },

      onModeChange: async (msg) => {
        const runner = this.runners.get(msg.sessionId);
        if (!runner) return;
        const ok = await runner.setPermissionMode(msg.mode);
        if (ok) {
          await this.publishToPhones({
            type: 'mode-confirmed',
            sessionId: msg.sessionId,
            mode: msg.mode,
          });
        }
      },

      onEffortChange: async (msg) => {
        const runner = this.runners.get(msg.sessionId);
        if (!runner) return;
        const { confirmedLevel } = await runner.setEffort(msg.level);
        // Always confirm back so the phone UI stays in sync, even on failure.
        await this.publishToPhones({
          type: 'effort-confirmed',
          sessionId: msg.sessionId,
          level: confirmedLevel,
        });
      },

      onModelChange: async (msg) => {
        const runner = this.runners.get(msg.sessionId);
        if (!runner) return;
        // CDX-062 (D3): a provider-bound session may only switch between the
        // models its profile lists — an Anthropic model id would be sent to
        // the custom provider verbatim. Profile deleted → reject too. On
        // reject: log, NO model-confirmed (the phone keeps its known model).
        if (runner.providerId) {
          const profile = this.providerProfiles.get(runner.providerId);
          if (!profile) {
            this.log(`[BridgeCore] model change rejected for ${msg.sessionId}: provider profile '${runner.providerId}' was deleted`);
            return;
          }
          if (!profile.models.some((m) => m.id === msg.model)) {
            this.log(`[BridgeCore] model change rejected for ${msg.sessionId}: '${msg.model}' is not in provider profile '${profile.id}'`);
            return;
          }
        }
        const { confirmedModel } = await runner.setModel(msg.model);
        await this.publishToPhones({
          type: 'model-confirmed',
          sessionId: msg.sessionId,
          model: confirmedModel,
        });
      },

      onSyncRequest: (msg, phone) => {
        this.syncServer.handleSyncRequest(msg, phone);
      },

      onSyncAck: (msg) => {
        this.syncServer.handleAck(msg.syncId, msg.range);
      },

      onCreateSession: (msg) => this.handleCreateSession(msg),

      onRefreshSessions: async () => {
        await this.publishSessionList();
      },

      onCloseSession: async (msg) => {
        const runner = this.runners.get(msg.sessionId);
        const existed = !!runner || !!this.registry.get(msg.sessionId);
        if (runner) {
          await runner.close();
          this.runners.delete(msg.sessionId);
        }
        await this.registry.remove(msg.sessionId);
        await this.transcript.remove(msg.sessionId);
        await this.publishToPhones({
          type: 'close-session-ack',
          sessionId: msg.sessionId,
          success: existed,
        });
        await this.publishSessionList();
      },

      onInterrupt: (msg) => {
        this.runners.get(msg.sessionId)?.interrupt();
      },

      onCreateFolder: (msg) => this.handleCreateFolder(msg),

      onModelsRequest: async () => {
        const models = await this.facade.supportedModels();
        // CDX-022/CDX-035: an empty list means "no live SDK session answered",
        // not "the SDK supports zero models". CDX-022 made us publish NOTHING
        // (so the phone kept retrying instead of freezing on an empty picker),
        // which worked but was silent. Now we publish the empty list WITH a
        // reason: the phone renders it, keeps whatever list it already had,
        // and keeps re-requesting — an empty answer is no longer
        // indistinguishable from a lost message.
        if (models.length === 0) {
          const error = 'No live Claude session answered — start or open a session and try again.';
          this.log(`[BridgeCore] models-request: ${error}`);
          await this.publishToPhones({ type: 'models', models: [], error });
          return;
        }
        await this.publishToPhones({ type: 'models', models });
      },

      onUploadImage: (msg) => {
        this.images.handle(msg);
      },

      onUsageRequest: async (msg) => {
        const runner = this.runners.get(msg.sessionId);
        if (!runner) return;
        // CDX-062 usage honesty: Claude Code's total_cost_usd uses Anthropic's
        // price table and the 5h/7d windows are Anthropic-subscription
        // concepts — for a provider-bound session those numbers would be
        // WRONG, so we withhold (publish nothing; the phone shows nothing).
        if (runner.providerId) {
          this.log(`[BridgeCore] usage-request for provider-bound session ${msg.sessionId} withheld (Anthropic-priced numbers would be wrong)`);
          return;
        }
        const usage = await runner.getUsage();
        // Unsupported SDK / non-subscription / fetch failure → publish nothing;
        // the phone keeps its last value (ported).
        if (!usage) return;
        await this.publishToPhones({ type: 'usage', sessionId: msg.sessionId, usage });
      },

      onGsdRequest: async (msg) => {
        const cwd = this.runners.get(msg.sessionId)?.cwd ?? this.registry.get(msg.sessionId)?.cwd;
        if (!cwd) return;
        // Always publishes, including `available: false`, so the phone can
        // retire a stale strip when a session moves off a GSD project (ported).
        const gsd = await this.gsdProvider(cwd);
        await this.publishToPhones({ type: 'gsd-state', sessionId: msg.sessionId, gsd });
      },

      onSetCredentials: (msg, phone) => this.handleSetCredentials(msg, phone),
      onSetProviderProfile: (msg, phone) => this.handleSetProviderProfile(msg, phone),
      onProviderProfilesRequest: async (_msg, phone) => {
        // Always answerable straight from storage — no error case (unlike models).
        await this.publisher.publishToPhones(this.providerProfilesMessage(), [phone]);
      },
      onSetDeviceConfig: (msg, phone) => this.handleSetDeviceConfig(msg, phone),
      onPairRequest: (msg, phone) => this.handlePairRequest(msg, phone),
    };
  }

  /**
   * Two-phase session creation (ported pattern): publish `session-pending`
   * immediately, spawn the runner, and let its onReady/onFailed events publish
   * `session-ready` / `session-failed`.
   */
  private async handleCreateSession(msg: CreateSessionMessage): Promise<void> {
    const sessionId = randomUUID();
    const roots = this.workspaceRoots();
    const cwd = resolveSessionCwdMulti(roots, msg.cwd, this.log, { create: !!msg.createCwd });
    // A folder just created from the phone should appear in the picker on the
    // next publish, not up to a cache TTL later.
    if (msg.createCwd) this.folderCache = null;

    // CDX-062: resolve the provider binding up front. Only profile id/label
    // ever hit the log — never the token.
    const profile = msg.providerId ? this.providerProfiles.get(msg.providerId) : undefined;

    this.log(`[BridgeCore] Create session ${sessionId} in ${cwd}${msg.model ? ` (model: ${msg.model})` : ''}${msg.defaultEffort ? ` (effort: ${msg.defaultEffort})` : ''}${msg.providerId ? ` (provider: ${msg.providerId}${profile ? ` "${profile.label}"` : ''})` : ''}`);

    await this.publishToPhones({
      type: 'session-pending',
      pendingId: sessionId,
      machine: this.host.config.machineName,
      createdAt: new Date().toISOString(),
    });

    // CDX-062: an unknown or token-less profile can never spawn — keep the
    // two-phase contract (pending already went out) and fail immediately with
    // a reason instead of a doomed spawn.
    // CDX-071 amendment: an insecure stored base URL joins that list. buildSessionEnv
    // would refuse it anyway (it is the invariant), but that throw surfaces as a
    // generic `SDK session spawn failed: Error: …` — checking here gives the
    // operator the SAME plain sentence the phone's Save gate shows, on the card
    // they are already looking at, and costs the doomed spawn nothing.
    if (msg.providerId && (!profile || !profile.authToken || !isValidProviderBaseUrl(profile.baseUrl))) {
      const reason = !profile
        ? `Unknown provider profile '${msg.providerId}' — it may have been deleted on this machine.`
        : !isValidProviderBaseUrl(profile.baseUrl)
          ? `Provider profile '${profile.label}' has an insecure base URL (${profile.baseUrl}) — ${PROVIDER_BASE_URL_ERROR}. Its API token would travel in cleartext. Edit the profile in Settings and save it again.`
          : `Provider profile '${profile.label}' has no API token stored — set one in Settings first.`;
      this.log(`[BridgeCore] Create session ${sessionId} refused: ${reason}`);
      await this.publishToPhones({ type: 'session-failed', pendingId: sessionId, reason });
      return;
    }

    // CDX-062: provider-bound sessions default their model from the profile
    // (the SDK's own default is an Anthropic model the provider doesn't have).
    const model = msg.model ?? profile?.defaultModel ?? profile?.models[0]?.id;

    const runner = this.makeRunner({
      sessionId,
      cwd,
      ...(model ? { model } : {}),
      ...(msg.providerId ? { providerId: msg.providerId } : {}),
      ...(msg.defaultEffort ? { effortLevel: msg.defaultEffort } : {}),
      ...(msg.testSession ? { testSession: true } : {}),
    });
    this.runners.set(sessionId, runner);
    runner.start();
  }

  private async handleCreateFolder(msg: CreateFolderMessage): Promise<void> {
    const roots = this.workspaceRoots();
    let root = roots[0]!;
    if (msg.root) {
      const match = roots.find((r) => path.resolve(r) === path.resolve(msg.root!));
      if (!match) {
        await this.publishToPhones({
          type: 'folder-ack',
          requestId: msg.requestId,
          success: false,
          error: 'unknown workspace root',
        });
        return;
      }
      root = match;
    }

    const result = createProjectFolder(root, msg.path, this.log);
    if (result.ok) this.folderCache = null;
    await this.publishToPhones({
      type: 'folder-ack',
      requestId: msg.requestId,
      success: result.ok,
      ...(result.ok ? { path: result.path } : { error: result.error }),
    });
    if (result.ok) {
      // Next heartbeat would carry it anyway; republish now so the picker updates.
      await this.publishSessionList();
    }
  }

  // --- Credentials / device config (ported semantics) ---

  /**
   * Store phone-set credentials in host storage and confirm with a
   * credentials-ack to the requesting phone. Semantics ported from the
   * standalone bridge: explicit null deletes a credential, undefined leaves it
   * alone; the effective API key is env ANTHROPIC_API_KEY over the stored one;
   * the key is optionally validated with a 1-token request. Credential VALUES
   * are never logged and never echoed back over the wire.
   */
  private async handleSetCredentials(msg: SetCredentialsMessage, phone: string): Promise<void> {
    const machine = this.host.config.machineName;
    this.log(`[BridgeCore] set-credentials from ${phone.slice(0, 8)}…`);
    try {
      let stored: StoredCredentials = {};
      try {
        const raw = await this.host.storage.get(STORAGE_KEY_CREDENTIALS);
        if (raw) stored = JSON.parse(raw) as StoredCredentials;
      } catch { /* corrupt store — start fresh */ }

      const updated: StoredCredentials = { ...stored, updatedAt: new Date(this.now()).toISOString() };
      if (msg.anthropicApiKey !== undefined) {
        if (msg.anthropicApiKey === null) delete updated.anthropicApiKey;
        else updated.anthropicApiKey = msg.anthropicApiKey;
      }
      if (msg.githubPat !== undefined) {
        if (msg.githubPat === null) delete updated.githubPat;
        else updated.githubPat = msg.githubPat;
      }
      await this.host.storage.set(STORAGE_KEY_CREDENTIALS, JSON.stringify(updated));
      // Runners read this at every spawn (sessionEnv getter) — future sessions
      // and restarts pick the change up; already-running subprocesses keep the
      // env they were born with (matches the old bridge).
      this.storedCredentials = updated;

      const effectiveKey = process.env.ANTHROPIC_API_KEY || updated.anthropicApiKey;
      this.log(`[BridgeCore] Credentials saved (hasKey=${!!effectiveKey}, hasPat=${!!updated.githubPat})`);

      // Validate the API key with a lightweight request (ported). Network
      // errors omit keyValid rather than reporting invalid.
      let keyValid: boolean | undefined;
      if (effectiveKey) {
        try {
          const fetchFn = this.fetchFn ?? fetch;
          const res = await fetchFn('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': effectiveKey,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 1,
              messages: [{ role: 'user', content: 'hi' }],
            }),
          });
          keyValid = res.status !== 401 && res.status !== 403;
          this.log(`[BridgeCore] API key validation: status=${res.status}, valid=${keyValid}`);
        } catch (err) {
          this.log(`[BridgeCore] API key validation failed (network): ${err}`);
        }
      }

      await this.publisher.publishToPhones({
        type: 'credentials-ack',
        machine,
        success: true,
        hasAnthropicKey: !!effectiveKey,
        hasGithubPat: !!updated.githubPat,
        ...(keyValid !== undefined ? { keyValid } : {}),
      }, [phone]);
    } catch (err) {
      this.log(`[BridgeCore] Failed to save credentials: ${err}`);
      await this.publisher.publishToPhones({
        type: 'credentials-ack',
        machine,
        success: false,
        hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
        hasGithubPat: false,
        error: String(err),
      }, [phone]);
    }
  }

  // --- Custom AI provider profiles (CDX-062) ---

  /** The REDACTED wire shape of the stored profiles — `hasToken` only, the
   *  token itself NEVER leaves the bridge.
   *
   *  CDX-071 amendment: this is the ONE provider path deliberately NOT gated on
   *  isValidProviderBaseUrl. No token rides it, and hiding a legacy `http://`
   *  row would leave the operator unable to see, fix or delete the very profile
   *  that needs fixing — the exact reasoning already written into
   *  `providerProfileInfoSchema`. Every path that carries the TOKEN is gated
   *  (buildSessionEnv, handleCreateSession, the validation POST). */
  private redactedProviderProfiles(): ProviderProfileInfo[] {
    return [...this.providerProfiles.values()].map((p) => ({
      id: p.id,
      label: p.label,
      baseUrl: p.baseUrl,
      models: p.models,
      ...(p.defaultModel ? { defaultModel: p.defaultModel } : {}),
      hasToken: !!p.authToken,
    }));
  }

  private providerProfilesMessage(): { type: 'provider-profiles'; machine: string; profiles: ProviderProfileInfo[] } {
    return {
      type: 'provider-profiles',
      machine: this.host.config.machineName,
      profiles: this.redactedProviderProfiles(),
    };
  }

  /**
   * Upsert or delete one provider profile (CDX-062, D5; modeled on
   * handleSetCredentials): re-read the store corrupt-tolerantly, apply the
   * authToken tri-state (undefined=keep / null=delete / string=set) or the
   * whole-profile delete (`profile: null`), persist + update memory, validate
   * the token with a 1-token request against the profile's own base URL, ack
   * the sender, then broadcast the redacted list to ALL phones (multi-phone
   * consistency). Token values are never logged, never echoed on the wire.
   */
  private async handleSetProviderProfile(msg: SetProviderProfileMessage, phone: string): Promise<void> {
    const machine = this.host.config.machineName;
    this.log(`[BridgeCore] set-provider-profile '${msg.profileId}' from ${phone.slice(0, 8)}…`);
    try {
      let profiles: ProviderProfile[] = [];
      try {
        const raw = await this.host.storage.get(STORAGE_KEY_PROVIDER_PROFILES);
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<StoredProviderProfiles>;
          if (Array.isArray(parsed.profiles)) profiles = parsed.profiles;
        }
      } catch { /* corrupt store — start fresh */ }
      const existing = profiles.find((p) => p.id === msg.profileId);

      if (msg.profile === null) {
        // Whole-profile delete. Sessions bound to it fail loudly at their
        // next spawn (D3) — deliberately no silent fallback.
        profiles = profiles.filter((p) => p.id !== msg.profileId);
        await this.host.storage.set(
          STORAGE_KEY_PROVIDER_PROFILES,
          JSON.stringify({ profiles } satisfies StoredProviderProfiles),
        );
        this.providerProfiles = new Map(profiles.map((p) => [p.id, p]));
        this.log(`[BridgeCore] Provider profile '${msg.profileId}' deleted (existed=${!!existing})`);
        await this.publisher.publishToPhones({
          type: 'provider-profile-ack',
          machine,
          profileId: msg.profileId,
          success: true,
        }, [phone]);
        await this.publishToPhones(this.providerProfilesMessage());
        return;
      }

      // CDX-071 amendment: refuse the UPSERT (never the delete above — a legacy
      // row must stay removable) when the base URL fails the shared rule.
      // UNREACHABLE OVER THE WIRE TODAY and deliberately kept: `decodePhoneToBridge`
      // rejects such a payload first, so this is the second layer. It makes "the
      // bridge never PERSISTS an insecure profile" a property of the STORE rather
      // than of the schema — relaxing `providerBaseUrlSchema` can then never
      // silently re-open the validation POST below, which puts the stored token on
      // the wire as `Authorization: Bearer` against this very URL. Covered by a
      // direct-call test (an uncovered security guard rots).
      if (!isValidProviderBaseUrl(msg.profile.baseUrl)) {
        this.log(
          `[BridgeCore] Provider profile '${msg.profileId}' refused: insecure base URL (${msg.profile.baseUrl})`,
        );
        await this.publisher.publishToPhones({
          type: 'provider-profile-ack',
          machine,
          profileId: msg.profileId,
          success: false,
          error: PROVIDER_BASE_URL_ERROR,
        }, [phone]);
        return;
      }

      // Upsert; authToken tri-state mirrors set-credentials.
      const token =
        msg.profile.authToken === undefined
          ? existing?.authToken
          : msg.profile.authToken === null
            ? undefined
            : msg.profile.authToken;
      const updated: ProviderProfile = {
        id: msg.profileId,
        label: msg.profile.label,
        baseUrl: msg.profile.baseUrl,
        ...(token ? { authToken: token } : {}),
        models: msg.profile.models,
        ...(msg.profile.defaultModel ? { defaultModel: msg.profile.defaultModel } : {}),
        updatedAt: new Date(this.now()).toISOString(),
      };
      profiles = profiles.filter((p) => p.id !== msg.profileId);
      profiles.push(updated);
      await this.host.storage.set(
        STORAGE_KEY_PROVIDER_PROFILES,
        JSON.stringify({ profiles } satisfies StoredProviderProfiles),
      );
      // Runners look this map up at every spawn — future sessions and restarts
      // pick the change up; running subprocesses keep the env they were born with.
      this.providerProfiles = new Map(profiles.map((p) => [p.id, p]));
      this.log(
        `[BridgeCore] Provider profile saved: '${updated.id}' ("${updated.label}", ${updated.baseUrl}, ${updated.models.length} model(s), hasToken=${!!token})`,
      );

      // Validate the token with a 1-token request against the provider's own
      // /v1/messages (D5). Network errors omit tokenValid (same tri-state as
      // credentials-ack.keyValid).
      let tokenValid: boolean | undefined;
      if (token) {
        try {
          const fetchFn = this.fetchFn ?? fetch;
          const res = await fetchFn(`${updated.baseUrl.replace(/\/+$/, '')}/v1/messages`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              model: updated.defaultModel ?? updated.models[0]!.id,
              max_tokens: 1,
              messages: [{ role: 'user', content: 'hi' }],
            }),
          });
          tokenValid = res.status !== 401 && res.status !== 403;
          this.log(`[BridgeCore] Provider token validation ('${updated.id}'): status=${res.status}, valid=${tokenValid}`);
        } catch (err) {
          this.log(`[BridgeCore] Provider token validation failed (network): ${err}`);
        }
      }

      await this.publisher.publishToPhones({
        type: 'provider-profile-ack',
        machine,
        profileId: msg.profileId,
        success: true,
        ...(tokenValid !== undefined ? { tokenValid } : {}),
      }, [phone]);
      // Broadcast the redacted list to ALL phones so every paired device
      // converges on the same profile set.
      await this.publishToPhones(this.providerProfilesMessage());
    } catch (err) {
      this.log(`[BridgeCore] Failed to save provider profile: ${err}`);
      await this.publisher.publishToPhones({
        type: 'provider-profile-ack',
        machine,
        profileId: msg.profileId,
        success: false,
        error: String(err),
      }, [phone]);
    }
  }

  /**
   * Persist a phone's device config: per-phone in host storage, plus the
   * workspace `.codedeck/device-config.json` the autonomous test-session
   * reads (ported). For a 'test-target' phone this is also where the bridge
   * does the formerly-manual mesh onboarding (Phase 5d, closing the CDX-005
   * deferral), with ZERO operator/CLI involvement:
   *
   * IMPORTANT: the phone's mesh VpnService runs its OWN nostr key, separate
   * from the bridge-pairing key — the bridge canNOT derive the phone's mesh
   * IP from the pairing pubkey. The phone reports its real mesh identity
   * (`meshIp` + `meshPubkey`, read from the engine's own state). The bridge:
   *   1. Authorizes the reported MESH pubkey on the roster AND publishes the
   *      signed roster (`nvpn add-device --device <pk> --publish`) —
   *      idempotent, best-effort. The publish is what actually reaches the
   *      phone (CDX-028: the old flow omitted it, so roster changes never
   *      propagated).
   *   2. Sets the adb serial to `<meshIp>:0` (port 0 → deviceActions'
   *      ensureConnected/discoverAdbPort sweeps for the rotating
   *      Wireless-Debugging port at connect time). No mesh IP:port typed.
   *   3. Warns if the local nvpn daemon is down (roster change won't
   *      propagate to the phone until it reloads).
   * Transport-only fields (meshIp/meshPubkey) are stripped before persisting.
   */
  private async handleSetDeviceConfig(msg: SetDeviceConfigMessage, phone: string): Promise<void> {
    const config = { ...msg.config };
    try {
      if (config.role === 'test-target') {
        const label = config.label || 'phone';
        // The identity to authorize on the mesh is the phone's MESH pubkey
        // (reported), NOT the bridge-pairing pubkey. Fall back to the pairing
        // pubkey only if the phone didn't report one (older app) — that is
        // only correct if the two keys happen to coincide.
        const meshPubkey = config.meshPubkey || phone;
        if (!config.meshPubkey) {
          this.log(
            '[BridgeCore] Phone did not report a mesh pubkey — falling back to the pairing pubkey (may be wrong)',
          );
        }

        // 1. Authorize on the mesh roster + publish the signed roster
        //    (best-effort; idempotent; no-op when nvpn is absent).
        if (this.meshAdmin.available) {
          const added = await this.meshAdmin.addDevice(meshPubkey);
          if (added.ok) {
            this.log(
              `[BridgeCore] Authorized test device on mesh roster (published): ${meshPubkey.slice(0, 12)}…`,
            );
            if (await this.meshAdmin.daemonRunning()) {
              this.host.notify('info', `Test device "${label}" authorized on the mesh.`);
            } else {
              this.host.notify(
                'warn',
                `Mesh roster updated for "${label}", but the nvpn service isn't running — start it on this machine to finish authorizing the device.`,
              );
            }
          } else if (added.notAdmin) {
            // nvpn's "active network is not administered by this device" —
            // actionable, distinct from a generic failure.
            this.log(
              `[BridgeCore] add-device refused — this machine is not an admin of the active nvpn network: ${added.error}`,
            );
            this.host.notify(
              'warn',
              `Couldn't authorize "${label}" on the mesh: this machine is not an admin of the active nvpn network. Run the pairing from the network's admin machine, or make this device an admin.`,
            );
          } else {
            this.log(
              `[BridgeCore] add-device failed — test device not authorized on mesh: ${added.error}`,
            );
            this.host.notify(
              'warn',
              `Couldn't authorize "${label}" on the mesh (is an nvpn network active?).`,
            );
          }
        } else {
          this.log(
            '[BridgeCore] nvpn unavailable — test device not authorized on mesh (see MeshAdmin startup log)',
          );
        }

        // 2. Build the adb serial from the phone's REAL reported mesh IP (authoritative).
        if (!config.serial && config.meshIp && /^10\.44\.\d{1,3}\.\d{1,3}$/.test(config.meshIp)) {
          config.serial = `${config.meshIp}:0`;
          this.log(`[BridgeCore] Test-device mesh serial (phone-reported): ${config.serial}`);
        } else if (!config.serial) {
          // Legacy fallback: derive from the mesh/pairing pubkey (only correct
          // when the mesh key equals the pairing key).
          const ip = await this.meshAdmin.derivePeerIp(meshPubkey);
          if (ip) {
            config.serial = `${ip}:0`;
            this.log(`[BridgeCore] Test-device mesh serial (derived fallback): ${config.serial}`);
          } else {
            this.log('[BridgeCore] No mesh IP reported and could not derive one — serial left unset');
          }
        }
      }

      // Strip transport-only fields before persisting (ported).
      const { meshIp: _mi, meshPubkey: _mp, ...persisted } = config;

      await this.host.storage.set(
        `${STORAGE_KEY_DEVICE_CONFIG_PREFIX}${phone}`,
        JSON.stringify(persisted),
      );
      const dir = path.join(this.workspaceRoots()[0]!, '.codedeck');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'device-config.json'), JSON.stringify(persisted, null, 2));
      this.log(
        `[BridgeCore] Device config saved: ${persisted.label} (${persisted.serial ?? 'no serial'}, app=${persisted.appUnderTest}, role=${persisted.role ?? 'controller'})`,
      );
      await this.publisher.publishToPhones({ type: 'device-config-ack', success: true }, [phone]);
    } catch (err) {
      this.log(`[BridgeCore] Failed to save device config: ${err}`);
      await this.publisher.publishToPhones(
        { type: 'device-config-ack', success: false, error: String(err) },
        [phone],
      );
    }
  }

  // --- Runner wiring ---

  private makeRunner(opts: {
    sessionId: string;
    cwd: string;
    model?: string;
    /** CDX-062: bind the session to a stored custom provider profile. */
    providerId?: string;
    effortLevel?: CreateSessionMessage['defaultEffort'];
    testSession?: boolean;
    resume?: boolean;
  }): SessionRunner {
    // Test sessions get the on-device adb MCP tools (install/launch/logcat/
    // screenshot/tap/...). Normal coding sessions do NOT, keeping device
    // control off the default surface (ported gate). Screenshots are
    // downscaled + delivered to the phone inline via the session's transcript
    // (unique seq — same path as permission cards).
    const mcpServers = opts.testSession
      ? {
          device: createDeviceMcpServer({
            actions: this.deviceActions,
            artifactDir: path.join(os.tmpdir(), 'codedeck-device-artifacts'),
            onScreenshot: async (artifactPath, serial) => {
              const built = buildScreenshotEntry(artifactPath, serial);
              if (!built) return 'capture saved but image could not be read';
              const runner = this.runners.get(opts.sessionId);
              if (!runner) return 'capture saved but session is gone';
              await runner.appendEntry(built.entry);
              // Best-effort cleanup of the on-disk artifact (already delivered).
              try {
                fs.unlinkSync(artifactPath);
              } catch {
                /* ignore */
              }
              return `delivered to phone (${Math.round(built.sizeBytes / 1024)} KB)`;
            },
          }),
        }
      : undefined;
    return new SessionRunner({
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      facade: this.facade,
      transcript: this.transcript,
      registry: this.registry,
      broker: this.broker,
      events: this.runnerEvents(),
      permissionMode: 'plan',
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.providerId ? { providerId: opts.providerId } : {}),
      ...(opts.effortLevel ? { effortLevel: opts.effortLevel } : {}),
      ...(opts.testSession ? { testSession: true } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(opts.resume ? { resume: true } : {}),
      ...(this.host.config.claudePath
        ? { pathToClaudeCodeExecutable: this.host.config.claudePath }
        : {}),
      ...(this.gitHead ? { gitHead: this.gitHead } : {}),
      // Stored credentials → subprocess env at EVERY spawn (CDX-011). A getter
      // so mid-life set-credentials reaches restarts too. CDX-062: the LIVE
      // profile is resolved per spawn from the runner's provider binding —
      // token rotation reaches restarts; a bound-but-deleted profile THROWS
      // (the runner fails the spawn loudly, never a silent Anthropic fallback).
      sessionEnv: (ctx) => {
        if (!ctx.providerId) return buildSessionEnv(this.storedCredentials);
        const profile = this.providerProfiles.get(ctx.providerId);
        if (!profile) {
          throw new Error(`provider profile '${ctx.providerId}' was deleted`);
        }
        return buildSessionEnv(this.storedCredentials, profile);
      },
      // CDX-050: diff cards, evaluated per SDK message against the live
      // phone-capability registry.
      emitDiffEntries: () => this.phonesSupportDiff(),
    });
  }

  /**
   * CDX-050: may the adapter emit `entryType: 'diff'` entries? Only when at
   * least one phone has sent a command this boot AND every phone heard from
   * advertised the 'diff' capability — one pre-CDX-050 phone in the fleet
   * (recorded as `[]`) keeps it off, because such a phone hard-fails zod on
   * the unknown entryType and would drop whole output/sync-chunk messages.
   */
  private phonesSupportDiff(): boolean {
    if (this.phoneCaps.size === 0) return false;
    for (const caps of this.phoneCaps.values()) {
      if (!caps.includes(CAPABILITIES.diff)) return false;
    }
    return true;
  }

  private runnerEvents(): SessionRunnerEvents {
    return {
      onOutput: (sessionId, entries) => {
        void (async () => {
          for (const { seq, entry } of entries) {
            await this.publishToPhones({ type: 'output', sessionId, seq, entry });
          }
        })();
      },
      onReady: (sessionId) => {
        void (async () => {
          const session = this.sessionInfo(sessionId);
          if (session) {
            await this.publishToPhones({ type: 'session-ready', pendingId: sessionId, session });
          }
          await this.publishSessionList();
        })();
      },
      onFailed: (sessionId, reason) => {
        this.runners.delete(sessionId);
        void this.publishToPhones({ type: 'session-failed', pendingId: sessionId, reason });
      },
      onStateChanged: () => {
        void this.publishSessionList();
      },
      onModeChanged: (sessionId, mode) => {
        void this.publishToPhones({ type: 'mode-confirmed', sessionId, mode });
      },
      onEnded: (sessionId) => {
        this.runners.delete(sessionId);
        void this.publishSessionList();
      },
      log: this.log,
    };
  }

  /** Permission card → out-of-band system entry through the transcript (unique
   *  seq — the CDB-025 fix now structural). Entry shape ported from old core.ts. */
  private publishPermissionCard(card: PermissionCard): void {
    const runner = this.runners.get(card.sessionId);
    if (!runner) {
      this.log(`[BridgeCore] Permission card for unknown session ${card.sessionId} — dropped`);
      return;
    }
    void runner.appendEntry({
      entryType: 'system',
      content: card.title || `Permission needed: ${card.toolName}`,
      timestamp: new Date().toISOString(),
      metadata: {
        special: 'permission_request',
        tool_name: card.toolName,
        tool_use_id: card.toolUseId,
        tool_input: card.toolInput,
        description: card.description,
        subagent: card.isSubAgent || undefined,
        agent_id: card.agentId,
        agent_label: card.agentLabel,
      },
    }).catch((err) => {
      this.log(`[BridgeCore] Failed to publish permission card: ${err}`);
    });
  }

  // --- Helpers ---

  private phonePubkeys(): string[] {
    return this.paired.map((p) => p.pubkeyHex);
  }

  private publishToPhones(
    msg: Parameters<Publisher['publishToPhones']>[0],
  ): Promise<boolean> {
    return this.publisher.publishToPhones(msg, this.phonePubkeys());
  }

  private workspaceRoots(): string[] {
    const roots = this.host.config.workspaceRoots;
    return roots.length > 0 ? [...roots] : [process.cwd()];
  }

  /** Workspace project folders for the phone's picker, memoized (ported). */
  private workspaceFolders(): string[] {
    const now = this.now();
    if (this.folderCache && now - this.folderCache.at < FOLDER_CACHE_TTL_MS) {
      return this.folderCache.folders;
    }
    const folders = listAllWorkspaceFolders(this.workspaceRoots(), this.log);
    this.folderCache = { folders, at: now };
    return folders;
  }

  private async loadPairedPhones(): Promise<PairedPhone[]> {
    try {
      const raw = await this.host.storage.get(STORAGE_KEY_PAIRED_PHONES);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (p): p is PairedPhone =>
          typeof p === 'object' && p !== null &&
          typeof (p as PairedPhone).pubkeyHex === 'string',
      );
    } catch (err) {
      this.log(`[BridgeCore] Failed to load paired phones: ${err}`);
      return [];
    }
  }

  private async savePairedPhones(): Promise<void> {
    await this.host.storage.set(STORAGE_KEY_PAIRED_PHONES, JSON.stringify(this.paired));
  }

  /** Persist the ingest cursor so a restart can resubscribe without a gap, and
   *  the dedup ids so the `since` grace window's replay is a no-op. */
  private async persistCursor(): Promise<void> {
    try {
      await this.host.storage.set(
        STORAGE_KEY_LAST_SEEN,
        String(this.ingest.lastSeenTimestamp),
      );
      await this.host.storage.set(
        STORAGE_KEY_PROCESSED_IDS,
        JSON.stringify(this.ingest.processedIds()),
      );
    } catch (err) {
      this.log(`[BridgeCore] Failed to persist ingest cursor: ${err}`);
    }
  }

  private async loadProcessedIds(): Promise<string[]> {
    try {
      const raw = await this.host.storage.get(STORAGE_KEY_PROCESSED_IDS);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
    } catch (err) {
      this.log(`[BridgeCore] Failed to load processed event ids: ${err}`);
      return [];
    }
  }

  private readonly log = (msg: string): void => {
    this.host.log('info', msg);
  };
}
