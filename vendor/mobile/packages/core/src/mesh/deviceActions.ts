/**
 * Device actions — deterministic adb operations for on-device test sessions.
 * Ported from codedeck-bridge-vscode/src/deviceActions.ts (Phase 5d) with one
 * rebuild delta: exec / TCP-probe / sleep are injectable seams on a factory
 * (`createDeviceActions`) so tests fake adb + the port-scan instead of
 * vi.mock'ing child_process — no live adb/nmap is ever touched in tests.
 *
 * Security model (ported): a CLOSED ENUM of adb operations, each run via
 * execFile with an argv ARRAY (never a shell string — no interpolation
 * injection), and the device serial is validated against a strict
 * `<host>:<port>` / known-serial regex before any call.
 *
 * adb itself is reached over the nostr-vpn mesh: the serial is the phone's
 * mesh IP:port (or a USB serial during local setup). The laptop's system
 * `adb` is used via execFile.
 */

import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { redactSecrets } from '../session/permissions';

/** mesh-ip:port (e.g. 10.44.12.34:5555) or a bare device serial (alnum, : . - _ only). */
const SERIAL_RE = /^[A-Za-z0-9][A-Za-z0-9.:_-]{2,63}$/;

/** Cap any single adb call so a hung device can't wedge a test session. */
const ADB_TIMEOUT_MS = 30_000;
const ADB_MAX_BUFFER = 16 * 1024 * 1024; // logcat/screencap can be large

const FAIL_RE =
  /no devices|device offline|not found|connection refused|cannot connect|failed to connect|closed|protocol fault|device unauthorized/i;

/** Overall wall-clock budget for a single port-discovery sweep, so a dead host can't wedge a session. */
export const PORT_SCAN_BUDGET_MS = 25_000;

export interface DeviceActionResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Set for binary-producing actions (screenshot): absolute path to the captured file. */
  artifactPath?: string;
}

export interface DeviceExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Raw stdout bytes for binary-mode calls (screencap). */
  buffer?: Buffer;
}

/** The exec seam: run a binary with an argv array (NO shell). Injectable for tests. */
export type DeviceExecFn = (
  file: string,
  args: string[],
  opts?: { binaryStdout?: boolean },
) => Promise<DeviceExecResult>;

/** Quick TCP-connect probe seam (used to find adbd's rotated wifi port over the mesh). */
export type TcpProbeFn = (host: string, port: number, timeoutMs?: number) => Promise<boolean>;

/** Phone-side WD-enable hook: ask CodeDeck (over the relay) to enable Wireless
 *  Debugging. Returns true if WD was enabled. Null/absent when no phone channel
 *  is available (the port-scan + mDNS fallbacks still recover a port-rotation
 *  as long as WD is already on). Ported hook — the old bridge never wired it
 *  either; the phone's own 60s heartbeat keeps WD alive instead. */
export type PrepareAdbFn = (meshIp: string) => Promise<boolean>;

export const realDeviceExec: DeviceExecFn = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: ADB_TIMEOUT_MS,
        maxBuffer: ADB_MAX_BUFFER,
        encoding: opts?.binaryStdout ? 'buffer' : 'utf8',
      },
      (err, stdout, stderr) => {
        const errOut = stderr ? String(stderr) : '';
        resolve({
          ok: !err,
          stdout: opts?.binaryStdout ? '' : String(stdout ?? ''),
          stderr: err ? `${errOut}${err.message ? `\n${err.message}` : ''}` : errOut,
          ...(opts?.binaryStdout && Buffer.isBuffer(stdout) ? { buffer: stdout } : {}),
        });
      },
    );
  });

export const realTcpProbe: TcpProbeFn = (host, port, timeoutMs = 1200) =>
  new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok: boolean): void => {
      if (!done) {
        done = true;
        sock.destroy();
        resolve(ok);
      }
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });

export function defaultAdbPath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.CODEDECK_ADB_PATH ?? path.join(os.homedir(), 'Android', 'Sdk', 'platform-tools', 'adb')
  );
}

