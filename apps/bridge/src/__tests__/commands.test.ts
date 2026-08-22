/**
 * cmdRun lifecycle around the pid lock (CDX-033) and the post-shutdown
 * failsafe exit (CDX-023).
 *
 * The device-found race: `cmdRun` used to release `bridge.lock` in a `finally`
 * that fired as soon as the shutdown hooks resolved, while the process itself
 * lingered ~20s still holding relay sockets — a second `codedeck-bridge run`
 * started in that window acquired the lock cleanly and both bridges ran under
 * one identity. The lock must now survive until ACTUAL process exit.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import { disabledMeshAdmin, generateKeypair } from '@codedeck/core';
import {
  FakeSdkFacade,
  InMemoryRelay,
  PhoneSimulator,
  inMemoryPoolFactory,
} from '@codedeck/testkit';
import { loadCliConfig } from '../config';
import { acquireLock, lockHolder, CliState, LockHeldError } from '../state';
import { cmdPair, cmdRun, holdEventLoop, type CommandDeps, type CommandIo } from '../commands';

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

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    await fs.rm(dirs.pop()!, { recursive: true, force: true });
  }
});

interface Rig {
  homeDir: string;
  io: CommandIo & { out: CaptureStream; err: CaptureStream };
  deps: CommandDeps;
  signal: (sig: string) => void;
  /** True once cmdRun registered its signal handler (startup complete). */
  signalReady: () => boolean;
  /** Simulate the actual process 'exit' event. */
  fireExit: () => void;
  exitCodes: number[];
  /** The in-memory relay both the bridge and a PhoneSimulator talk over. */
  relay: InMemoryRelay;
  /** Keepalive handles taken by the command under test (CDX-038/CDX-039). */
  keepAlives: Array<{ released: boolean }>;
}

