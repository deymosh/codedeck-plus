/**
 * meshAdmin — ported suite (old bridge meshAdmin.test.ts) adapted to the
 * rebuild's injectable exec seam, then reworked for CDX-028: nvpn 4.1.x
 * removed `create-invite`, so the admin now exposes onboardingInfo()
 * (network_id + device_id from `status --json`) and addDevice()
 * (`add-device --device <pk> --publish --json`). Tests fake nvpn by argv,
 * never touching a real binary.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createMeshAdmin,
  disabledMeshAdmin,
  resolveNvpnPath,
  type ExecResult,
  type MeshAdmin,
} from '../mesh/meshAdmin';

type ExecHandler = (args: string[]) => { err?: boolean; stdout: string; stderr?: string };

let execHandler: ExecHandler;
const execCalls: Array<{ args: string[]; timeoutMs?: number }> = [];

function fakeExec(
  _file: string,
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<ExecResult> {
  execCalls.push({ args, ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
  const r = execHandler(args);
  return Promise.resolve({ ok: !r.err, stdout: r.stdout.trim(), stderr: r.stderr ?? '' });
}

function admin(): MeshAdmin {
  return createMeshAdmin({ exec: fakeExec });
}

const STATUS_JSON = JSON.stringify({
  network_id: 'a237c978',
  device_id: 'npub195fc27g6lmak9fvulgh6xqxwl96pu4su2vpk9uyskvzdjff3te4q9jln2d',
  daemon: { running: true },
});

const PHONE_HEX = 'c1cf657c71ce41b45f2c4f323f688cd9f01b8c2ddc2b3a05bfab4007c40a6bdc';
const PHONE_NPUB = 'npub1c88k2lr3eeqmghevfuer76yvm8cphrpdms4n5pdl4dqq03q2d0wqes26sx';

beforeEach(() => {
  execCalls.length = 0;
  execHandler = () => ({ err: true, stdout: '' });
});

describe('onboardingInfo', () => {
  it('reads network_id + device_id from `status --json` (the manual-join pair)', async () => {
    execHandler = (args) =>
      args[0] === 'status' ? { stdout: STATUS_JSON } : { err: true, stdout: '' };
    const res = await admin().onboardingInfo();
    expect(res).toEqual({
      networkId: 'a237c978',
      adminDeviceId: 'npub195fc27g6lmak9fvulgh6xqxwl96pu4su2vpk9uyskvzdjff3te4q9jln2d',
    });
    expect(execCalls[0]!.args).toEqual(['status', '--json']);
  });

  it('returns null when nvpn fails, JSON is garbage, or fields are missing/malformed', async () => {
    execHandler = () => ({ err: true, stdout: '' });
    expect(await admin().onboardingInfo()).toBeNull();

    execHandler = () => ({ stdout: 'not json' });
    expect(await admin().onboardingInfo()).toBeNull();

    // No network joined → no network_id.
    execHandler = () => ({ stdout: JSON.stringify({ device_id: 'npub1abc' }) });
    expect(await admin().onboardingInfo()).toBeNull();

    // device_id must be an npub (manual-join wants the ADMIN DEVICE ID, not hex).
    execHandler = () => ({ stdout: JSON.stringify({ network_id: 'a237c978', device_id: 'deadbeef' }) });
    expect(await admin().onboardingInfo()).toBeNull();
  });
});

describe('addDevice', () => {
  it('runs canonical `add-device --device <pk> --publish --json` with the longer publish timeout', async () => {
    execHandler = (args) => {
      expect(args).toEqual(['add-device', '--device', PHONE_HEX, '--publish', '--json']);
      return { stdout: '{"added":["' + PHONE_HEX + '"]}' };
    };
    expect(await admin().addDevice(PHONE_HEX)).toEqual({ ok: true });
    // --publish does a relay round-trip — 15s was too tight (CDX-028 recon).
    expect(execCalls[0]!.timeoutMs).toBeGreaterThanOrEqual(30_000);
  });

  it('accepts an npub too (nvpn takes npub or hex)', async () => {
    execHandler = (args) => {
      expect(args[2]).toBe(PHONE_NPUB);
      return { stdout: 'ok' };
    };
    expect(await admin().addDevice(PHONE_NPUB)).toEqual({ ok: true });
  });

  it('rejects a malformed pubkey before exec (no shell injection surface)', async () => {
    const res = await admin().addDevice('--publish; rm -rf /');
    expect(res.ok).toBe(false);
    expect(execCalls.length).toBe(0);
  });

  it('surfaces the not-admin refusal distinctly (actionable, not a generic failure)', async () => {
    execHandler = () => ({
      err: true,
      stdout: '',
      stderr: 'error: active network is not administered by this device',
    });
    const res = await admin().addDevice(PHONE_HEX);
    expect(res).toEqual({
      ok: false,
      notAdmin: true,
      error: 'error: active network is not administered by this device',
    });
  });

  it('generic failure → ok:false, notAdmin:false, with the nvpn error text', async () => {
    execHandler = () => ({ err: true, stdout: '', stderr: 'error: no active network' });
    const res = await admin().addDevice(PHONE_HEX);
    expect(res).toEqual({ ok: false, notAdmin: false, error: 'error: no active network' });
  });
});

describe('derivePeerIp', () => {
  it('uses the canonical --device flag, parses the JSON array form, strips /32', async () => {
    execHandler = (args) => {
      expect(args).toEqual(['ip', '--device', PHONE_HEX, '--peer', '--json']);
      return { stdout: '["10.44.204.101/32"]' };
    };
    expect(await admin().derivePeerIp(PHONE_HEX)).toBe('10.44.204.101');
  });

  it('rejects an IP outside the mesh CIDR', async () => {
    execHandler = () => ({ stdout: '["192.168.1.5/32"]' });
    expect(await admin().derivePeerIp(PHONE_HEX)).toBeNull();
  });

  it('returns null on invalid pubkey without calling nvpn', async () => {
    expect(await admin().derivePeerIp('not-a-key')).toBeNull();
    expect(execCalls.length).toBe(0);
  });
});

describe('daemonRunning', () => {
  it('is true when status reports daemon.running', async () => {
    execHandler = () => ({ stdout: JSON.stringify({ daemon: { running: true } }) });
    expect(await admin().daemonRunning()).toBe(true);
  });

  it('is false when the daemon is down', async () => {
    execHandler = () => ({ stdout: JSON.stringify({ daemon: { running: false } }) });
    expect(await admin().daemonRunning()).toBe(false);
  });

  it('is false when nvpn is unavailable', async () => {
    execHandler = () => ({ err: true, stdout: '' });
    expect(await admin().daemonRunning()).toBe(false);
  });
});

describe('availability', () => {
  it('disabledMeshAdmin no-ops everything', async () => {
    const a = disabledMeshAdmin();
    expect(a.available).toBe(false);
    expect(await a.onboardingInfo()).toBeNull();
    expect((await a.addDevice(PHONE_HEX)).ok).toBe(false);
    expect(await a.derivePeerIp(PHONE_HEX)).toBeNull();
    expect(await a.daemonRunning()).toBe(false);
  });

  it('enabled:false disables even with an exec injected, with an actionable log', async () => {
    const logs: string[] = [];
    const a = createMeshAdmin({ exec: fakeExec, enabled: false, log: (m) => logs.push(m) });
    expect(a.available).toBe(false);
    expect(logs.join('\n')).toMatch(/disabled by config/);
    expect(execCalls.length).toBe(0);
  });

  it('resolveNvpnPath: an existing explicit path wins; a missing explicit path falls through', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvpn-test-'));
    const fake = path.join(dir, 'nvpn');
    fs.writeFileSync(fake, '#!/bin/sh\n');
    try {
      expect(resolveNvpnPath(fake, {}, dir)).toBe(fake);
      // env override is honored when the explicit path is absent
      expect(resolveNvpnPath(undefined, { CODEDECK_NVPN_PATH: fake }, dir)).toBe(fake);
      // ~/.cargo/bin/nvpn under a homedir that has one
      const cargoBin = path.join(dir, '.cargo', 'bin');
      fs.mkdirSync(cargoBin, { recursive: true });
      fs.writeFileSync(path.join(cargoBin, 'nvpn'), '#!/bin/sh\n');
      expect(resolveNvpnPath(undefined, {}, dir)).toBe(path.join(cargoBin, 'nvpn'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
