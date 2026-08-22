/**
 * Mesh admin — thin wrapper around the local `nvpn` CLI so the bridge can wire
 * phone onboarding into the nostr-vpn mesh WITHOUT the operator running any
 * CLI by hand. Ported from codedeck-bridge-vscode/src/meshAdmin.ts (Phase 5d),
 * with one rebuild delta: the exec call is an injectable seam (`ExecFn`) so
 * tests fake nvpn instead of vi.mock'ing child_process.
 *
 * CDX-028: nvpn 4.1.x REMOVED the bearer-invite flow (`create-invite` /
 * `import-invite` / `nvpn://invite/…` are gone). Onboarding is now the
 * MANUAL-JOIN flow:
 *   1. The bridge publishes two public strings — the active `network_id` and
 *      this machine's admin `device_id` (npub) — both read from
 *      `nvpn status --json` (see onboardingInfo()). They ride the pairing QR.
 *   2. The phone's engine runs the equivalent of `nvpn join-manual
 *      --admin-device-id <npub> --network-id <id>` (the app core's
 *      `manual_add_network` action) and waits for a signed roster.
 *   3. When the phone reports its mesh pubkey (set-device-config), the bridge
 *      runs `nvpn add-device --device <pk> --publish` — the `--publish` is what
 *      signs + pushes the roster to the relays so the phone actually comes up.
 *
 * Jobs, each a single `execFile('nvpn', ...)` call (argv array — no shell, no
 * interpolation), mirroring how deviceActions isolates adb:
 *   - onboardingInfo():    read {networkId, adminDeviceId} for the pairing QR.
 *   - addDevice(pk):       authorize a phone on the active network roster AND
 *                          publish the signed roster (idempotent). Requires
 *                          admin rights on the active network — a non-admin
 *                          failure is surfaced distinctly (`notAdmin`).
 *   - derivePeerIp(pk):    resolve a phone's DETERMINISTIC mesh tunnel IP from
 *                          its pubkey (`10.44.x.y`) — legacy fallback when the
 *                          phone didn't report its real mesh IP.
 *   - daemonRunning():     is the local nvpn daemon up? (roster propagation
 *                          needs it.)
 *
 * Every call is best-effort: if `nvpn` is absent (no mesh on this host) or the
 * command fails, the helper returns null/failed and the caller degrades
 * gracefully (pure-pairing QR still works). The binary is resolved from
 * CODEDECK_NVPN_PATH / config, then well-known absolute install locations,
 * then bare PATH — the absolute lookups matter because a snap/flatpak VSCode
 * extension host runs with a sanitized PATH that does NOT include
 * ~/.cargo/bin (where `nvpn install-cli` puts it).
 */

import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Cap any single nvpn call. */
const NVPN_TIMEOUT_MS = 15_000;
/** `add-device --publish` does a relay round-trip (sign + push the roster) —
 *  give it more headroom than a local status read. */
const NVPN_PUBLISH_TIMEOUT_MS = 45_000;
const NVPN_MAX_BUFFER = 1024 * 1024;

/** nvpn's error when this machine lacks admin rights on the active network. */
const NOT_ADMIN_RE = /active network is not administered by this device/i;

/** Phone pubkey: 64 hex chars OR a bech32 npub. Validated before any exec so a
 *  crafted pubkey can never become extra argv / a flag. */
const PUBKEY_RE = /^(?:[0-9a-fA-F]{64}|npub1[023456789acdefghjklmnpqrstuvwxyz]{6,})$/;

function isValidPubkey(pubkey: string): boolean {
  return PUBKEY_RE.test((pubkey || '').trim());
}

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface ExecOpts {
  /** Per-call timeout override (ms). Default NVPN_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** The exec seam: run a binary with an argv array (NO shell). Injectable for
 *  tests (2-arg fakes remain assignable — `opts` is optional). */
export type ExecFn = (file: string, args: string[], opts?: ExecOpts) => Promise<ExecResult>;

/** Production exec: child_process.execFile with timeout + buffer caps (ported). */
export const realExec: ExecFn = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: opts?.timeoutMs ?? NVPN_TIMEOUT_MS,
        maxBuffer: NVPN_MAX_BUFFER,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout ?? '').trim(),
          stderr: err
            ? `${String(stderr ?? '')}${err.message ? `\n${err.message}` : ''}`
            : String(stderr ?? ''),
        });
      },
    );
  });

/** The two PUBLIC strings a joiner needs for nvpn's manual-join flow. They ride
 *  the pairing QR (`netid` + `meshadmin` params) — nothing here is secret. */
export interface MeshOnboardingInfo {
  /** The active network id (e.g. "a237c978"). */
  networkId: string;
  /** This (admin) machine's mesh device id — an npub. */
  adminDeviceId: string;
}

export type AddDeviceResult =
  | { ok: true }
  | {
      ok: false;
      /** nvpn refused because this machine is not an admin of the active
       *  network — actionable, surfaced distinctly from a generic failure. */
      notAdmin: boolean;
      error: string;
    };

/** The mesh-admin seam BridgeCore consumes. All methods are best-effort. */
export interface MeshAdmin {
  /** False ⇒ nvpn was not found (or mesh admin disabled) — every call no-ops. */
  readonly available: boolean;
  /** Read {networkId, adminDeviceId} from `status --json` for the pairing QR. */
  onboardingInfo(): Promise<MeshOnboardingInfo | null>;
  activeNetworkId(): Promise<string | null>;
  /** `add-device --device <pk> --publish` — roster add + signed-roster publish. */
  addDevice(pubkey: string): Promise<AddDeviceResult>;
  derivePeerIp(pubkey: string): Promise<string | null>;
  daemonRunning(): Promise<boolean>;
}

