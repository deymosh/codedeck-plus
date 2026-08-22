/**
 * CLI configuration resolution (CDB-036): flags > CODEDECK_* env >
 * `$CODEDECK_HOME/config.json` (default `~/.codedeck/config.json`) > defaults.
 *
 * Same key names as the old VSCode `codedeck.*` settings; the host kind is
 * 'cli', or 'service' when running under systemd (INVOCATION_ID) or --service.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_RELAYS } from '@codedeck/protocol';
import type { BridgeConfig } from '@codedeck/core';

/** Parsed command-line flags relevant to configuration. */
export interface CliFlags {
  home?: string;
  machineName?: string;
  /** Repeatable --relay. */
  relays?: string[];
  /** Repeatable --workspace. */
  workspaces?: string[];
  claudePath?: string;
  relayRegisterEndpoint?: string;
  relayRegisterToken?: string;
  blossomRegisterEndpoint?: string;
  blossomRegisterToken?: string;
  service?: boolean;
  /** SOCKS5 proxy URL for all relay connections (e.g. a local Tor daemon). */
  torProxy?: string;
}

/** Shape of `$CODEDECK_HOME/config.json` (all optional). */
interface FileConfig {
  machineName?: string;
  relays?: string[];
  workspaceRoots?: string[];
  relayRegisterEndpoint?: string;
  relayRegisterToken?: string;
  /** CDX-093: same admin contract on the Blossom media server. */
  blossomRegisterEndpoint?: string;
  blossomRegisterToken?: string;
  claudePath?: string;
  /** Mesh admin (Phase 5d): explicit `nvpn` binary path + enable flag. When
   *  nvpn can't be resolved at all, mesh onboarding is off with a log line. */
  nvpnPath?: string;
  meshAdminEnabled?: boolean;
  /** adb binary for on-device test sessions. */
  adbPath?: string;
  /** CDX-013: per-session transcript entry cap (0 disables pruning). */
  transcriptKeepLast?: number;
  /** SOCKS5 proxy URL for all relay connections (e.g. socks5h://127.0.0.1:9050). */
  torProxyUrl?: string;
}

export interface ResolvedCliConfig {
  /** The CODEDECK_HOME directory (config.json, state.json, lock, session state). */
  homeDir: string;
  configFile: string;
  configFileExists: boolean;
  config: BridgeConfig;
}

export function resolveHomeDir(flags: CliFlags = {}, env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(
    flags.home ?? env.CODEDECK_HOME ?? path.join(os.homedir(), '.codedeck'),
  );
}

function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value.split(',').map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function nonEmpty(list: string[] | undefined): string[] | undefined {
  return Array.isArray(list) && list.length > 0 ? list : undefined;
}

export function loadCliConfig(
  flags: CliFlags = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCliConfig {
  const homeDir = resolveHomeDir(flags, env);
  const configFile = path.join(homeDir, 'config.json');

  let file: FileConfig = {};
  const configFileExists = fs.existsSync(configFile);
  if (configFileExists) {
    // CDX-013: config.json can hold the relay ADMIN bearer token. Tighten it
    // (and the home dir — mkdirSync's mode never tightens an EXISTING dir) the
    // same way state.json is tightened on load. Best-effort: read-only
    // filesystems must not break config loading.
    try { fs.chmodSync(configFile, 0o600); } catch { /* best-effort */ }
    try { fs.chmodSync(homeDir, 0o700); } catch { /* best-effort */ }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch (err) {
      throw new Error(`invalid JSON in ${configFile}: ${err instanceof Error ? err.message : err}`);
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`invalid config in ${configFile}: expected a JSON object`);
    }
    file = raw as FileConfig;
  }

  const host: BridgeConfig['host'] = flags.service || env.INVOCATION_ID ? 'service' : 'cli';

  const machineName =
    flags.machineName ?? env.CODEDECK_MACHINE_NAME ?? file.machineName ?? `${os.hostname()} (${host})`;

  const relays =
    nonEmpty(flags.relays) ?? splitList(env.CODEDECK_RELAYS) ?? nonEmpty(file.relays) ?? [...DEFAULT_RELAYS];

  const workspaceRoots = (
    nonEmpty(flags.workspaces) ??
    splitList(env.CODEDECK_WORKSPACE_ROOTS) ??
    nonEmpty(file.workspaceRoots) ?? [process.cwd()]
  ).map((p) => path.resolve(p));

  const claudePath = flags.claudePath ?? env.CODEDECK_CLAUDE_PATH ?? file.claudePath;
  const nvpnPath = env.CODEDECK_NVPN_PATH ?? file.nvpnPath;
  const adbPath = env.CODEDECK_ADB_PATH ?? file.adbPath;
  const meshAdminEnabled =
    env.CODEDECK_MESH_ADMIN !== undefined
      ? env.CODEDECK_MESH_ADMIN !== '0' && env.CODEDECK_MESH_ADMIN !== 'false'
      : file.meshAdminEnabled;
  const relayRegisterEndpoint =
    flags.relayRegisterEndpoint ?? env.CODEDECK_RELAY_REGISTER_ENDPOINT ?? file.relayRegisterEndpoint;
  const relayRegisterToken =
    flags.relayRegisterToken ?? env.CODEDECK_RELAY_REGISTER_TOKEN ?? file.relayRegisterToken;
  const blossomRegisterEndpoint =
    flags.blossomRegisterEndpoint ??
    env.CODEDECK_BLOSSOM_REGISTER_ENDPOINT ??
    file.blossomRegisterEndpoint;
  const blossomRegisterToken =
    flags.blossomRegisterToken ?? env.CODEDECK_BLOSSOM_REGISTER_TOKEN ?? file.blossomRegisterToken;
  const transcriptKeepLastRaw = env.CODEDECK_TRANSCRIPT_KEEP_LAST ?? file.transcriptKeepLast;
  const transcriptKeepLast =
    transcriptKeepLastRaw !== undefined && Number.isFinite(Number(transcriptKeepLastRaw))
      ? Math.max(0, Math.floor(Number(transcriptKeepLastRaw)))
      : undefined;
  const torProxyUrl = flags.torProxy ?? env.CODEDECK_TOR_PROXY_URL ?? file.torProxyUrl;

  return {
    homeDir,
    configFile,
    configFileExists,
    config: {
      machineName,
      host,
      relays: [...relays],
      workspaceRoots,
      ...(claudePath ? { claudePath } : {}),
      ...(nvpnPath ? { nvpnPath } : {}),
      ...(adbPath ? { adbPath } : {}),
      ...(meshAdminEnabled !== undefined ? { meshAdminEnabled } : {}),
      ...(relayRegisterEndpoint ? { relayRegisterEndpoint } : {}),
      ...(relayRegisterToken ? { relayRegisterToken } : {}),
      ...(blossomRegisterEndpoint ? { blossomRegisterEndpoint } : {}),
      ...(blossomRegisterToken ? { blossomRegisterToken } : {}),
      ...(transcriptKeepLast !== undefined ? { transcriptKeepLast } : {}),
      ...(torProxyUrl ? { torProxyUrl } : {}),
    },
  };
}
