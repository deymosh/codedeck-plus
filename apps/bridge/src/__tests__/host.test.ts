/**
 * CLI host smoke: terminal QR rendering (unicode half-blocks) and the
 * presentPairing terminal output (QR + URL + npub fallback).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import { renderTerminalQr } from '../terminalQr';
import { createCliHost } from '../host';
import { CliState } from '../state';

class CaptureStream extends Writable {
  text = '';
  override _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
    this.text += chunk.toString();
    cb();
  }
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const PAIRING_URL = 'codedeck://pair?npub=npub1abc&relays=wss%3A%2F%2Fr.example&machine=m&token=tok123';

describe('renderTerminalQr', () => {
  it('renders unicode half-blocks, multi-line', async () => {
    const qr = await renderTerminalQr(PAIRING_URL);
    expect(qr).toMatch(/[▀▄█]/);
    expect(qr.trim().split('\n').length).toBeGreaterThan(10);
  });
});

describe('CliHost', () => {
  let home: string;

  beforeEach(() => {
    home = path.join(os.tmpdir(), `codedeck-cli-host-${process.pid}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  function makeHost() {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const state = new CliState(home);
    const host = createCliHost({
      config: {
        machineName: 'host-test', host: 'cli',
        relays: ['wss://r.example'], workspaceRoots: [home],
      },
      state,
      homeDir: home,
      npub: 'npub1bridgefallback',
      out,
      err,
    });
    return { host, out, err };
  }

  it('presentPairing prints the QR, the pairing URL, and the manual-npub fallback', async () => {
    const { host, out } = makeHost();
    const handle = host.presentPairing({ url: PAIRING_URL, expiresAt: new Date(Date.now() + 600_000) });
    await waitFor(() => out.text.includes('Pairing URL:'));

    expect(out.text).toMatch(/[▀▄█]/); // the QR itself
    expect(out.text).toContain(`Pairing URL: ${PAIRING_URL}`);
    expect(out.text).toContain('Bridge npub: npub1bridgefallback');
    expect(out.text).toContain('No camera?');

    handle.close();
    expect(out.text).toContain('Pairing window closed.');
  });

  it('CDX-013: prints displayUrl (mesh invite redacted) while the QR keeps the full URL', async () => {
    const { host, out } = makeHost();
    const fullUrl = `${PAIRING_URL}&netid=n1&mesh=nvpn%3A%2F%2Finvite%2FSECRETSECRET`;
    const displayUrl = `${PAIRING_URL}&mesh=…`;
    host.presentPairing({ url: fullUrl, displayUrl, expiresAt: new Date(Date.now() + 600_000) });
    await waitFor(() => out.text.includes('Pairing URL:'));

    expect(out.text).toContain(`Pairing URL: ${displayUrl}`);
    expect(out.text).not.toContain('SECRETSECRET');
  });

  it('logs info to stdout, warn/error to stderr; notify goes to stderr', () => {
    const { host, out, err } = makeHost();
    host.log('info', 'hello-info');
    host.log('warn', 'hello-warn');
    host.log('error', 'hello-error');
    host.notify('warn', 'user-facing notice');
    expect(out.text).toContain('hello-info');
    expect(out.text).not.toContain('hello-warn');
    expect(err.text).toContain('hello-warn');
    expect(err.text).toContain('hello-error');
    expect(err.text).toContain('user-facing notice');
  });

  it('runShutdownHooks runs each hook exactly once, even when called twice', async () => {
    const { host } = makeHost();
    let calls = 0;
    host.onShutdown(() => { calls++; });
    host.onShutdown(async () => { calls++; });
    await Promise.all([host.runShutdownHooks(), host.runShutdownHooks()]);
    await host.runShutdownHooks();
    expect(calls).toBe(2);
  });
});
