/**
 * deviceActions — unit tests against faked adb/aapt exec + a faked TCP probe.
 * No real adb, no real sockets, no live devices (rebuild rule): the injectable
 * seams replace the old suite's child_process mocking.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createDeviceActions,
  isMeshHost,
  type DeviceActions,
  type DeviceExecResult,
} from '../mesh/deviceActions';

type ExecHandler = (file: string, args: string[], opts?: { binaryStdout?: boolean }) => DeviceExecResult;

let execHandler: ExecHandler;
let probeOpenPorts: Set<number>;
const execCalls: Array<{ file: string; args: string[] }> = [];
const probeCalls: Array<{ host: string; port: number }> = [];

const ADB = '/fake/Android/Sdk/platform-tools/adb';

function actions(overrides?: Parameters<typeof createDeviceActions>[0]): DeviceActions {
  return createDeviceActions({
    adbPath: ADB,
    exec: (file, args, opts) => {
      execCalls.push({ file, args });
      return Promise.resolve(execHandler(file, args, opts));
    },
    tcpProbe: (host, port) => {
      probeCalls.push({ host, port });
      return Promise.resolve(probeOpenPorts.has(port));
    },
    sleep: () => Promise.resolve(),
    ...overrides,
  });
}

const ok = (stdout: string): DeviceExecResult => ({ ok: true, stdout, stderr: '' });
const fail = (stderr: string): DeviceExecResult => ({ ok: false, stdout: '', stderr });

/** adb `devices` output listing the given serials as healthy. */
const devicesOut = (...serials: string[]): string =>
  ['List of devices attached', ...serials.map((s) => `${s}\tdevice`), ''].join('\n');

beforeEach(() => {
  execCalls.length = 0;
  probeCalls.length = 0;
  probeOpenPorts = new Set();
  execHandler = () => fail('unexpected exec');
});

describe('serial validation', () => {
  it('rejects a crafted serial before any exec', async () => {
    const a = actions();
    const r = await a.connect('$(rm -rf /)');
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/invalid device serial/);
    expect(execCalls.length).toBe(0);
  });

  it('tap/key validate their inputs', async () => {
    const a = actions();
    expect((await a.tap('10.44.0.9:5555', NaN, 3)).ok).toBe(false);
    expect((await a.key('10.44.0.9:5555', 'rm -rf')).ok).toBe(false);
    expect(execCalls.length).toBe(0);
  });
});