/**
 * Resolve the nvpn binary: explicit path → CODEDECK_NVPN_PATH → known absolute
 * install locations → null (NOT bare PATH: "default off if nvpn absent" — we
 * only fall back to PATH when the caller explicitly enables mesh admin without
 * a resolvable path, which keeps the old always-try behaviour reachable).
 */
export function resolveNvpnPath(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
): string | null {
  const candidates = [
    explicit,
    env.CODEDECK_NVPN_PATH,
    path.join(homedir, '.cargo', 'bin', 'nvpn'), // default cargo/`nvpn install-cli` location
    path.join(homedir, '.local', 'bin', 'nvpn'),
    '/usr/local/bin/nvpn',
    '/usr/bin/nvpn',
  ].filter((c): c is string => typeof c === 'string' && c.length > 0);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export interface MeshAdminOptions {
  /** Explicit nvpn binary path (host config). Wins over env/known locations. */
  nvpnPath?: string;
  /** Force-disable mesh admin regardless of nvpn presence. Default: enabled
   *  when nvpn resolves, disabled (with an actionable log) when it doesn't. */
  enabled?: boolean;
  /** Injectable exec seam for tests. */
  exec?: ExecFn;
  log?: (msg: string) => void;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
}

/** A MeshAdmin whose every call no-ops (nvpn absent or mesh admin disabled). */
export function disabledMeshAdmin(): MeshAdmin {
  return {
    available: false,
    onboardingInfo: async () => null,
    activeNetworkId: async () => null,
    addDevice: async () => ({ ok: false, notAdmin: false, error: 'mesh admin unavailable' }),
    derivePeerIp: async () => null,
    daemonRunning: async () => false,
  };
}

/**
 * Build the mesh admin. When nvpn cannot be resolved (and no test exec is
 * injected) this returns the disabled no-op admin and logs ONE actionable line
 * — mesh onboarding silently degrading was the old failure mode we keep, but
 * now it says why.
 */
export function createMeshAdmin(opts: MeshAdminOptions = {}): MeshAdmin {
  const log = opts.log ?? (() => {});
  if (opts.enabled === false) {
    log('[MeshAdmin] mesh admin disabled by config — pairing QRs will not carry mesh join info');
    return disabledMeshAdmin();
  }

  const exec = opts.exec ?? realExec;
  // With an injected exec (tests) the binary name is never dereferenced.
  const nvpn = opts.exec
    ? (opts.nvpnPath ?? 'nvpn')
    : resolveNvpnPath(opts.nvpnPath, opts.env, opts.homedir);
  if (!nvpn) {
    log(
      '[MeshAdmin] nvpn not found — mesh onboarding disabled. Install the nostr-vpn CLI ' +
        '(`cargo install --path nostr-vpn-cli` / `nvpn install-cli`) or set CODEDECK_NVPN_PATH ' +
        'or config `nvpnPath` to enable mesh join info in pairing QRs + test-device roster onboarding.',
    );
    return disabledMeshAdmin();
  }

  const run = (args: string[], execOpts?: ExecOpts): Promise<ExecResult> =>
    exec(nvpn, args, execOpts);

  const statusJson = async (): Promise<Record<string, unknown> | null> => {
    const r = await run(['status', '--json']);
    if (!r.ok) return null;
    try {
      return JSON.parse(r.stdout) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const activeNetworkId = async (): Promise<string | null> => {
    const parsed = await statusJson();
    const id = parsed?.network_id ?? parsed?.networkId;
    return typeof id === 'string' && id ? id : null;
  };

  return {
    available: true,

    async onboardingInfo() {
      const parsed = await statusJson();
      if (!parsed) return null;
      const networkId = parsed.network_id;
      const adminDeviceId = parsed.device_id;
      if (typeof networkId !== 'string' || !networkId) return null;
      if (typeof adminDeviceId !== 'string' || !adminDeviceId.startsWith('npub1')) return null;
      return { networkId, adminDeviceId };
    },

    activeNetworkId,

    async addDevice(pubkey: string) {
      if (!isValidPubkey(pubkey)) {
        return { ok: false, notAdmin: false, error: 'invalid pubkey' };
      }
      // --publish is load-bearing: without it the roster change stays local and
      // never reaches the phone. Relay round-trip ⇒ the longer timeout.
      const r = await run(
        ['add-device', '--device', pubkey.trim(), '--publish', '--json'],
        { timeoutMs: NVPN_PUBLISH_TIMEOUT_MS },
      );
      if (r.ok) return { ok: true };
      const combined = `${r.stderr}\n${r.stdout}`;
      return {
        ok: false,
        notAdmin: NOT_ADMIN_RE.test(combined),
        error: (r.stderr || r.stdout).trim() || 'nvpn add-device failed',
      };
    },

    async derivePeerIp(pubkey: string) {
      if (!isValidPubkey(pubkey)) return null;
      const r = await run(['ip', '--device', pubkey.trim(), '--peer', '--json']);
      if (!r.ok) return null;
      try {
        const arr = JSON.parse(r.stdout) as unknown;
        const first = Array.isArray(arr) ? arr[0] : arr;
        if (typeof first !== 'string') return null;
        const ip = first.split('/')[0]!.trim();
        return /^10\.44\.\d{1,3}\.\d{1,3}$/.test(ip) ? ip : null;
      } catch {
        return null;
      }
    },

    async daemonRunning() {
      const parsed = await statusJson();
      // `nvpn status --json` reports the persistent daemon under
      // `daemon.running` — the daemon is what re-publishes the signed roster
      // on reload, so its liveness gates whether a just-added device
      // actually propagates to the phone.
      return (parsed?.daemon as { running?: boolean } | undefined)?.running === true;
    },
  };
}
