/**
 * CLI end-to-end: the REAL CLI host (state-file storage, terminal pairing
 * presentation) + REAL BridgeCore against the in-memory relay + PhoneSimulator.
 *
 * This is the first proof of the REAL pairing-window flow end-to-end: the
 * phone takes the token from the pairing URL the host presented, sends an
 * encrypted pair-request through the authorless window, and everything after
 * (heartbeat, session create, input round-trip, truthful offline shutdown)
 * happens as a paired phone — no addPairedPhone() shortcut anywhere.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import {
  BridgeCore,
  disabledMeshAdmin,
  generateKeypair,
  type Keypair,
  type SdkMessage,
} from '@codedeck/core';
import {
  FakeSdkFacade,
  InMemoryRelay,
  PhoneSimulator,
  inMemoryPoolFactory,
} from '@codedeck/testkit';
import { loadCliConfig } from '../config';
import { CliState, lockHolder, acquireLock } from '../state';
import { createCliHost, type CliHost } from '../host';

class CaptureStream extends Writable {
  text = '';
  override _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
    this.text += chunk.toString();
    cb();
  }
}

function initMsg(sdkSessionId: string): SdkMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sdkSessionId,
    model: 'claude-test-1',
    permissionMode: 'plan',
    claude_code_version: '2.0.0',
    apiKeySource: 'none',
    cwd: '/work',
    tools: [],
    mcp_servers: [],
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: 'u-init',
  } as unknown as SdkMessage;
}

function assistantMsg(sdkSessionId: string, text: string): SdkMessage {
  return {
    type: 'assistant',
    session_id: sdkSessionId,
    parent_tool_use_id: null,
    message: { model: 'claude-test-1', content: [{ type: 'text', text }] },
  } as unknown as SdkMessage;
}

interface World {
  dir: string;
  homeDir: string;
  relay: InMemoryRelay;
  facade: FakeSdkFacade;
  state: CliState;
  host: CliHost;
  core: BridgeCore;
  bridgeKeys: Keypair;
  out: CaptureStream;
  err: CaptureStream;
}

const worlds: World[] = [];

afterEach(async () => {
  while (worlds.length > 0) {
    const w = worlds.pop()!;
    await w.core.shutdown();
    await fs.rm(w.dir, { recursive: true, force: true });
  }
});

async function makeWorld(): Promise<World> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codedeck-cli-e2e-'));
  const homeDir = path.join(dir, 'codedeck-home'); // never the real ~/.codedeck
  const wsRoot = path.join(dir, 'workspace');
  mkdirSync(path.join(wsRoot, 'projA'), { recursive: true });

  // Real config resolution with a pinned env (nothing leaks from the test runner).
  const resolved = loadCliConfig(
    { home: homeDir, machineName: 'e2e-machine', workspaces: [wsRoot] },
    {},
  );
  expect(resolved.config.host).toBe('cli');

  const state = new CliState(homeDir);
  const keys = state.identity();
  const out = new CaptureStream();
  const err = new CaptureStream();
  const host = createCliHost({
    config: resolved.config,
    state,
    homeDir,
    npub: keys.npub,
    out,
    err,
  });

  const relay = new InMemoryRelay();
  const facade = new FakeSdkFacade();
  const core = await BridgeCore.start({
    host,
    secretKey: keys.secretKey,
    facade,
    poolFactory: inMemoryPoolFactory(relay),
    meshAdmin: disabledMeshAdmin(), // never touch a real nvpn in tests
    heartbeatIntervalMs: 0,
  });

  const world: World = { dir, homeDir, relay, facade, state, host, core, bridgeKeys: keys, out, err };
  worlds.push(world);
  return world;
}

describe('bridge-cli end-to-end (real pairing-window flow)', () => {
  it('pair (QR token) → heartbeat → session → input round-trip → truthful offline shutdown', async () => {
    const world = await makeWorld();
    const { core, relay, facade, state } = world;

    // --- Pairing window opens; the host presents the QR ---
    const info = core.openPairingWindow({ durationMs: 60_000 });
    expect(core.pairedPhones()).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 20)); // QR render is async
    expect(world.out.text).toContain(`Pairing URL: ${info.url}`);
    expect(world.out.text).toMatch(/[▀▄█]/);

    // --- A wrong-token phone is rejected and NOT paired ---
    const evilKeys = generateKeypair();
    const evil = new PhoneSimulator({
      secretKey: evilKeys.secretKey,
      bridgePubkey: world.bridgeKeys.pubkeyHex,
      relay,
    });
    evil.connect();
    evil.pair('not-the-token', 'Evil Twin');
    await evil.until(
      () => evil.receivedOfType('pair-ack').some((a) => !a.ok && a.reason === 'bad-token'),
      { label: 'bad-token pair-ack' },
    );
    expect(core.pairedPhones()).toHaveLength(0);
    expect(core.pairingWindowOpen).toBe(true);

    // --- The real phone pairs with the token FROM THE PAIRING URL ---
    const token = new URL(info.url.replace('codedeck://', 'https://x/')).searchParams.get('token')!;
    expect(token).toBe(info.token);
    const phoneKeys = generateKeypair();
    const sim = new PhoneSimulator({
      secretKey: phoneKeys.secretKey,
      bridgePubkey: world.bridgeKeys.pubkeyHex,
      relay,
    });
    sim.connect();
    sim.pair(token, 'E2E Pixel');
    await sim.until(() => sim.receivedOfType('pair-ack').some((a) => a.ok), { label: 'pair-ack ok' });

    expect(core.pairingWindowOpen).toBe(false);
    expect(core.pairedPhones().map((p) => p.pubkeyHex)).toEqual([phoneKeys.pubkeyHex]);

    // Persisted through the CLI state file (0600), same key BridgeCore reads back.
    expect((statSync(state.statePath).mode & 0o777)).toBe(0o600);
    const onDisk = JSON.parse(readFileSync(state.statePath, 'utf8')) as {
      kv: Record<string, string>;
    };
    expect(onDisk.kv.pairedPhones).toContain(phoneKeys.pubkeyHex);
    expect(new CliState(world.homeDir).pairedPhones()[0]!.label).toBe('E2E Pixel');

    // Greeting heartbeat with capabilities + folders reached the paired phone.
    await sim.until(() => sim.sessionListCount >= 1, { label: 'greeting heartbeat' });
    expect(sim.machineName).toBe('e2e-machine');
    expect(sim.folders).toContain('projA');

    // --- Create a session in a folder ---
    sim.createSession({ cwd: 'projA' });
    await sim.until(() => facade.sessions.size === 1, { label: 'SDK session spawned' });
    const sessionId = [...facade.sessions.keys()][0]!;
    facade.emit(sessionId, initMsg(`sdk-${sessionId}`));
    await sim.until(
      () => sim.receivedOfType('session-ready').some((m) => m.pendingId === sessionId),
      { label: 'session-ready' },
    );

    // --- Input round-trip: phone → bridge (ack) → SDK; output → phone transcript ---
    sim.input(sessionId, 'hello from the e2e phone', 'in-1');
    await sim.until(
      () => sim.receivedOfType('input-ack').some((a) => a.inputId === 'in-1'),
      { label: 'input-ack' },
    );
    // The runner may append the session-meta request to the first message —
    // assert the text arrived, not byte equality.
    expect(facade.sessions.get(sessionId)!.inputs[0]).toContain('hello from the e2e phone');

    facade.emit(sessionId, assistantMsg(`sdk-${sessionId}`, 'echo back'));
    await sim.until(
      () => sim.transcriptEntries(sessionId).some(({ entry }) => entry.content.includes('echo back')),
      { label: 'assistant output in phone transcript' },
    );

    // --- Model list round-trip (CDX-022): the phone's session-header flow ---
    facade.models = [{ id: 'claude-opus-4-8', label: 'Opus' }, { id: 'claude-sonnet-4-6' }];
    sim.requestModels();
    await sim.until(() => sim.receivedOfType('models').length >= 1, { label: 'models event' });
    const modelsMsg = sim.receivedOfType('models')[0]!;
    expect(modelsMsg.models.length).toBeGreaterThan(0);
    expect(modelsMsg.models).toEqual([
      { id: 'claude-opus-4-8', label: 'Opus' },
      { id: 'claude-sonnet-4-6' },
    ]);

    // --- Graceful shutdown (what SIGINT/SIGTERM triggers): truthful, never empty ---
    await world.host.runShutdownHooks();
    await sim.until(() => sim.machineOffline, { label: 'offline session list' });
    const last = sim.lastSessionList!;
    expect(last.machineOffline).toBe(true);
    expect(last.sessions.length).toBeGreaterThan(0);
    expect(last.sessions.every((s) => s.state === 'offline')).toBe(true);
    expect(sim.session(sessionId)?.presence).toBe('offline');

    // Nothing on either side ever failed validation.
    expect(sim.receivedInvalid).toEqual([]);
    expect(sim.seqConflicts).toEqual([]);
  });

  it('pairing window expiry leaves nothing paired, and a second bridge on the same home is refused by the lock', async () => {
    const world = await makeWorld();

    // Expiry path.
    let closed: string | null = null;
    world.core.openPairingWindow({ durationMs: 30, onClosed: (r) => { closed = r; } });
    await new Promise((r) => setTimeout(r, 80));
    expect(closed).toBe('expired');
    expect(world.core.pairingWindowOpen).toBe(false);
    expect(world.core.pairedPhones()).toHaveLength(0);

    // Double-run refusal on the same CODEDECK_HOME.
    const lock = acquireLock(world.homeDir);
    expect(lockHolder(world.homeDir)).toBe(process.pid);
    expect(() => acquireLock(world.homeDir)).toThrow(/already running \(pid \d+\)/);
    lock.release();
  });
});
