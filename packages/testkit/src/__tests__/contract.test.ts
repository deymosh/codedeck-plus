/**
 * CDX-008 — end-to-end contract tests: REAL BridgeCore (fake SDK facade) +
 * REAL InMemoryRelay + PhoneSimulator. Every phone→bridge command crosses the
 * relay as a real NIP-44-encrypted kind-4515 event through the real ingest;
 * everything the bridge publishes is decrypted + codec-validated the way the
 * phone must. These scenarios are the executable protocol contract:
 *
 *   A  restart → resume-on-boot → sync gap-refill (the bug-B acceptance test)
 *   B  dropped sync chunks: bridge retry heals; retries-exhausted → honest
 *      partial sync-end → phone re-request heals
 *   C  seq monotonicity across restart with concurrent live output
 *   D  heartbeat truth: state transitions, absence-never-deletes, tombstones,
 *      offline shutdown never publishes an empty list
 *   E  invalid payloads (bad encryption / bad JSON / wrong schema) are
 *      logged + dropped on BOTH sides — never a crash, never corrupted state
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { finalizeEvent } from 'nostr-tools/pure';
import {
  BridgeCore,
  encryptTo,
  generateKeypair,
  type BridgeHost,
  type Keypair,
  type PairingHandle,
  type PairingPayload,
  type SdkCanUseTool,
  type SdkMessage,
} from '@codedeck/core';
import {
  COMMAND_KIND,
  RESPONSE_KIND,
  SESSION_LIST_KIND,
  PROTOCOL_VERSION,
  encodeBridgeToPhone,
  type BridgeToPhoneMessage,
} from '@codedeck/protocol';
import { FakeSdkFacade } from '../fakeSdk';
import { InMemoryRelay } from '../inMemoryRelay';
import { ManualTimers } from '../manualTimers';
import { inMemoryPoolFactory } from '../relayPool';
import { PhoneSimulator } from '../phoneSimulator';

// --- Harness ---

interface World {
  dir: string;
  stateDir: string;
  wsRoot: string;
  storage: Map<string, string>;
  relay: InMemoryRelay;
  bridgeKeys: Keypair;
  phoneKeys: Keypair;
  sim: PhoneSimulator;
  logs: string[];
  cores: BridgeCore[];
  start(facade: FakeSdkFacade, opts?: { syncTimers?: ManualTimers; fetchFn?: typeof fetch }): Promise<BridgeCore>;
  cleanup(): Promise<void>;
}

const worlds: World[] = [];

afterEach(async () => {
  while (worlds.length > 0) {
    await worlds.pop()!.cleanup();
  }
});

async function makeWorld(opts: { paired?: boolean } = {}): Promise<World> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codedeck-contract-'));
  const stateDir = path.join(dir, 'state');
  const wsRoot = path.join(dir, 'workspace');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(path.join(wsRoot, 'projA'), { recursive: true });

  const storage = new Map<string, string>();
  const relay = new InMemoryRelay();
  const bridgeKeys = generateKeypair();
  const phoneKeys = generateKeypair();
  if (opts.paired !== false) {
    storage.set('pairedPhones', JSON.stringify([
      { npub: phoneKeys.npub, pubkeyHex: phoneKeys.pubkeyHex, label: 'phone', pairedAt: new Date().toISOString() },
    ]));
  }

  const sim = new PhoneSimulator({
    secretKey: phoneKeys.secretKey,
    bridgePubkey: bridgeKeys.pubkeyHex,
    relay,
  });

  const logs: string[] = [];
  const cores: BridgeCore[] = [];
  const host: BridgeHost = {
    config: {
      machineName: 'contract-machine',
      host: 'cli',
      relays: ['wss://in-memory.test'],
      workspaceRoots: [wsRoot],
    },
    storage: {
      get: async (k) => storage.get(k),
      set: async (k, v) => { storage.set(k, v); },
      delete: async (k) => { storage.delete(k); },
    },
    sessionStateDir: () => stateDir,
    log: (_level, msg) => { logs.push(msg); },
    notify: () => {},
    presentPairing: (_payload: PairingPayload): PairingHandle => ({ close: () => {} }),
    onShutdown: () => {},
  };

  const world: World = {
    dir, stateDir, wsRoot, storage, relay, bridgeKeys, phoneKeys, sim, logs, cores,
    start: async (facade, o = {}) => {
      const core = await BridgeCore.start({
        host,
        secretKey: bridgeKeys.secretKey,
        facade,
        poolFactory: inMemoryPoolFactory(relay),
        heartbeatIntervalMs: 0, // no timer churn — publishes are event-driven in tests
        ...(o.syncTimers ? { syncTimers: o.syncTimers } : {}),
        ...(o.fetchFn ? { fetchFn: o.fetchFn } : {}),
      });
      cores.push(core);
      return core;
    },
    cleanup: async () => {
      for (const core of cores) await core.shutdown(); // idempotent
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
  worlds.push(world);
  return world;
}

// --- SDK message builders (same shapes bridge.test.ts drives) ---

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

function assistantMsg(sdkSessionId: string, ...texts: string[]): SdkMessage {
  return {
    type: 'assistant',
    session_id: sdkSessionId,
    parent_tool_use_id: null,
    message: {
      model: 'claude-test-1',
      content: texts.map((text) => ({ type: 'text', text })),
    },
  } as unknown as SdkMessage;
}

function stateMsg(sdkSessionId: string, state: 'idle' | 'running'): SdkMessage {
  return {
    type: 'system',
    subtype: 'session_state_changed',
    session_id: sdkSessionId,
    state,
  } as unknown as SdkMessage;
}

/** Drive create-session → SDK init → session-ready via the simulator. */
async function createReadySession(
  world: World,
  facade: FakeSdkFacade,
  opts: { cwd?: string } = {},
): Promise<string> {
  const before = facade.sessions.size;
  world.sim.createSession(opts.cwd ? { cwd: opts.cwd } : {});
  await world.sim.until(() => facade.sessions.size > before, { label: 'SDK session spawned' });
  const sessionId = [...facade.sessions.keys()].at(-1)!;
  facade.emit(sessionId, initMsg(`sdk-${sessionId}`));
  await world.sim.until(
    () => world.sim.receivedOfType('session-ready').some((m) => m.pendingId === sessionId),
    { label: 'session-ready received' },
  );
  return sessionId;
}