describe('ensureConnected', () => {
  it('returns immediately when the serial is already online', async () => {
    execHandler = (_f, args) =>
      args[0] === 'devices' ? ok(devicesOut('10.44.0.9:5555')) : fail('no');
    const a = actions();
    expect(await a.ensureConnected('10.44.0.9:5555')).toBe('10.44.0.9:5555');
    expect(probeCalls.length).toBe(0); // no scan needed
  });

  it('recovers a rotated Wireless-Debugging port by sweeping the mesh IP', async () => {
    const ROTATED = 37123;
    let connectedTo: string | null = null;
    execHandler = (_f, args) => {
      if (args[0] === 'devices') return ok(connectedTo ? devicesOut(connectedTo) : devicesOut());
      if (args[0] === 'mdns') return ok('List of discovered mdns services\n');
      if (args[0] === 'connect') {
        const ep = args[1]!;
        if (ep === `10.44.0.9:${ROTATED}`) connectedTo = ep;
        return ok(`connected to ${ep}`);
      }
      if (args[0] === 'disconnect') return ok('');
      return fail('no');
    };
    probeOpenPorts = new Set([ROTATED]);
    const a = actions();
    // serial from the bridge is `<meshIp>:0` — the port-0 placeholder.
    expect(await a.ensureConnected('10.44.0.9:0')).toBe(`10.44.0.9:${ROTATED}`);
    // The sweep probed the mesh host and found the rotated port.
    expect(probeCalls.some((p) => p.host === '10.44.0.9' && p.port === ROTATED)).toBe(true);
    // and never dialed adb connect on port 0 beyond the initial plain reconnect.
    expect(execCalls.filter((c) => c.args[0] === 'connect' && c.args[1] === '10.44.0.9:0').length).toBe(1);
  });

  it('never port-sweeps a non-mesh host (SSRF guard) — only the exact endpoint is retried', async () => {
    execHandler = (_f, args) => {
      if (args[0] === 'devices') return ok(devicesOut());
      if (args[0] === 'mdns') return ok('');
      if (args[0] === 'connect' || args[0] === 'disconnect') return ok('');
      return fail('no');
    };
    const a = actions();
    await expect(a.ensureConnected('192.168.1.50:5555')).rejects.toThrow(/unreachable/);
    // warmPath may probe the exact endpoint, but no other port is ever probed.
    expect(probeCalls.every((p) => p.port === 5555)).toBe(true);
    expect(isMeshHost('192.168.1.50')).toBe(false);
    expect(isMeshHost('10.44.12.34')).toBe(true);
  });

  it('uses the mDNS endpoint when the device is on the same LAN', async () => {
    let mdnsConnected = false;
    execHandler = (_f, args) => {
      if (args[0] === 'devices') return ok(mdnsConnected ? devicesOut('10.44.0.9:40001') : devicesOut());
      if (args[0] === 'mdns') {
        return ok('adb-XYZ-aaaa\t_adb-tls-connect._tcp\t10.44.0.9:40001\n');
      }
      if (args[0] === 'connect') {
        if (args[1] === '10.44.0.9:40001') mdnsConnected = true;
        return ok('');
      }
      if (args[0] === 'disconnect') return ok('');
      return fail('no');
    };
    const a = actions();
    expect(await a.ensureConnected('10.44.0.9:0')).toBe('10.44.0.9:40001');
    expect(probeCalls.length).toBe(0); // mDNS made the sweep unnecessary
  });
});