function validateSerial(serial: string): string {
  const s = (serial || '').trim();
  if (!SERIAL_RE.test(s)) {
    throw new Error(`invalid device serial: ${JSON.stringify(serial)}`);
  }
  return s;
}

function splitHostPort(serial: string): { host: string; port: number } | null {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]):(\d{1,5})$/.exec(serial.trim());
  if (!m) return null;
  return { host: m[1]!, port: Number(m[2]) };
}

/**
 * Only port-scan / auto-recover hosts inside the nostr-vpn mesh CIDR
 * (10.44.0.0/16). This stops the port-discovery sweep from being abused as a
 * port-scanner against arbitrary/loopback/LAN hosts via a crafted serial —
 * recovery is a mesh-only operation by design. USB serials (no host:port) and
 * any non-mesh literal are excluded from scanning (they can still connect on
 * their exact endpoint).
 */
export function isMeshHost(host: string): boolean {
  return /^10\.44\.\d{1,3}\.\d{1,3}$/.test(host);
}

export interface DeviceActionsOptions {
  /** adb binary; default CODEDECK_ADB_PATH or ~/Android/Sdk/platform-tools/adb. */
  adbPath?: string;
  /** Injectable exec seam for tests (covers adb + aapt). */
  exec?: DeviceExecFn;
  /** Injectable TCP-probe seam for tests (port discovery + path warming). */
  tcpProbe?: TcpProbeFn;
  /** Injectable sleep for tests (retry backoff, online polling). */
  sleep?: (ms: number) => Promise<void>;
  /** Port-scan wall-clock budget override (tests). */
  portScanBudgetMs?: number;
  /** Phone-side WD-enable hook (see PrepareAdbFn). */
  prepareAdb?: PrepareAdbFn;
  now?: () => number;
  log?: (msg: string) => void;
}

/**
 * The device-action surface consumed by the device MCP server and the bridge.
 * One instance per BridgeCore (carries the last-good-port cache).
 */
export interface DeviceActions {
  ensureConnected(serial: string): Promise<string>;
  connect(serial: string): Promise<DeviceActionResult>;
  list(): Promise<DeviceActionResult>;
  install(serial: string, apkPath: string): Promise<DeviceActionResult>;
  launch(serial: string, pkg: string, activity?: string): Promise<DeviceActionResult>;
  logcat(serial: string, lines?: number, pkg?: string): Promise<DeviceActionResult>;
  uiDump(serial: string): Promise<DeviceActionResult>;
  screenshotRaw(serial: string, outDir: string): Promise<DeviceActionResult>;
  tap(serial: string, x: number, y: number): Promise<DeviceActionResult>;
  typeText(serial: string, text: string): Promise<DeviceActionResult>;
  key(serial: string, keycode: string): Promise<DeviceActionResult>;
  setPrepareAdb(fn: PrepareAdbFn | null): void;
}