/** Invoke the canUseTool callback the core wired into the SDK session, the way
 *  the real SDK would (only toolUseID & co. are consumed by the broker). */
function askPermission(
  facade: FakeSdkFacade,
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseID: string,
): ReturnType<SdkCanUseTool> {
  return facade.canUseTool(sessionId)(toolName, toolInput, {
    signal: new AbortController().signal,
    requestId: toolUseID,
    toolUseID,
  } as Parameters<SdkCanUseTool>[2]);
}

/** Publish a crafted bridge-signed event (a "buggy/evil bridge" for contract checks). */
function publishFromBridge(
  world: World,
  content: string,
  kind: number,
  extraTags: string[][] = [],
): void {
  const createdAt = Math.floor(Date.now() / 1000);
  world.relay.publish(finalizeEvent(
    {
      kind,
      created_at: createdAt,
      tags: [['p', world.phoneKeys.pubkeyHex], ...extraTags],
      content,
    },
    world.bridgeKeys.secretKey,
  ));
}

// --- Scenarios ---

describe('contract: BridgeCore ⇄ PhoneSimulator over the in-memory relay', () => {
  it(
    'Scenario A: pair → session in folder → live output → permission → plan approval → RESTART → resume → sync gap-refill',
    async () => {
      const world = await makeWorld({ paired: false });
      const facade1 = new FakeSdkFacade();
      const core1 = await world.start(facade1);

      // Pair the phone (host-side registration; the QR pairing window is a later
      // CDX-005 sub-item) — the bridge greets it with a heartbeat.
      world.sim.connect();
      await core1.addPairedPhone({
        npub: world.phoneKeys.npub,
        pubkeyHex: world.phoneKeys.pubkeyHex,
        label: 'phone',
        pairedAt: new Date().toISOString(),
      });
      await world.sim.until(() => world.sim.sessionListCount >= 1, { label: 'greeting heartbeat' });
      expect(world.sim.capabilities).toContain('sync/1');
      expect(world.sim.folders).toContain('projA');
      expect(world.sim.lastSessionList?.protocolVersion).toBe(PROTOCOL_VERSION);

      // Create a session in a workspace folder.
      const sessionId = await createReadySession(world, facade1, { cwd: 'projA' });
      expect(facade1.session(sessionId).options.cwd).toBe(path.join(world.wsRoot, 'projA'));
      await world.sim.until(() => world.sim.session(sessionId) !== undefined, { label: 'session listed' });

      // Live output over ephemeral 24515.
      facade1.emit(sessionId, assistantMsg(`sdk-${sessionId}`, 'hello from claude'));
      await world.sim.until(() => world.sim.transcriptSeqs(sessionId).length === 2, { label: 'live output' });

      // Permission card round trip (plan mode forwards Bash to the phone).
      const permissionPromise = askPermission(facade1, sessionId, 'Bash', { command: 'ls' }, 'tu-perm-1');
      await world.sim.until(() => world.sim.permissionCards(sessionId).length === 1, { label: 'permission card' });
      const card = world.sim.permissionCards(sessionId)[0]!;
      expect(card.toolName).toBe('Bash');
      expect(card.requestId).toBe('tu-perm-1');
      world.sim.permissionResponse(sessionId, card.requestId, true);
      await expect(permissionPromise).resolves.toMatchObject({ behavior: 'allow' });

      // Plan approval round trip: pending ExitPlanMode surfaces as
      // waiting_permission; keypress '1' approves + flips to acceptEdits.
      const planPromise = askPermission(facade1, sessionId, 'ExitPlanMode', { plan: 'the plan' }, 'tu-plan-1');
      await world.sim.until(
        () => world.sim.session(sessionId)?.info.state === 'waiting_permission',
        { label: 'plan pending visible' },
      );
      world.sim.approvePlan(sessionId, '1');
      await expect(planPromise).resolves.toMatchObject({ behavior: 'allow' });
      await world.sim.until(
        () => world.sim.receivedOfType('mode-confirmed').some((m) => m.mode === 'acceptEdits'),
        { label: 'acceptEdits confirmed' },
      );
      expect(facade1.session(sessionId).modes).toContain('acceptEdits');

      facade1.emit(sessionId, assistantMsg(`sdk-${sessionId}`, 'work done'));
      const preRestartHigh = 4; // init, hello, permission card, work done
      await world.sim.until(
        () => world.sim.hasContiguousTranscript(sessionId, preRestartHigh),
        { label: 'pre-restart transcript' },
      );

      // KILL the bridge. The phone sees a truthful offline list, then goes dark.
      await core1.shutdown();
      await world.sim.until(
        () => world.sim.machineOffline && world.sim.session(sessionId)?.presence === 'offline',
        { label: 'offline heartbeat' },
      );
      expect(world.sim.lastSessionList!.sessions.length).toBeGreaterThan(0);
      world.sim.disconnect();

      // RESTART: a brand-new BridgeCore over the same state dir resumes the
      // session — and produces output the disconnected phone misses.
      const facade2 = new FakeSdkFacade();
      const core2 = await world.start(facade2);
      await world.sim.until(() => facade2.sessions.has(sessionId), { label: 'resume-on-boot' });
      expect(facade2.session(sessionId).options.resume).toBe(`sdk-${sessionId}`);
      // Replayed commands from the `since` grace window must NOT re-execute:
      // exactly the one resumed session, no duplicates.
      expect(facade2.sessions.size).toBe(1);

      facade2.emit(sessionId, assistantMsg(`sdk-${sessionId}`, 'missed-1', 'missed-2'));
      await world.sim.until(
        () => core2.transcript.seqHigh(sessionId) === preRestartHigh + 2,
        { label: 'post-restart output persisted' },
      );

      // Phone reconnects and — per the plan's connect procedure — refreshes the
      // session list (the boot heartbeat's seqHigh predates the new output),
      // then requests a sync with its haveRanges; the gap-refill completes.
      world.sim.connect();
      world.sim.refreshSessions();
      await world.sim.until(
        () => world.sim.session(sessionId)?.info.seqHigh === preRestartHigh + 2,
        { label: 'reconnect heartbeat with new seqHigh' },
      );
      expect(world.sim.hasContiguousTranscript(sessionId, preRestartHigh + 2)).toBe(false);
      world.sim.syncNow(sessionId);
      await world.sim.until(
        () => world.sim.hasContiguousTranscript(sessionId, preRestartHigh + 2),
        { label: 'sync gap-refill' },
      );

      // Phone transcript is contiguous AND identical to the bridge's store;
      // seqs stayed monotonic across the restart (no renumbering conflicts).
      const bridgeLines = await core2.transcript.readRange(sessionId, [1, preRestartHigh + 2]);
      expect(world.sim.transcriptEntries(sessionId)).toEqual(bridgeLines);
      expect(world.sim.seqConflicts).toEqual([]);
      const sync = [...world.sim.syncs.values()].at(-1)!;
      expect(sync.end?.deliveredRanges).toEqual([[preRestartHigh + 1, preRestartHigh + 2]]);
    },
    15000,
  );

  it('Scenario B1: a dropped sync chunk is healed by the bridge retry pass', async () => {
    const world = await makeWorld();
    const timers = new ManualTimers();
    const facade = new FakeSdkFacade();
    const core = await world.start(facade, { syncTimers: timers });
    world.sim.connect();
    const sessionId = await createReadySession(world, facade);

    // Build a 61-entry transcript (init + 60 texts) while the phone is dark →
    // two sync chunks ([1,50], [51,61]).
    world.sim.disconnect();
    facade.emit(sessionId, assistantMsg(
      `sdk-${sessionId}`,
      ...Array.from({ length: 60 }, (_, i) => `entry-${i + 1}`),
    ));
    await world.sim.until(() => core.transcript.seqHigh(sessionId) === 61, { label: '61 entries persisted' });

    world.sim.connect();
    world.sim.dropNextSyncChunks = 1; // lose the first chunk on the wire
    world.sim.syncNow(sessionId);
    await world.sim.until(
      () => world.sim.droppedChunks.length === 1 && world.sim.receivedOfType('sync-chunk').length === 1,
      { label: 'chunk 1 dropped, chunk 2 delivered' },
    );
    expect(world.sim.hasContiguousTranscript(sessionId)).toBe(false);

    // Ack timeout elapses → the bridge resends the unacked chunk → healed.
    // (Wait for the ack-check timer to exist before advancing: idle + ack = 2.)
    await world.sim.until(() => timers.pendingCount() === 2, { label: 'ack timer scheduled' });
    timers.advance(10_000);
    await world.sim.until(() => world.sim.hasContiguousTranscript(sessionId, 61), { label: 'retry healed the gap' });
    await world.sim.until(() => world.sim.receivedOfType('sync-end').length === 1, { label: 'sync-end' });
    expect(world.sim.receivedOfType('sync-end')[0]!.deliveredRanges).toEqual([[1, 61]]);
    expect(world.sim.seqConflicts).toEqual([]);
  }, 10000);

  it('Scenario B2: retries exhausted → honest partial sync-end → phone re-request heals', async () => {
    const world = await makeWorld();
    const timers = new ManualTimers();
    const facade = new FakeSdkFacade();
    const core = await world.start(facade, { syncTimers: timers });
    world.sim.connect();
    const sessionId = await createReadySession(world, facade);

    world.sim.disconnect();
    facade.emit(sessionId, assistantMsg(
      `sdk-${sessionId}`,
      ...Array.from({ length: 60 }, (_, i) => `entry-${i + 1}`),
    ));
    await world.sim.until(() => core.transcript.seqHigh(sessionId) === 61, { label: '61 entries persisted' });

    world.sim.connect();
    // Lose chunk [1,50] on the initial pass AND both retry passes; [51,61]
    // gets through and is acked normally.
    world.sim.dropChunkIf = ({ range }) => range[0] === 1;
    world.sim.syncNow(sessionId);
    // At each stage wait for the ack-check timer to be scheduled (idle + ack = 2
    // pending) before advancing virtual time — no real waits, no races.
    await world.sim.until(
      () => world.sim.droppedChunks.length === 1 && timers.pendingCount() === 2,
      { label: 'initial send dropped, ack timer armed' },
    );
    timers.advance(10_000); // retry pass 1
    await world.sim.until(
      () => world.sim.droppedChunks.length === 2 && timers.pendingCount() === 2,
      { label: 'retry 1 dropped, ack timer re-armed' },
    );
    timers.advance(20_000); // retry pass 2
    await world.sim.until(
      () => world.sim.droppedChunks.length === 3 && timers.pendingCount() === 2,
      { label: 'retry 2 dropped, ack timer re-armed' },
    );
    world.sim.dropChunkIf = null; // the wire recovers
    timers.advance(40_000); // retries exhausted → honest partial sync-end

    // sync-end reports ONLY what was acked; the phone then re-requests the
    // difference (the simulator's sync client does this on sync-end) and heals.
    await world.sim.until(() => world.sim.hasContiguousTranscript(sessionId, 61), {
      label: 'phone re-request healed the gap',
      timeoutMs: 4000,
    });
    const ends = world.sim.receivedOfType('sync-end');
    expect(ends.length).toBe(2);
    expect(ends[0]!.deliveredRanges).toEqual([[51, 61]]); // honesty over completeness
    expect(ends[1]!.deliveredRanges).toEqual([[1, 50]]); // the healing re-request
  }, 10000);

  it('Scenario C: seq monotonicity across restart with concurrent live output — no renumbering', async () => {
    const world = await makeWorld();
    const facade1 = new FakeSdkFacade();
    const core1 = await world.start(facade1);
    world.sim.connect();
    const sessionId = await createReadySession(world, facade1);

    facade1.emit(sessionId, assistantMsg(`sdk-${sessionId}`, 'alpha', 'beta'));
    await world.sim.until(() => world.sim.hasContiguousTranscript(sessionId, 3), { label: 'run-1 transcript' });
    await core1.shutdown();

    // Phone STAYS connected across the restart; the new bridge emits live
    // output immediately — seqs must continue, never restart from 1.
    const facade2 = new FakeSdkFacade();
    const core2 = await world.start(facade2);
    await world.sim.until(() => facade2.sessions.has(sessionId), { label: 'resume-on-boot' });
    facade2.emit(sessionId, assistantMsg(`sdk-${sessionId}`, 'gamma', 'delta'));

    await world.sim.until(() => world.sim.hasContiguousTranscript(sessionId, 5), { label: 'run-2 live output' });
    expect(core2.transcript.seqHigh(sessionId)).toBe(5);
    expect(world.sim.seqConflicts).toEqual([]); // same seq never re-used for different content

    // Live output seqs, in arrival order, are strictly increasing across the restart.
    const liveSeqs = world.sim.receivedOfType('output')
      .filter((m) => m.sessionId === sessionId)
      .map((m) => m.seq);
    expect(liveSeqs).toEqual([...liveSeqs].sort((a, b) => a - b));
    expect(new Set(liveSeqs).size).toBe(liveSeqs.length);
  }, 10000);

  it('Scenario D: heartbeat truth — states, absence never deletes, tombstones, offline shutdown', async () => {
    const world = await makeWorld();
    const facade = new FakeSdkFacade();
    const core = await world.start(facade);
    world.sim.connect();
    const sessionId = await createReadySession(world, facade);

    // State transitions flow into the heartbeat.
    facade.emit(sessionId, stateMsg(`sdk-${sessionId}`, 'running'));
    await world.sim.until(() => world.sim.session(sessionId)?.info.state === 'running', { label: 'running state' });

    const pending = askPermission(facade, sessionId, 'Bash', { command: 'rm -rf /' }, 'tu-d1');
    await world.sim.until(
      () => world.sim.session(sessionId)?.info.state === 'waiting_permission',
      { label: 'waiting_permission visible' },
    );
    world.sim.permissionResponse(sessionId, 'tu-d1', false);
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
    await world.sim.until(() => world.sim.session(sessionId)?.info.state === 'running', { label: 'back to running' });

    // A buggy bridge publishing a SHORT list must not delete anything on the
    // phone: absence marks stale, never removes.
    publishFromBridge(
      world,
      encryptTo(world.bridgeKeys.secretKey, world.phoneKeys.pubkeyHex, encodeBridgeToPhone({
        type: 'sessions',
        machine: 'contract-machine',
        sessions: [],
        protocolVersion: PROTOCOL_VERSION,
      } as BridgeToPhoneMessage)),
      SESSION_LIST_KIND,
      [['d', 'contract-machine']],
    );
    await world.sim.until(() => world.sim.session(sessionId)?.presence === 'stale', { label: 'marked stale' });
    expect(world.sim.session(sessionId)).toBeDefined();

    // Pull-to-refresh restores it to live.
    world.sim.refreshSessions();
    await world.sim.until(() => world.sim.session(sessionId)?.presence === 'live', { label: 'live again' });

    // Explicit tombstone is the ONLY removal path.
    const second = await createReadySession(world, facade);
    world.sim.closeSession(second);
    await world.sim.until(
      () => world.sim.session(second) === undefined
        && world.sim.receivedOfType('close-session-ack').some((m) => m.sessionId === second),
      { label: 'tombstoned session removed' },
    );
    expect(world.sim.session(sessionId)).toBeDefined();

    // Graceful shutdown: sessions stay listed as offline — NEVER an empty list.
    await core.shutdown();
    await world.sim.until(() => world.sim.machineOffline, { label: 'machineOffline heartbeat' });
    expect(world.sim.lastSessionList!.machineOffline).toBe(true);
    expect(world.sim.lastSessionList!.sessions.length).toBe(1);
    expect(world.sim.lastSessionList!.sessions[0]).toMatchObject({ id: sessionId, state: 'offline' });
    expect(world.sim.session(sessionId)?.presence).toBe('offline');
  }, 10000);

  it('Scenario E1: invalid phone→bridge payloads are logged + dropped; the bridge keeps working', async () => {
    const world = await makeWorld();
    const facade = new FakeSdkFacade();
    await world.start(facade);
    world.sim.connect();
    await world.sim.until(() => world.sim.sessionListCount >= 1, { label: 'boot heartbeat' });

    const createdAt = Math.floor(Date.now() / 1000);
    const craft = (content: string) => {
      world.relay.publish(finalizeEvent(
        {
          kind: COMMAND_KIND,
          created_at: createdAt,
          tags: [['p', world.bridgeKeys.pubkeyHex]],
          content,
        },
        world.phoneKeys.secretKey,
      ));
    };
    craft('this-is-not-nip44-ciphertext');
    craft(encryptTo(world.phoneKeys.secretKey, world.bridgeKeys.pubkeyHex, 'not json at all'));
    craft(encryptTo(world.phoneKeys.secretKey, world.bridgeKeys.pubkeyHex, JSON.stringify({ type: 'input' })));

    await world.sim.until(
      () => world.logs.some((l) => l.includes('Failed to decrypt'))
        && world.logs.some((l) => l.includes('Dropping invalid payload')),
      { label: 'bridge logged + dropped' },
    );

    // No crash, no corrupted state: a valid command still round-trips, and no
    // ghost session was spawned by the garbage.
    expect(facade.sessions.size).toBe(0);
    world.sim.refreshSessions();
    await world.sim.until(() => world.sim.sessionListCount >= 2, { label: 'bridge still alive' });
    const sessionId = await createReadySession(world, facade);
    expect(world.sim.session(sessionId)).toBeDefined();
  });

  it('Scenario E2: invalid bridge→phone payloads are recorded + dropped; the phone keeps working', async () => {
    const world = await makeWorld();
    const facade = new FakeSdkFacade();
    await world.start(facade);
    world.sim.connect();
    const sessionId = await createReadySession(world, facade);
    const listsBefore = world.sim.sessionListCount;
    const seqsBefore = world.sim.transcriptSeqs(sessionId);

    publishFromBridge(world, 'garbage-not-ciphertext', RESPONSE_KIND);
    publishFromBridge(
      world,
      encryptTo(world.bridgeKeys.secretKey, world.phoneKeys.pubkeyHex, 'not json'),
      RESPONSE_KIND,
    );
    publishFromBridge(
      world,
      encryptTo(
        world.bridgeKeys.secretKey,
        world.phoneKeys.pubkeyHex,
        JSON.stringify({ type: 'output', sessionId }), // wrong schema: no seq/entry
      ),
      RESPONSE_KIND,
    );

    await world.sim.until(() => world.sim.receivedInvalid.length === 3, { label: 'all three recorded' });
    expect(world.sim.receivedInvalid.map((r) => r.stage)).toEqual(['decrypt', 'decode', 'decode']);

    // Nothing was applied, nothing crashed: view + transcript unchanged, and
    // valid traffic still flows.
    expect(world.sim.sessionListCount).toBe(listsBefore);
    expect(world.sim.transcriptSeqs(sessionId)).toEqual(seqsBefore);
    facade.emit(sessionId, assistantMsg(`sdk-${sessionId}`, 'still alive'));
    await world.sim.until(
      () => world.sim.transcriptSeqs(sessionId).length === seqsBefore.length + 1,
      { label: 'valid output still applied' },
    );
    expect(world.sim.seqConflicts).toEqual([]);
  });

  it('input round-trip: ack echoes inputId; unknown session gets input-failed', async () => {
    const world = await makeWorld();
    const facade = new FakeSdkFacade();
    await world.start(facade);
    world.sim.connect();
    const sessionId = await createReadySession(world, facade);

    world.sim.input(sessionId, 'do the thing', 'in-1');
    await world.sim.until(
      () => world.sim.receivedOfType('input-ack').some((m) => m.inputId === 'in-1'),
      { label: 'input-ack' },
    );
    expect(facade.session(sessionId).inputs[0]).toContain('do the thing');

    world.sim.input('ghost-session', 'hello?', 'in-2');
    await world.sim.until(
      () => world.sim.receivedOfType('input-failed').some((m) => m.inputId === 'in-2'),
      { label: 'input-failed' },
    );
    expect(world.sim.receivedOfType('input-failed')[0]).toMatchObject({
      sessionId: 'ghost-session',
      reason: 'no-session',
    });
  });

  it('folders: create-folder is acked + advertised, and a session can be created inside it', async () => {
    const world = await makeWorld();
    const facade = new FakeSdkFacade();
    await world.start(facade);
    world.sim.connect();

    world.sim.createFolder('newproj', 'rq-1');
    await world.sim.until(
      () => world.sim.receivedOfType('folder-ack').some((m) => m.requestId === 'rq-1' && m.success),
      { label: 'folder-ack' },
    );
    await world.sim.until(() => world.sim.folders.includes('newproj'), { label: 'folder advertised' });

    const sessionId = await createReadySession(world, facade, { cwd: 'newproj' });
    expect(facade.session(sessionId).options.cwd).toBe(path.join(world.wsRoot, 'newproj'));
  });

  it('until: rejects with the label after the timeout (no silent hangs)', async () => {
    const world = await makeWorld();
    await expect(
      world.sim.until(() => false, { timeoutMs: 30, label: 'never happens' }),
    ).rejects.toThrow(/never happens/);
  });
});

  it('usage round-trip: usage-request over the wire → normalized usage snapshot on the phone', async () => {
    const world = await makeWorld();
    const facade = new FakeSdkFacade();
    await world.start(facade);
    world.sim.connect();

    const sessionId = await createReadySession(world, facade);
    facade.session(sessionId).usageSnapshot = {
      rate_limits_available: true,
      subscription_type: 'max',
      rate_limits: {
        five_hour: { utilization: 61, resets_at: '2026-08-05T15:00:00Z' },
        seven_day: { utilization: 12, resets_at: '2026-08-10T00:00:00Z' },
      },
      session: { total_cost_usd: 2.5 },
    };

    world.sim.requestUsage(sessionId);
    await world.sim.until(
      () => world.sim.receivedOfType('usage').length === 1,
      { label: 'usage snapshot received' },
    );

    const usage = world.sim.receivedOfType('usage')[0]!;
    expect(usage.sessionId).toBe(sessionId);
    expect(usage.usage.available).toBe(true);
    expect(usage.usage.subscriptionType).toBe('max');
    expect(usage.usage.fiveHour).toEqual({ utilization: 61, resetsAt: '2026-08-05T15:00:00Z' });
    expect(usage.usage.sevenDay).toEqual({ utilization: 12, resetsAt: '2026-08-10T00:00:00Z' });
    expect(usage.usage.sessionCostUsd).toBe(2.5);
    // Codec-validated on arrival — zero invalid payloads.
    expect(world.sim.receivedInvalid).toEqual([]);
  });