describe('actions', () => {
  const online = (rest: ExecHandler): ExecHandler => (f, args, opts) =>
    args[0] === 'devices' ? ok(devicesOut('10.44.0.9:5555')) : rest(f, args, opts);

  it('logcat scopes to the app pid and redacts secrets', async () => {
    execHandler = online((_f, args) => {
      if (args.includes('pidof')) return ok('1234\n');
      if (args.includes('logcat')) {
        expect(args).toContain('--pid');
        expect(args).toContain('1234');
        return ok('token=supersecret123 and nsec1qqqqqqqqqqqqqqqqqqqqqqqqq here');
      }
      return fail('no');
    });
    const a = actions();
    const r = await a.logcat('10.44.0.9:5555', 100, 'com.example.app');
    expect(r.ok).toBe(true);
    expect(r.stdout).not.toContain('supersecret123');
    expect(r.stdout).toContain('[REDACTED');
  });

  it('typeText rejects device-side shell metacharacters before any exec (CDX-013)', async () => {
    execHandler = online(() => fail('should not run'));
    const a = actions();
    for (const hostile of [';reboot', '$(id)', '`id`', 'a&&b', 'x|y', "it's", 'a"b', 'a>b']) {
      const r = await a.typeText('10.44.0.9:5555', hostile);
      expect(r.ok).toBe(false);
      expect(r.stderr).toContain('metacharacters');
    }
    expect(execCalls.filter((c) => c.args.includes('text'))).toHaveLength(0);
  });

  it('typeText passes plain text through with spaces as %s', async () => {
    execHandler = online((_f, args) =>
      args.includes('text') ? ok('') : fail('no'),
    );
    const a = actions();
    const r = await a.typeText('10.44.0.9:5555', 'hello world 1.0');
    expect(r.ok).toBe(true);
    const call = execCalls.find((c) => c.args.includes('text'));
    expect(call?.args.at(-1)).toBe('hello%sworld%s1.0');
  });

  it('install falls back to uninstall+reinstall on a signature mismatch (aapt package id)', async () => {
    // Fake SDK layout so apkPackageId finds an aapt binary next to adb.
    const sdkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-sdk-'));
    const adbPath = path.join(sdkDir, 'platform-tools', 'adb');
    const aaptDir = path.join(sdkDir, 'build-tools', '34.0.0');
    fs.mkdirSync(path.dirname(adbPath), { recursive: true });
    fs.mkdirSync(aaptDir, { recursive: true });
    fs.writeFileSync(path.join(aaptDir, 'aapt2'), '');
    const apk = path.join(sdkDir, 'app.apk');
    fs.writeFileSync(apk, 'not-a-real-apk');

    try {
      let uninstalled = false;
      execHandler = (file, args) => {
        if (args[0] === 'devices') return ok(devicesOut('10.44.0.9:5555'));
        if (file.endsWith('aapt2')) return ok("package: name='com.example.app' versionCode='1'");
        if (args.includes('uninstall')) {
          uninstalled = true;
          return ok('Success');
        }
        if (args.includes('install')) {
          return uninstalled
            ? ok('Success')
            : fail('INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match');
        }
        return fail('no');
      };
      const a = actions({ adbPath, exec: (file, args, opts) => {
        execCalls.push({ file, args });
        return Promise.resolve(execHandler(file, args, opts));
      }, tcpProbe: () => Promise.resolve(false), sleep: () => Promise.resolve() });
      const r = await a.install('10.44.0.9:5555', apk);
      expect(r.ok).toBe(true);
      expect(r.stdout).toMatch(/uninstalled conflicting com\.example\.app/);
    } finally {
      fs.rmSync(sdkDir, { recursive: true, force: true });
    }
  });

  it('launch falls back to the resolved launcher activity when the explicit one is wrong', async () => {
    execHandler = online((_f, args) => {
      if (args.join(' ').includes('am start -n com.kubo.app/com.wrong.Activity')) {
        return ok('Error type 3\nActivity class {com.wrong.Activity} does not exist');
      }
      if (args.includes('resolve-activity')) return ok('com.kubo.app/pub.ditto.app.MainActivity\n');
      if (args.join(' ').includes('am start -n com.kubo.app/pub.ditto.app.MainActivity')) {
        return ok('Starting: Intent');
      }
      return fail('no');
    });
    const a = actions();
    const r = await a.launch('10.44.0.9:5555', 'com.kubo.app', 'com.wrong.Activity');
    expect(r.ok).toBe(true);
    expect(r.stdout).toMatch(/launched resolved activity com\.kubo\.app\/pub\.ditto\.app\.MainActivity/);
  });

  it('screenshotRaw writes the PNG bytes to the artifact dir', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-'));
    try {
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      execHandler = (_f, args, opts) => {
        if (args[0] === 'devices') return ok(devicesOut('10.44.0.9:5555'));
        if (args.includes('screencap')) {
          expect(opts?.binaryStdout).toBe(true);
          return { ok: true, stdout: '', stderr: '', buffer: bytes };
        }
        return fail('no');
      };
      const a = actions();
      const r = await a.screenshotRaw('10.44.0.9:5555', outDir);
      expect(r.ok).toBe(true);
      expect(r.artifactPath).toBeTruthy();
      expect(fs.readFileSync(r.artifactPath!)).toEqual(bytes);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('recovers once on a connection-class failure mid-action', async () => {
    let calls = 0;
    execHandler = (_f, args) => {
      if (args[0] === 'devices') return ok(devicesOut('10.44.0.9:5555'));
      if (args.includes('uiautomator')) {
        calls++;
        return calls === 1 ? fail('error: device offline') : ok('<hierarchy/>');
      }
      return ok('');
    };
    const a = actions();
    const r = await a.uiDump('10.44.0.9:5555');
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
  });
});