export function createDeviceActions(opts: DeviceActionsOptions = {}): DeviceActions {
  const ADB = opts.adbPath ?? defaultAdbPath();
  const exec = opts.exec ?? realDeviceExec;
  const tcpProbe = opts.tcpProbe ?? realTcpProbe;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const budgetMs = opts.portScanBudgetMs ?? PORT_SCAN_BUDGET_MS;
  const now = opts.now ?? Date.now;
  let prepareAdbFn: PrepareAdbFn | null = opts.prepareAdb ?? null;

  /** Last port that worked per mesh host, to make recovery fast on the common case (WD just toggled). */
  const lastGoodPort = new Map<string, number>();

  /** Run `adb -s <serial> <args...>` with argv array — NO shell, no interpolation. */
  const adb = async (
    serial: string,
    args: string[],
    o?: { binaryStdout?: boolean },
  ): Promise<DeviceActionResult> => {
    const s = validateSerial(serial);
    const r = await exec(ADB, ['-s', s, ...args], o);
    return { ok: r.ok, stdout: r.stdout, stderr: r.stderr };
  };

  /** Raw adb (no -s) for connect, used before a device serial is established. */
  const adbRaw = async (args: string[]): Promise<DeviceActionResult> => {
    const r = await exec(ADB, args);
    return { ok: r.ok, stdout: r.stdout, stderr: r.stderr };
  };

  /** Is this serial currently a healthy `device` in `adb devices`? */
  const isOnline = async (serial: string): Promise<boolean> => {
    const r = await adbRaw(['devices']);
    if (!r.ok) return false;
    const line = r.stdout
      .split(/\r?\n/)
      .find((l) => l.startsWith(serial + '\t') || l.startsWith(serial + ' '));
    return !!line && /\bdevice\b/.test(line) && !/offline|unauthorized/.test(line);
  };

  /** mDNS lookup of the device's current adb-tls-connect endpoint (same-LAN only). */
  const mdnsEndpoint = async (meshIp: string): Promise<string | null> => {
    const r = await adbRaw(['mdns', 'services']);
    if (!r.ok) return null;
    // Lines look like: adb-<serial>-xxxx\t_adb-tls-connect._tcp\t<ip>:<port>
    for (const l of r.stdout.split(/\r?\n/)) {
      const m = /_adb-tls-connect\._tcp\s+(\S+):(\d+)/.exec(l);
      if (m && m[1] === meshIp) return `${m[1]}:${m[2]}`;
    }
    return null;
  };

  /**
   * Find adbd's (rotated) Wireless-Debugging port on the mesh IP by probing
   * candidate ports. adbd-wifi binds an ephemeral high port; on the Pixel 9
   * (Android 16) these cluster in ~30000–45000. We probe the last-known port
   * first, then sweep the most-likely range before the wider Linux ephemeral
   * range. Cross-network this is the only way to learn the port (mDNS can't
   * cross LANs and the phone can't read adbd's socket). Returns the open port,
   * or null.
   */
  const discoverAdbPort = async (host: string, lastKnown?: number): Promise<number | null> => {
    // SECURITY: never sweep a non-mesh host — recovery is mesh-only; this blocks SSRF-style scans.
    if (!isMeshHost(host)) return null;
    const deadline = now() + budgetMs;
    const tryPort = async (p: number): Promise<number | null> =>
      (await tcpProbe(host, p)) ? p : null;
    if (lastKnown && (await tryPort(lastKnown))) return lastKnown;
    // Scan the observed adbd-wifi band first (fast hit), then the rest of the
    // Linux ephemeral range as a fallback. Concurrent batches keep it quick
    // over a high-latency mesh link. Bail at the deadline.
    const ranges: Array<[number, number]> = [
      [35000, 46000], // most-likely adbd-wifi band observed on the Pixel 9
      [30000, 35000],
      [46000, 61000], // wider Linux ip_local_port_range fallback
    ];
    const batch = 96;
    for (const [lo, hi] of ranges) {
      for (let start = lo; start <= hi; start += batch) {
        if (now() > deadline) return null; // time budget exceeded
        const ports: number[] = [];
        for (let p = start; p < Math.min(start + batch, hi + 1); p++) ports.push(p);
        const hits = await Promise.all(ports.map((p) => tryPort(p)));
        const found = hits.find((p): p is number => p !== null);
        if (found) return found;
      }
    }
    return null;
  };

  /**
   * Warm a freshly (re)established FIPS mesh path before relying on adb's TLS
   * handshake. Right after a cold mesh start the path jitters badly (measured
   * 250–1400ms, settling to ~100ms) and adb's TLS handshake times out →
   * "device offline". A few quick TCP probes drive traffic through the tunnel
   * so it converges; we return once probes are landing consistently (or give
   * up after the budget).
   */
  const warmPath = async (host: string, port: number, attempts = 6): Promise<void> => {
    let consecutive = 0;
    for (let i = 0; i < attempts; i++) {
      if (await tcpProbe(host, port, 1500)) {
        if (++consecutive >= 2) return; // two clean probes in a row ⇒ path is settling
      } else {
        consecutive = 0;
      }
    }
  };

  /**
   * Ensure adb is connected to the test device, recovering from WD-off /
   * port-rotation if needed. Returns the serial that is actually online
   * (host:port may differ from the input if the port rotated). Throws if it
   * cannot establish a connection.
   */
  const ensureConnected = async (serial: string): Promise<string> => {
    const s = validateSerial(serial);
    if (await isOnline(s)) return s;

    const hp = splitHostPort(s);
    // Step 0: a plain reconnect to the given endpoint (covers a transient drop, port unchanged).
    await adbRaw(['disconnect', s]).catch(() => undefined);
    await adbRaw(['connect', s]).catch(() => undefined);
    if (await isOnline(s)) return s;

    if (!hp) {
      // USB serial or non host:port — nothing to re-discover; report current state.
      if (await isOnline(s)) return s;
      throw new Error(`device ${s} not reachable and no host:port to recover`);
    }

    // Connect to a port, warming the (possibly cold/jittery) path first and
    // retrying the adb TLS handshake with backoff — the handshake fails as
    // "offline" on a freshly-restarted mesh until the FIPS path settles, even
    // though the port is reachable.
    const tryConnect = async (port: number): Promise<string | null> => {
      const ep = `${hp.host}:${port}`;
      await warmPath(hp.host, port);
      for (let attempt = 0; attempt < 3; attempt++) {
        await adbRaw(['disconnect', ep]).catch(() => undefined);
        await adbRaw(['connect', ep]).catch(() => undefined);
        // adb may report "device" but still be settling; poll briefly for a healthy state.
        for (let i = 0; i < 3; i++) {
          if (await isOnline(ep)) {
            lastGoodPort.set(hp.host, port);
            return ep;
          }
          await sleep(800);
        }
        await sleep(500 * (attempt + 1));
      }
      return null;
    };

    // Step 1: ask CodeDeck (over the relay) to re-enable Wireless Debugging — no human tap.
    if (prepareAdbFn) {
      await prepareAdbFn(hp.host).catch(() => false);
    }

    // Step 2: mDNS (same-LAN — instant when it applies).
    const mdns = await mdnsEndpoint(hp.host);
    if (mdns) {
      await adbRaw(['connect', mdns]).catch(() => undefined);
      if (await isOnline(mdns)) {
        const p = splitHostPort(mdns);
        if (p) lastGoodPort.set(hp.host, p.port);
        return mdns;
      }
    }

    // Step 3: discover the rotated port by probing the mesh IP (last-known first), then connect.
    const port = await discoverAdbPort(hp.host, lastGoodPort.get(hp.host) ?? hp.port);
    if (port) {
      const ep = await tryConnect(port);
      if (ep) return ep;
    }

    // Step 4: last try on the original endpoint (skip port 0 — it's the
    // "sweep for the live port" placeholder the bridge writes, never real).
    if (hp.port > 0) {
      const orig = await tryConnect(hp.port);
      if (orig) return orig;
    }

    throw new Error(
      `device ${s} unreachable: Wireless Debugging may be off (open CodeDeck → Settings → Mesh on the phone to re-enable) or the mesh is down.`,
    );
  };

  /** Run an adb action, self-healing the connection once on a connection-class failure. */
  const withRecovery = async (
    serial: string,
    run: (s: string) => Promise<DeviceActionResult>,
  ): Promise<DeviceActionResult> => {
    let s: string;
    try {
      s = await ensureConnected(serial);
    } catch (e) {
      return { ok: false, stdout: '', stderr: String(e instanceof Error ? e.message : e) };
    }
    const r = await run(s);
    if (r.ok || !FAIL_RE.test(r.stderr)) return r;
    // One recovery attempt on a connection-class error.
    try {
      const s2 = await ensureConnected(serial);
      return await run(s2);
    } catch {
      return r; // return the original failure if recovery couldn't help
    }
  };

  /** Resolve the real `pkg/activity` launcher component on the device (handles renamed/soft-fork activities). */
  const resolveLauncherActivity = async (serial: string, pkg: string): Promise<string | null> => {
    const r = await adb(serial, [
      'shell', 'cmd', 'package', 'resolve-activity', '--brief',
      '-c', 'android.intent.category.LAUNCHER', pkg,
    ]);
    if (!r.ok) return null;
    // Output's last non-empty line is `pkg/activity`.
    const line = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || '';
    return /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.]+$/.test(line) ? line : null;
  };

  /** Read the package id out of an APK using aapt/aapt2 if available; falls back to null. */
  const apkPackageId = async (apkPath: string): Promise<string | null> => {
    const sdk = path.dirname(path.dirname(ADB)); // .../Android/Sdk
    const buildTools = path.join(sdk, 'build-tools');
    const candidates: string[] = [];
    try {
      for (const v of fs.readdirSync(buildTools).sort().reverse()) {
        candidates.push(path.join(buildTools, v, 'aapt2'), path.join(buildTools, v, 'aapt'));
      }
    } catch {
      /* no build-tools */
    }
    for (const aapt of candidates) {
      if (!fs.existsSync(aapt)) continue;
      const out = await exec(aapt, ['dump', 'badging', apkPath]);
      const m = /package: name='([^']+)'/.exec(out.ok ? out.stdout : '');
      if (m) return m[1]!;
    }
    return null;
  };

  return {
    ensureConnected,

    async connect(serial) {
      // serial here is host:port. Use the self-healing path so a rotated port /
      // WD-off recovers and the result reports the endpoint that is actually online.
      try {
        const live = await ensureConnected(serial);
        return { ok: true, stdout: `connected to ${live}`, stderr: '' };
      } catch (e) {
        return { ok: false, stdout: '', stderr: String(e instanceof Error ? e.message : e) };
      }
    },

    list() {
      return adbRaw(['devices', '-l']);
    },

    async install(serial, apkPath) {
      if (!apkPath || !fs.existsSync(apkPath)) {
        return { ok: false, stdout: '', stderr: `APK not found: ${apkPath}` };
      }
      return withRecovery(serial, async (s) => {
        const r = await adb(s, ['install', '-r', '-d', apkPath]);
        if (r.ok) return r;
        // Signature mismatch on a dev rebuild (e.g. a release/Zapstore build is
        // already installed): uninstall the conflicting package, then
        // reinstall. Pull the package id from the APK.
        if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(r.stderr)) {
          const pkg = await apkPackageId(apkPath);
          if (pkg) {
            await adb(s, ['uninstall', pkg]);
            const r2 = await adb(s, ['install', '-r', '-d', apkPath]);
            if (r2.ok) {
              return {
                ...r2,
                stdout: `${r2.stdout}\n(note: uninstalled conflicting ${pkg} due to signature mismatch, then reinstalled)`,
              };
            }
            return r2;
          }
        }
        return r;
      });
    },

    async launch(serial, pkg, activity) {
      if (!/^[A-Za-z0-9_.]+$/.test(pkg)) {
        return { ok: false, stdout: '', stderr: `invalid package: ${pkg}` };
      }
      if (activity && !/^[A-Za-z0-9_./]+$/.test(activity)) {
        return { ok: false, stdout: '', stderr: `invalid activity: ${activity}` };
      }
      return withRecovery(serial, async (s) => {
        if (activity) {
          const r = await adb(s, ['shell', 'am', 'start', '-n', `${pkg}/${activity}`]);
          // A wrong/renamed activity (e.g. a soft-fork that kept the upstream
          // activity namespace) gives "Activity class ... does not exist" /
          // "Error type 3". Fall back to resolving the launcher.
          if (
            r.ok &&
            !/does not exist|Error type 3/i.test(r.stdout) &&
            !/does not exist|Error type 3/i.test(r.stderr)
          ) {
            return r;
          }
        }
        // Resolve and launch the real LAUNCHER activity for the package.
        const resolved = await resolveLauncherActivity(s, pkg);
        if (resolved) {
          const r = await adb(s, ['shell', 'am', 'start', '-n', resolved]);
          if (r.ok && !/does not exist|Error type 3/i.test(r.stdout)) {
            return { ...r, stdout: `${r.stdout}\n(launched resolved activity ${resolved})` };
          }
        }
        // Last resort: monkey launches the default LAUNCHER activity without needing the activity name.
        return adb(s, ['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
      });
    },

    /**
     * Fetch logcat. Scopes to the app-under-test's PID when `pkg` is given (so
     * secrets in OTHER apps' logs never leave the device), and always redacts
     * common secret shapes from the result. Falls back to the full ring buffer
     * only when no pkg is provided or the app isn't running.
     */
    async logcat(serial, lines = 200, pkg) {
      const n = Math.max(1, Math.min(2000, Math.floor(lines)));
      const result = await withRecovery(serial, async (s) => {
        let pid = '';
        if (pkg && /^[A-Za-z0-9_.]+$/.test(pkg)) {
          const p = await adb(s, ['shell', 'pidof', pkg]);
          pid = (p.stdout || '').trim().split(/\s+/)[0] || '';
        }
        // --pid scopes to the app under test; omit only if we couldn't resolve a pid.
        const args = pid
          ? ['logcat', '-d', '-t', String(n), '--pid', pid]
          : ['logcat', '-d', '-t', String(n)];
        return adb(s, args);
      });
      // Redact secret shapes regardless of scoping (defense-in-depth before it hits the relay).
      return { ...result, stdout: redactSecrets(result.stdout) };
    },

    uiDump(serial) {
      // exec-out to /dev/tty streams the XML to stdout; tiny (~tens of KB), the assertion workhorse.
      return withRecovery(serial, (s) => adb(s, ['exec-out', 'uiautomator', 'dump', '/dev/tty']));
    },

    /** Capture a screenshot. Returns the raw PNG path; screenshotDelivery downscales before sending. */
    async screenshotRaw(serial, outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      return withRecovery(serial, async (s) => {
        const outPath = path.join(
          outDir,
          `screencap-${s.replace(/[^A-Za-z0-9]/g, '_')}-${now()}.png`,
        );
        const r = await exec(ADB, ['-s', s, 'exec-out', 'screencap', '-p'], { binaryStdout: true });
        if (!r.ok || !r.buffer || r.buffer.length === 0) {
          return {
            ok: false,
            stdout: '',
            stderr: `screencap failed: ${r.stderr || 'empty output'}`,
          };
        }
        try {
          fs.writeFileSync(outPath, r.buffer);
          return {
            ok: true,
            stdout: `captured ${r.buffer.length} bytes`,
            stderr: '',
            artifactPath: outPath,
          };
        } catch (e) {
          return { ok: false, stdout: '', stderr: `write failed: ${String(e)}` };
        }
      });
    },

    tap(serial, x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return Promise.resolve({ ok: false, stdout: '', stderr: 'tap requires numeric x,y' });
      }
      return withRecovery(serial, (s) =>
        adb(s, ['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]),
      );
    },

    typeText(serial, text) {
      // CDX-013: `adb shell` concatenates its argv into ONE string executed by
      // the DEVICE's /system/bin/sh — the local argv array protects the laptop
      // only. Reject device-side shell metacharacters outright instead of
      // trying to quote for mksh.
      if (!/^[A-Za-z0-9 ._@:/+,=-]*$/.test(text)) {
        return Promise.resolve({
          ok: false,
          stdout: '',
          stderr: 'typeText rejects shell metacharacters (device-side sh injection)',
        });
      }
      // input text needs spaces as %s; argv array keeps it shell-safe.
      const escaped = text.replace(/ /g, '%s');
      return withRecovery(serial, (s) => adb(s, ['shell', 'input', 'text', escaped]));
    },

    key(serial, keycode) {
      if (!/^[A-Z0-9_]+$/.test(keycode)) {
        return Promise.resolve({ ok: false, stdout: '', stderr: `invalid keycode: ${keycode}` });
      }
      return withRecovery(serial, (s) => adb(s, ['shell', 'input', 'keyevent', keycode]));
    },

    setPrepareAdb(fn) {
      prepareAdbFn = fn;
    },
  };
}