// --- CDX-062: custom provider profiles, full wire round-trip ---

describe('contract: custom provider profiles (CDX-062)', () => {
  const KIMI_TOKEN = 'sk-kimi-CONTRACT-SECRET-42';

  it('set-profile → ack(tokenValid) → redacted list → create(providerId) → provider env → usage silent', async () => {
    const world = await makeWorld();
    const facade = new FakeSdkFacade();
    const fetched: Array<{ url: string; init?: RequestInit }> = [];
    await world.start(facade, {
      fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
        fetched.push({ url: String(url), init });
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });
    world.sim.connect();

    // The bridge advertises the capability the phone must gate on.
    await world.sim.until(() => world.sim.capabilities.includes('custom-providers'),
      { label: 'custom-providers capability advertised' });

    // 1. Store the profile from the phone.
    world.sim.setProviderProfile('kimi', {
      label: 'Kimi K3',
      baseUrl: 'https://api.moonshot.ai/anthropic',
      authToken: KIMI_TOKEN,
      models: [{ id: 'kimi-k3', label: 'Kimi K3' }],
      defaultModel: 'kimi-k3',
    });
    await world.sim.until(() => world.sim.receivedOfType('provider-profile-ack').length === 1,
      { label: 'provider-profile-ack' });
    expect(world.sim.receivedOfType('provider-profile-ack')[0]).toMatchObject({
      profileId: 'kimi', success: true, tokenValid: true,
    });
    // Validation hit the provider's own endpoint with a Bearer header.
    expect(fetched[0]!.url).toBe('https://api.moonshot.ai/anthropic/v1/messages');
    expect((fetched[0]!.init?.headers as Record<string, string>)['Authorization'])
      .toBe(`Bearer ${KIMI_TOKEN}`);

    // 2. The redacted broadcast + an explicit re-request both answer.
    await world.sim.until(() => world.sim.receivedOfType('provider-profiles').length >= 1,
      { label: 'provider-profiles broadcast' });
    expect(world.sim.receivedOfType('provider-profiles')[0]!.profiles).toEqual([{
      id: 'kimi',
      label: 'Kimi K3',
      baseUrl: 'https://api.moonshot.ai/anthropic',
      models: [{ id: 'kimi-k3', label: 'Kimi K3' }],
      defaultModel: 'kimi-k3',
      hasToken: true,
    }]);
    world.sim.requestProviderProfiles();
    await world.sim.until(() => world.sim.receivedOfType('provider-profiles').length >= 2,
      { label: 'provider-profiles answer to request' });

    // The token NEVER crossed the wire bridge→phone.
    expect(JSON.stringify(world.sim.received)).not.toContain(KIMI_TOKEN);

    // 3. Create a bound session; the spawn env is the D4 recipe.
    world.sim.createSession({ providerId: 'kimi' });
    await world.sim.until(() => facade.sessions.size === 1, { label: 'SDK session spawned' });
    const sessionId = [...facade.sessions.keys()][0]!;
    const opts = facade.session(sessionId).options;
    expect(opts.model).toBe('kimi-k3');
    expect(opts.fallbackModel).toBeNull();
    expect(opts.env?.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
    expect(opts.env?.ANTHROPIC_AUTH_TOKEN).toBe(KIMI_TOKEN);
    expect(opts.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(opts.env?.ANTHROPIC_SMALL_FAST_MODEL).toBe('kimi-k3');

    facade.emit(sessionId, initMsg(`sdk-${sessionId}`));
    await world.sim.until(
      () => world.sim.receivedOfType('session-ready').some((m) => m.pendingId === sessionId),
      { label: 'session-ready' },
    );

    // 4. The session list names the provider on the session.
    await world.sim.until(() => {
      const info = world.sim.session(sessionId)?.info;
      return info?.providerId === 'kimi' && info?.providerLabel === 'Kimi K3';
    }, { label: 'session list carries provider id + label' });

    // 5. Usage honesty: the bridge withholds usage for the bound session.
    facade.session(sessionId).usageSnapshot = {
      rate_limits_available: true,
      subscription_type: 'max',
      rate_limits: { five_hour: { utilization: 61, resets_at: '2026-08-09T15:00:00Z' } },
    };
    const listsBefore = world.sim.sessionListCount;
    world.sim.requestUsage(sessionId);
    world.sim.refreshSessions(); // marker: sequence the assertion after the request
    await world.sim.until(() => world.sim.sessionListCount > listsBefore, { label: 'marker heartbeat' });
    expect(world.sim.receivedOfType('usage')).toEqual([]);

    // Everything decoded clean — zero invalid payloads on the phone.
    expect(world.sim.receivedInvalid).toEqual([]);
  });

  it('deleting the profile: broadcast reaches the phone; a new create(providerId) fails pending→failed', async () => {
    const world = await makeWorld();
    const facade = new FakeSdkFacade();
    await world.start(facade, {
      fetchFn: (async () => new Response('{}', { status: 200 })) as typeof fetch,
    });
    world.sim.connect();

    world.sim.setProviderProfile('kimi', {
      label: 'Kimi K3',
      baseUrl: 'https://api.moonshot.ai/anthropic',
      authToken: KIMI_TOKEN,
      models: [{ id: 'kimi-k3' }],
    });
    await world.sim.until(() => world.sim.receivedOfType('provider-profile-ack').length === 1,
      { label: 'upsert ack' });

    world.sim.setProviderProfile('kimi', null);
    await world.sim.until(() => world.sim.receivedOfType('provider-profile-ack').length === 2,
      { label: 'delete ack' });
    await world.sim.until(() => {
      const lists = world.sim.receivedOfType('provider-profiles');
      return lists.length > 0 && lists.at(-1)!.profiles.length === 0;
    }, { label: 'empty redacted list after delete' });

    world.sim.createSession({ providerId: 'kimi' });
    await world.sim.until(() => world.sim.receivedOfType('session-failed').length === 1,
      { label: 'session-failed for deleted profile' });
    const failed = world.sim.receivedOfType('session-failed')[0]!;
    expect(failed.reason).toMatch(/Unknown provider profile 'kimi'/);
    // The pending placeholder went out FIRST (two-phase contract kept).
    expect(world.sim.receivedOfType('session-pending').some((m) => m.pendingId === failed.pendingId)).toBe(true);
    expect(facade.sessions.size).toBe(0);
  });
});