function makeRig(failsafeExitMs: number): Rig {
  const dir = path.join(os.tmpdir(), `codedeck-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  dirs.push(dir);
  const homeDir = path.join(dir, 'home');
  const wsRoot = path.join(dir, 'ws');
  mkdirSync(wsRoot, { recursive: true });
  const claudeStub = path.join(dir, 'claude');
  writeFileSync(claudeStub, '#!/bin/sh\n'); // resolveClaudeExecutable needs a file

  let signalHandler: ((sig: string) => void) | null = null;
  const exitHandlers: Array<() => void> = [];
  const exitCodes: number[] = [];

  const io = {
    out: new CaptureStream(),
    err: new CaptureStream(),
    onSignal: (h: (sig: string) => void) => { signalHandler = h; },
  };
  const relay = new InMemoryRelay();
  const keepAlives: Array<{ released: boolean }> = [];
  const deps: CommandDeps = {
    facade: new FakeSdkFacade(),
    poolFactory: inMemoryPoolFactory(relay),
    meshAdmin: disabledMeshAdmin(),
    heartbeatIntervalMs: 0,
    onExit: (h) => { exitHandlers.push(h); },
    exit: (code) => { exitCodes.push(code); },
    failsafeExitMs,
    holdEventLoop: () => {
      const handle = { released: false };
      keepAlives.push(handle);
      return { release: () => { handle.released = true; } };
    },
  };
  return {
    homeDir,
    io,
    deps,
    signal: (sig) => signalHandler!(sig),
    signalReady: () => signalHandler !== null,
    fireExit: () => { for (const h of exitHandlers) h(); },
    exitCodes,
    relay,
    keepAlives,
  };
}

/** The pairing token the CLI host printed, once the async QR render lands. */
function tokenFromOutput(rig: Rig): string {
  const match = /Pairing URL: (\S+)/.exec(rig.io.out.text);
  if (!match) throw new Error(`no pairing URL in output:\n${rig.io.out.text}`);
  const token = new URL(match[1]!.replace('codedeck://', 'https://x/')).searchParams.get('token');
  if (!token) throw new Error(`pairing URL carried no token: ${match[1]}`);
  return token;
}

const pairingUrlCount = (rig: Rig): number =>
  (rig.io.out.text.match(/Pairing URL: /g) ?? []).length;

function resolvedFor(rig: Rig): ReturnType<typeof loadCliConfig> {
  const dir = path.dirname(rig.homeDir);
  return loadCliConfig(
    {
      home: rig.homeDir,
      machineName: 'cmd-test',
      workspaces: [path.join(dir, 'ws')],
      claudePath: path.join(dir, 'claude'),
    },
    {},
  );
}

describe('cmdRun lock lifecycle (CDX-033) + failsafe exit (CDX-023)', () => {
  it('holds bridge.lock through the shutdown window and releases it only on process exit', async () => {
    const rig = makeRig(50);
    const run = cmdRun(resolvedFor(rig), rig.io, rig.deps);
    await waitFor(() => lockHolder(rig.homeDir) === process.pid && rig.signalReady());

    rig.signal('SIGTERM');
    expect(await run).toBe(0); // shutdown hooks resolved

    // CDX-033 regression: the old code had already released the lock here,
    // letting a second bridge start while this process still held its sockets.
    expect(lockHolder(rig.homeDir)).toBe(process.pid);
    expect(() => acquireLock(rig.homeDir)).toThrow(LockHeldError);

    // Only ACTUAL process exit frees it.
    rig.fireExit();
    expect(lockHolder(rig.homeDir)).toBeNull();
    acquireLock(rig.homeDir).release();
  });

  it('schedules the failsafe exit after shutdown completes (CDX-023)', async () => {
    const rig = makeRig(30);
    const run = cmdRun(resolvedFor(rig), rig.io, rig.deps);
    await waitFor(() => lockHolder(rig.homeDir) === process.pid && rig.signalReady());

    rig.signal('SIGTERM');
    expect(await run).toBe(0);
    expect(rig.exitCodes).toEqual([]); // grace period first — no exit hammer yet

    // Lingering third-party handles (nostr-tools' stray 20s ping-race timer)
    // would otherwise keep the process alive; the unref'd failsafe fires.
    await waitFor(() => rig.exitCodes.length === 1);
    expect(rig.exitCodes).toEqual([0]);
    rig.fireExit();
  });

  it('refuses to run while another live process holds the lock', async () => {
    const rig = makeRig(50);
    const held = acquireLock(rig.homeDir);
    try {
      expect(await cmdRun(resolvedFor(rig), rig.io, rig.deps)).toBe(1);
      expect(rig.io.err.text).toContain('already running');
    } finally {
      held.release();
    }
  });
});

/**
 * CDX-038 / CDX-039 — nothing in the bridge refs Node's event loop.
 *
 * Every BridgeCore timer is deliberately unref'd and `process.once('SIGINT')`
 * is not a handle, so the ONLY thing that ever kept a command alive was an open
 * relay socket. With 0 paired phones BridgePool.connect() skips subscribing
 * entirely (no authors to filter on) and opens none — so `run` printed its
 * advice and the process quietly ended with code 0. Same mechanism killed a
 * `pair` window 53s into 600s when the relays dropped its subscription.
 */
describe('holdEventLoop (CDX-038/CDX-039)', () => {
  const timeouts = (): number =>
    process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

  it('actually refs the event loop, and stops once released', () => {
    const before = timeouts();
    const hold = holdEventLoop();
    // A ref'd handle is the whole point: an unref'd one would let the process
    // exit exactly as it did on the device.
    expect(timeouts()).toBe(before + 1);
    hold.release();
    expect(timeouts()).toBe(before);
  });
});

describe('cmdRun with no phones paired (CDX-038)', () => {
  it('stays up and serves pairing itself — a phone pairs against plain `run`', async () => {
    const rig = makeRig(50);
    const run = cmdRun(resolvedFor(rig), rig.io, rig.deps);
    await waitFor(() => rig.signalReady());

    // Old behaviour: this line, then the process was gone.
    expect(rig.io.out.text).toContain('No phones paired yet');
    // It no longer sends the user to a command that cannot run: `pair` takes
    // the same bridge.lock this process is holding.
    expect(rig.io.out.text).not.toContain('run `codedeck-bridge pair`');
    expect(rig.keepAlives).toHaveLength(1);
    expect(rig.keepAlives[0]!.released).toBe(false);

    // The QR + pairing URL are on stdout (host render is async).
    await waitFor(() => rig.io.out.text.includes('Pairing URL: '));
    expect(rig.io.out.text).toMatch(/[▀▄█]/);

    // And it is a REAL window: a phone pairs through it with no second command.
    const bridgeKeys = new CliState(rig.homeDir).identity();
    const phoneKeys = generateKeypair();
    const sim = new PhoneSimulator({
      secretKey: phoneKeys.secretKey,
      bridgePubkey: bridgeKeys.pubkeyHex,
      relay: rig.relay,
    });
    sim.connect();
    sim.pair(tokenFromOutput(rig), 'CDX-038 Phone');
    await sim.until(() => sim.receivedOfType('pair-ack').some((a) => a.ok), { label: 'pair-ack ok' });
    expect(new CliState(rig.homeDir).pairedPhones()).toHaveLength(1);
    expect(rig.io.out.text).toContain('Bridge is now serving it');

    // Still running — pairing is a step in `run`, not the end of it.
    const settled = await Promise.race([run.then(() => 'resolved'), Promise.resolve('pending')]);
    expect(settled).toBe('pending');

    rig.signal('SIGTERM');
    expect(await run).toBe(0);
    expect(rig.keepAlives[0]!.released).toBe(true); // released only on the way out
    rig.fireExit();
  });

  it('re-opens the window while nothing is paired, so a systemd unit started before pairing stays pairable', async () => {
    const rig = makeRig(50);
    const run = cmdRun(resolvedFor(rig), rig.io, { ...rig.deps, pairingWindowMs: 40 });
    await waitFor(() => rig.signalReady());

    await waitFor(() => pairingUrlCount(rig) >= 2, 4000);
    expect(rig.io.out.text).toContain('opening a fresh one');

    // Fresh token each time — an expired window's token must not stay valid.
    const urls = [...rig.io.out.text.matchAll(/Pairing URL: (\S+)/g)].map((m) => m[1]!);
    expect(new Set(urls).size).toBe(urls.length);

    rig.signal('SIGTERM');
    expect(await run).toBe(0);
    rig.fireExit();
  });

  it('a bridge that already has a phone does NOT offer pairing', async () => {
    const rig = makeRig(50);
    // Pair one phone first, exactly as the previous run would have left it.
    mkdirSync(rig.homeDir, { recursive: true });
    const state = new CliState(rig.homeDir);
    const phone = generateKeypair();
    state.setPairedPhones([
      { npub: phone.npub, pubkeyHex: phone.pubkeyHex, label: 'Existing', pairedAt: 'earlier' },
    ]);

    const run = cmdRun(resolvedFor(rig), rig.io, rig.deps);
    await waitFor(() => rig.signalReady());
    await new Promise((r) => setTimeout(r, 60)); // let an async QR render land if it were coming

    expect(rig.io.out.text).not.toContain('No phones paired yet');
    expect(rig.io.out.text).not.toContain('Pairing URL: ');
    expect(rig.io.out.text).toContain('paired:     1 phone(s)');

    rig.signal('SIGTERM');
    expect(await run).toBe(0);
    rig.fireExit();
  });
});

describe('cmdPair outcome reporting (CDX-039)', () => {
  it('names the signal that killed it, and always prints an outcome', async () => {
    const rig = makeRig(50);
    const pair = cmdPair(resolvedFor(rig), rig.io, rig.deps);
    await waitFor(() => rig.signalReady());
    expect(rig.keepAlives).toHaveLength(1);

    rig.signal('SIGTERM');
    expect(await pair).toBe(1);

    // The old handler discarded the signal, so an externally killed `pair` was
    // indistinguishable from one that vanished on its own.
    expect(rig.io.out.text).toContain('Received SIGTERM — aborting pairing.');
    expect(rig.io.out.text).toContain('Pairing aborted.');
    expect(rig.keepAlives[0]!.released).toBe(true);
    rig.fireExit();
  });

  it('reports the expiry outcome rather than ending in silence', async () => {
    const rig = makeRig(50);
    const pair = cmdPair(resolvedFor(rig), rig.io, { ...rig.deps, pairingWindowMs: 40 });
    // Nothing pairs; the window runs out. The process must SAY so.
    expect(await pair).toBe(1);
    expect(rig.io.err.text).toContain('Pairing window expired — no phone paired.');
    expect(rig.keepAlives[0]!.released).toBe(true);
    rig.fireExit();
  });
});
