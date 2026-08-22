/**
 * The host interface — the ONE seam between the headless bridge engine and
 * whatever binary hosts it (VSCode extension, `codedeck-bridge` CLI, systemd
 * service). Hosts implement this; everything else lives in @codedeck/core.
 *
 * Design rule (learned from the old bridge): host code is untestable, so keep
 * it razor-thin. If a piece of logic doesn't NEED a host API, it belongs in
 * core behind this interface.
 */
import type { BridgeHostKind } from '@codedeck/protocol';

export interface BridgeConfig {
  /** Display name for this machine (NIP-33 d-tag of the session list). */
  machineName: string;
  /** Which host binary is running — UI badge on the phone. */
  host: BridgeHostKind;
  /** Relay URLs. First entry is treated as primary. User-extendable. */
  relays: string[];
  /** Directories sessions may be rooted in. First entry is the default. */
  workspaceRoots: string[];
  /** Admin endpoint for registering paired pubkeys on a restricted relay (optional). */
  relayRegisterEndpoint?: string;
  relayRegisterToken?: string;
  /**
   * CDX-093: the same admin contract on the Blossom media server (optional).
   *
   * Registering separately rather than relying on the shared `accounts` KV is
   * deliberate. Both servers read one namespace, so relay registration happened
   * to grant Blossom uploads too — until relay2 went open-write and Blossom did
   * not, at which point image upload 403'd for every install and nothing
   * surfaced it. An explicit endpoint keeps this fleet working whatever either
   * server's write policy is set to next.
   */
  blossomRegisterEndpoint?: string;
  blossomRegisterToken?: string;
  /** Explicit path to the `claude` executable; otherwise resolved from PATH. */
  claudePath?: string;
  /** Explicit path to the `nvpn` CLI (mesh admin). Otherwise resolved from
   *  CODEDECK_NVPN_PATH + well-known install locations; when nothing resolves,
   *  mesh onboarding is disabled with an actionable log. */
  nvpnPath?: string;
  /** Force-disable mesh admin even when nvpn is present (default: enabled). */
  meshAdminEnabled?: boolean;
  /** Explicit path to `adb` for on-device test sessions. Otherwise
   *  CODEDECK_ADB_PATH or ~/Android/Sdk/platform-tools/adb. */
  adbPath?: string;
  /** CDX-013 retention: per-session transcript entry cap enforced by the
   *  boot + daily sweep. Default DEFAULT_TRANSCRIPT_KEEP_LAST (5000);
   *  0 disables pruning entirely. */
  transcriptKeepLast?: number;
}

export interface KeyValueStorage {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface PairingPayload {
  /** codedeck://pair?... deep link (QR content). */
  url: string;
  /** Same link with the mesh invite secret redacted — what hosts must RENDER
   *  as text (CDX-013: the full URL is for the QR / explicit copy action only,
   *  never for passive display). Absent only in legacy test fixtures. */
  displayUrl?: string;
  /** Human-readable expiry, for display beside the QR. */
  expiresAt: Date;
}

export interface PairingHandle {
  /** Close/revoke the pairing window (user closed the panel, or it expired). */
  close(): void;
}

export interface BridgeHost {
  readonly config: BridgeConfig;
  /** Secrets + small state (bridge nsec, paired phones, cursors). Host decides
   *  where it lives: VSCode globalState or a 0600 state file. */
  readonly storage: KeyValueStorage;
  /** Directory for the session registry + transcripts. Must exist and be private. */
  sessionStateDir(): string;
  log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void;
  /** User-facing notice (stderr line / showInformationMessage). */
  notify(level: 'info' | 'warn' | 'error', msg: string): void;
  /** Render a pairing QR (webview / terminal). */
  presentPairing(payload: PairingPayload): PairingHandle;
  /** Register a shutdown hook (SIGTERM / deactivate). */
  onShutdown(fn: () => Promise<void> | void): void;
}
