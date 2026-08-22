/**
 * BridgeCore orchestration, happy path: FakeSdkFacade (testkit) + a fake pool.
 * Commands enter as REAL encrypted kind-4515 events through the real
 * CommandIngest; everything published is decrypted and codec-validated the way
 * the phone would — the closest thing to a contract test before the phone
 * simulator lands (CDX-008).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/core';
import { FakeSdkFacade } from '@codedeck/testkit';
import {
  COMMAND_KIND,
  LIVE_KIND,
  RESPONSE_KIND,
  SESSION_LIST_KIND,
  PROTOCOL_VERSION,
  PROVIDER_BASE_URL_ERROR,
  encodePhoneToBridge,
  decodeBridgeToPhone,
  type BridgeToPhoneMessage,
  type PhoneToBridgeMessage,
  type SetProviderProfileMessage,
} from '@codedeck/protocol';
import type { BridgeHost, PairingHandle, PairingPayload } from '../host';
import { encryptTo, decryptFrom } from '../nostr/crypto';
import type { BridgePoolCallbacks, BridgePoolOptions } from '../nostr/pool';
import { SessionRegistry } from '../session/registry';
import { disabledMeshAdmin } from '../mesh/meshAdmin';
import {
  BridgeCore,
  buildSessionEnv,
  sanitizeProviderBaseEnv,
  sessionEnvFromCredentials,
  type BridgeCoreOptions,
  type BridgeCorePool,
  type ProviderProfile,
} from '../bridge';
import type { SdkMessage } from '../sdk/facade';

const bridgeSecret = generateSecretKey();
const bridgePubkey = getPublicKey(bridgeSecret);
const phoneSecret = generateSecretKey();
const phonePubkey = getPublicKey(phoneSecret);

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

class FakePool implements BridgeCorePool {
  readonly relays = ['wss://fake.relay'];
  connected = false;
  published: NostrEvent[] = [];
  resubscribes = 0;
  disposed = false;

  constructor(
    readonly options: BridgePoolOptions,
    readonly cb: BridgePoolCallbacks,
  ) {}

  connect(): void { this.connected = true; }
  dispose(): void { this.disposed = true; }
  resubscribe(): void { this.resubscribes++; }
  publish(event: NostrEvent): Promise<string>[] {
    this.published.push(event);
    return [Promise.resolve('ok')];
  }
  notePublishSuccess(): void {}
}

interface Ctx {
  dir: string;
  stateDir: string;
  wsRoot: string;
  storage: Map<string, string>;
  facade: FakeSdkFacade;
  pool: FakePool;
  core: BridgeCore;
  shutdownFns: Array<() => Promise<void> | void>;
  logs: string[];
}

function makeHost(ctx: Omit<Ctx, 'core' | 'pool' | 'facade'>): BridgeHost {
  return {
    config: {
      machineName: 'test-machine',
      host: 'cli',
      relays: ['wss://fake.relay'],
      workspaceRoots: [ctx.wsRoot],
    },
    storage: {
      get: async (k) => ctx.storage.get(k),
      set: async (k, v) => { ctx.storage.set(k, v); },
      delete: async (k) => { ctx.storage.delete(k); },
    },
    sessionStateDir: () => ctx.stateDir,
    log: (_level, msg) => { ctx.logs.push(msg); },
    notify: () => {},
    presentPairing: (_payload: PairingPayload): PairingHandle => ({ close: () => {} }),
    onShutdown: (fn) => { ctx.shutdownFns.push(fn); },
  };
}

async function startCore(partial?: {
  seedRegistry?: (dir: string) => Promise<void>;
  seedStorage?: (storage: Map<string, string>) => void;
  coreOpts?: Partial<BridgeCoreOptions>;
}): Promise<Ctx> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codedeck-bridge-'));
  const stateDir = path.join(dir, 'state');
  const wsRoot = path.join(dir, 'workspace');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(path.join(wsRoot, 'projA'), { recursive: true });
  const storage = new Map<string, string>();
  storage.set('pairedPhones', JSON.stringify([
    { npub: 'npub1phone', pubkeyHex: phonePubkey, label: 'phone', pairedAt: 'now' },
  ]));

  if (partial?.seedRegistry) await partial.seedRegistry(stateDir);
  partial?.seedStorage?.(storage);

  const facade = new FakeSdkFacade();
  let pool: FakePool | null = null;
  const shutdownFns: Ctx['shutdownFns'] = [];
  const logs: string[] = [];
  const host = makeHost({ dir, stateDir, wsRoot, storage, shutdownFns, logs });

  const core = await BridgeCore.start({
    host,
    secretKey: bridgeSecret,
    facade,
    poolFactory: (options, cb) => {
      pool = new FakePool(options, cb);
      return pool;
    },
    heartbeatIntervalMs: 0, // no timer churn in tests
    gitPollIntervalMs: 0,
    // NEVER let a unit test shell out to a real nvpn on the dev machine —
    // mesh-onboarding tests inject their own fake MeshAdmin.
    meshAdmin: disabledMeshAdmin(),
    ...partial?.coreOpts,
  });

  return { dir, stateDir, wsRoot, storage, facade, pool: pool!, core, shutdownFns, logs };
}

/** Decode every published event addressed to the phone, oldest first. */
function published(ctx: Ctx): Array<{ kind: number; msg: BridgeToPhoneMessage }> {
  return ctx.pool.published.map((event) => {
    const plaintext = decryptFrom(phoneSecret, bridgePubkey, event.content);
    const decoded = decodeBridgeToPhone(plaintext);
    if (!decoded.ok) throw new Error(`published event failed codec validation: ${decoded.error}`);
    return { kind: event.kind, msg: decoded.msg };
  });
}

function ofType<T extends BridgeToPhoneMessage['type']>(
  ctx: Ctx,
  type: T,
): Array<Extract<BridgeToPhoneMessage, { type: T }>> {
  return published(ctx)
    .map((p) => p.msg)
    .filter((m): m is Extract<BridgeToPhoneMessage, { type: T }> => m.type === type);
}

/** Feed a phone command into the bridge as a real encrypted kind-4515 event. */
function sendCommand(ctx: Ctx, msg: PhoneToBridgeMessage): void {
  sendRawCommand(ctx, encodePhoneToBridge(msg));
}

/** Send a payload WITHOUT `encodePhoneToBridge`'s outbound validation — the only
 *  way to put a shape on the wire that the encoder itself refuses (CDX-071's
 *  base-URL rule is enforced on encode AND decode), i.e. what a pre-gate or
 *  hostile phone would actually send. */
function sendRawCommand(ctx: Ctx, json: string): void {
  const event = finalizeEvent({
    kind: COMMAND_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', bridgePubkey]],
    content: encryptTo(phoneSecret, bridgePubkey, json),
  }, phoneSecret);
  ctx.pool.cb.onEvent(event);
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

/** Drive create-session → SDK init → session-ready. Returns the sessionId. */
async function createReadySession(ctx: Ctx): Promise<string> {
  sendCommand(ctx, { type: 'create-session' });
  await waitFor(() => ctx.facade.sessions.size >= 1 && ofType(ctx, 'session-pending').length >= 1);
  const sessionId = [...ctx.facade.sessions.keys()].at(-1)!;
  ctx.facade.emit(sessionId, initMsg(`sdk-${sessionId}`));
  await waitFor(() => ofType(ctx, 'session-ready').some((m) => m.pendingId === sessionId));
  return sessionId;
}

describe('BridgeCore', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await startCore();
  });

  afterEach(async () => {
    await ctx.core.shutdown();
    await fs.rm(ctx.dir, { recursive: true, force: true });
  });

  it('start: connects the pool and publishes a 30515 heartbeat with caps + folders', async () => {
    expect(ctx.pool.connected).toBe(true);
    const lists = ofType(ctx, 'sessions');
    expect(lists).toHaveLength(1);
    const list = lists[0]!;
    expect(published(ctx)[0]?.kind).toBe(SESSION_LIST_KIND);
    expect(list.machine).toBe('test-machine');
    expect(list.host).toBe('cli');
    expect(list.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(list.sessions).toEqual([]);
    expect(list.capabilities).toContain('sync/1');
    expect(list.capabilities).toContain('folders');
    expect(list.folders).toEqual(['projA']);
    expect(list.machineOffline).toBeUndefined();
  });

  it('create-session: two-phase pending → ready, then the heartbeat lists the session', async () => {
    sendCommand(ctx, { type: 'create-session', model: 'claude-opus-4', defaultEffort: 'high' });
    await waitFor(() => ofType(ctx, 'session-pending').length === 1 && ctx.facade.sessions.size === 1);
    const pending = ofType(ctx, 'session-pending')[0]!;
    expect(published(ctx).find((p) => p.msg.type === 'session-pending')?.kind).toBe(RESPONSE_KIND);

    const sessionId = [...ctx.facade.sessions.keys()][0]!;
    expect(sessionId).toBe(pending.pendingId);
    const sdkSession = ctx.facade.session(sessionId);
    expect(sdkSession.options.cwd).toBe(ctx.wsRoot); // no cwd requested → first root
    expect(sdkSession.options.model).toBe('claude-opus-4');
    expect(sdkSession.options.effortLevel).toBe('high');

    ctx.facade.emit(sessionId, initMsg('sdk-1'));
    await waitFor(() => ofType(ctx, 'session-ready').length === 1);
    const ready = ofType(ctx, 'session-ready')[0]!;
    expect(ready.pendingId).toBe(sessionId);
    expect(ready.session.id).toBe(sessionId);

    await waitFor(() => ofType(ctx, 'sessions').some((l) => l.sessions.length === 1));
    const rec = ctx.core.registry.get(sessionId);
    expect(rec?.sdkSessionId).toBe('sdk-1');
  });

  it('create-session in a requested cwd is confined to the workspace roots', async () => {
    sendCommand(ctx, { type: 'create-session', cwd: '../../../etc' });
    await waitFor(() => ctx.facade.sessions.size === 1);
    const sessionId = [...ctx.facade.sessions.keys()][0]!;
    expect(ctx.facade.session(sessionId).options.cwd).toBe(ctx.wsRoot); // fell back to the root
  });

  it('SDK output flows to the phone as ephemeral 24515 output messages with transcript seqs', async () => {
    const sessionId = await createReadySession(ctx);
    ctx.facade.emit(sessionId, {
      type: 'assistant',
      session_id: `sdk-${sessionId}`,
      parent_tool_use_id: null,
      message: { model: 'claude-test-1', content: [{ type: 'text', text: 'hello phone' }] },
    } as unknown as SdkMessage);

    await waitFor(() => ofType(ctx, 'output').length >= 2); // init entry + text
    const outputs = ofType(ctx, 'output');
    expect(outputs.map((o) => o.seq)).toEqual([1, 2]);
    expect(outputs[1]?.entry.content).toBe('hello phone');
    const outputEvents = published(ctx).filter((p) => p.msg.type === 'output');
    expect(outputEvents.every((p) => p.kind === LIVE_KIND)).toBe(true);
  });

  it('input: routed to the runner and acked; unknown session gets input-failed', async () => {
    const sessionId = await createReadySession(ctx);

    sendCommand(ctx, { type: 'input', sessionId, text: 'do the thing', inputId: 'in-1' });
    await waitFor(() => ofType(ctx, 'input-ack').length === 1);
    expect(ofType(ctx, 'input-ack')[0]).toMatchObject({ sessionId, inputId: 'in-1' });
    expect(ctx.facade.session(sessionId).inputs[0]).toContain('do the thing');

    sendCommand(ctx, { type: 'input', sessionId: 'ghost', text: 'hello?', inputId: 'in-2' });
    await waitFor(() => ofType(ctx, 'input-failed').length === 1);
    expect(ofType(ctx, 'input-failed')[0]).toMatchObject({
      sessionId: 'ghost',
      reason: 'no-session',
      inputId: 'in-2',
    });
  });

  it('mode/effort/model changes are applied to the SDK and confirmed back', async () => {
    const sessionId = await createReadySession(ctx);
    const sdkSession = ctx.facade.session(sessionId);

    sendCommand(ctx, { type: 'mode', sessionId, mode: 'acceptEdits' });
    await waitFor(() => ofType(ctx, 'mode-confirmed').length === 1);
    expect(sdkSession.modes).toEqual(['acceptEdits']);

    sendCommand(ctx, { type: 'effort', sessionId, level: 'max' });
    await waitFor(() => ofType(ctx, 'effort-confirmed').length === 1);
    expect(ofType(ctx, 'effort-confirmed')[0]?.level).toBe('max');
    expect(sdkSession.efforts).toEqual(['max']);

    sendCommand(ctx, { type: 'model', sessionId, model: 'claude-sonnet-4-6' });
    await waitFor(() => ofType(ctx, 'model-confirmed').length === 1);
    expect(sdkSession.models).toEqual(['claude-sonnet-4-6']);
  });

  it('sync: sync-request → begin/chunk, ack → end with honest deliveredRanges', async () => {
    const sessionId = await createReadySession(ctx);
    ctx.facade.emit(sessionId, {
      type: 'assistant',
      session_id: `sdk-${sessionId}`,
      parent_tool_use_id: null,
      message: { model: 'claude-test-1', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
    } as unknown as SdkMessage);
    await waitFor(() => ctx.core.transcript.seqHigh(sessionId) === 3);

    sendCommand(ctx, { type: 'sync-request', sessionId, haveRanges: [[1, 1]] });
    await waitFor(() => ofType(ctx, 'sync-begin').length === 1 && ofType(ctx, 'sync-chunk').length === 1);
    const begin = ofType(ctx, 'sync-begin')[0]!;
    expect(begin.seqHigh).toBe(3);
    expect(begin.ranges).toEqual([[2, 3]]);
    const chunk = ofType(ctx, 'sync-chunk')[0]!;
    expect(chunk.range).toEqual([2, 3]);
    expect(chunk.entries.map((e) => e.seq)).toEqual([2, 3]);

    sendCommand(ctx, { type: 'sync-ack', syncId: chunk.syncId, range: [2, 3] });
    await waitFor(() => ofType(ctx, 'sync-end').length === 1);
    expect(ofType(ctx, 'sync-end')[0]?.deliveredRanges).toEqual([[2, 3]]);
  });

  it('create-folder: creates + acks + republishes folders; escapes are refused', async () => {
    sendCommand(ctx, { type: 'create-folder', path: 'projB', requestId: 'rq-1' });
    await waitFor(() => ofType(ctx, 'folder-ack').length === 1);
    expect(ofType(ctx, 'folder-ack')[0]).toMatchObject({ requestId: 'rq-1', success: true, path: 'projB' });
    expect(existsSync(path.join(ctx.wsRoot, 'projB'))).toBe(true);
    await waitFor(() => ofType(ctx, 'sessions').some((l) => l.folders?.includes('projB')));

    sendCommand(ctx, { type: 'create-folder', path: '../escape', requestId: 'rq-2' });
    await waitFor(() => ofType(ctx, 'folder-ack').length === 2);
    const nack = ofType(ctx, 'folder-ack')[1]!;
    expect(nack.success).toBe(false);
    expect(existsSync(path.join(ctx.dir, 'escape'))).toBe(false);
  });

  it('close-session: ends the runner, tombstones the record, acks', async () => {
    const sessionId = await createReadySession(ctx);
    sendCommand(ctx, { type: 'close-session', sessionId });
    await waitFor(() => ofType(ctx, 'close-session-ack').length === 1);
    expect(ofType(ctx, 'close-session-ack')[0]).toMatchObject({ sessionId, success: true });
    expect(ctx.facade.session(sessionId).ended).toBe(true);
    expect(ctx.core.registry.get(sessionId)).toBeUndefined();
    await waitFor(() => ofType(ctx, 'sessions').some((l) => l.removedSessions?.includes(sessionId)));
  });

  it('models-request answers with the facade model list', async () => {
    ctx.facade.models = [{ id: 'claude-opus-4', label: 'Opus' }];
    sendCommand(ctx, { type: 'models-request' });
    await waitFor(() => ofType(ctx, 'models').length === 1);
    expect(ofType(ctx, 'models')[0]?.models).toEqual([{ id: 'claude-opus-4', label: 'Opus' }]);
  });

  it('models-request with no answering SDK session answers with an EMPTY list + a reason (CDX-035)', async () => {
    // CDX-022 made this silent so the phone kept retrying instead of freezing
    // on an empty picker. CDX-035 makes it speak: the empty list now carries
    // the reason, the phone renders it and keeps re-requesting (an empty
    // answer is no longer indistinguishable from a lost message).
    ctx.facade.models = [];
    sendCommand(ctx, { type: 'models-request' });
    await waitFor(() => ofType(ctx, 'models').length === 1);
    const msg = ofType(ctx, 'models')[0]!;
    expect(msg.models).toEqual([]);
    expect(msg.error).toMatch(/No live Claude session answered/);
    expect(ctx.logs.some((l) => l.includes('models-request:'))).toBe(true);
  });

  it('a real model list carries NO error field (CDX-035)', async () => {
    ctx.facade.models = [{ id: 'claude-opus-4', label: 'Opus' }];
    sendCommand(ctx, { type: 'models-request' });
    await waitFor(() => ofType(ctx, 'models').length === 1);
    expect(ofType(ctx, 'models')[0]?.error).toBeUndefined();
  });

  it('shutdown: publishes ALL sessions as offline with machineOffline — never an empty list', async () => {
    const sessionId = await createReadySession(ctx);
    await ctx.core.shutdown();

    const lists = ofType(ctx, 'sessions');
    const final = lists.at(-1)!;
    expect(final.machineOffline).toBe(true);
    expect(final.sessions.length).toBe(1);
    expect(final.sessions[0]).toMatchObject({ id: sessionId, state: 'offline' });
    expect(ctx.facade.session(sessionId).ended).toBe(true);
    expect(ctx.pool.disposed).toBe(true);
  });

  it('resume-on-boot: registry-persisted sessions come back via the facade resume path', async () => {
    // Boot a SECOND core over a state dir seeded with a persisted session.
    const resumed = await startCore({
      seedRegistry: async (stateDir) => {
        const registry = new SessionRegistry(stateDir);
        await registry.upsert({
          sessionId: 'persisted-1',
          sdkSessionId: 'sdk-persisted',
          cwd: '/work/proj',
          title: 'Old work',
          project: 'proj',
          createdAt: '2026-08-05T00:00:00Z',
          lastActivity: '2026-08-05T00:00:00Z',
          state: 'offline',
        });
      },
    });
    try {
      await waitFor(() => resumed.facade.sessions.has('persisted-1'));
      expect(resumed.facade.session('persisted-1').options.resume).toBe('sdk-persisted');
      await waitFor(() => resumed.core.registry.get('persisted-1')?.state === 'idle');

      // The boot heartbeat still lists the session — restart amnesia is gone.
      const lists = ofType(resumed, 'sessions');
      expect(lists.some((l) => l.sessions.some((s) => s.id === 'persisted-1'))).toBe(true);
    } finally {
      await resumed.core.shutdown();
      await fs.rm(resumed.dir, { recursive: true, force: true });
    }
  });
});

// --- CDX-005 remainder: the formerly-stubbed handlers ---

describe('BridgeCore — usage / gsd / images / credentials / device-config handlers', () => {
  const started: Ctx[] = [];

  async function start(partial?: Parameters<typeof startCore>[0]): Promise<Ctx> {
    const ctx = await startCore(partial);
    started.push(ctx);
    return ctx;
  }

  afterEach(async () => {
    while (started.length > 0) {
      const ctx = started.pop()!;
      await ctx.core.shutdown();
      await fs.rm(ctx.dir, { recursive: true, force: true });
    }
  });

  it('usage-request: normalizes the SDK snapshot and publishes a typed usage message', async () => {
    const ctx = await start();
    const sessionId = await createReadySession(ctx);
    ctx.facade.session(sessionId).usageSnapshot = {
      rate_limits_available: true,
      subscription_type: 'max',
      rate_limits: { five_hour: { utilization: 55, resets_at: '2026-08-05T15:00:00Z' } },
      session: { total_cost_usd: 0.5 },
    };

    sendCommand(ctx, { type: 'usage-request', sessionId });
    await waitFor(() => ofType(ctx, 'usage').length === 1);

    const usage = ofType(ctx, 'usage')[0]!;
    expect(usage.sessionId).toBe(sessionId);
    expect(usage.usage.available).toBe(true);
    expect(usage.usage.subscriptionType).toBe('max');
    expect(usage.usage.fiveHour).toEqual({ utilization: 55, resetsAt: '2026-08-05T15:00:00Z' });
    expect(usage.usage.sessionCostUsd).toBe(0.5);
    // Ephemeral storage class — usage rides the live kind.
    expect(published(ctx).find((p) => p.msg.type === 'usage')!.kind).toBe(LIVE_KIND);
  });

  it('usage-request: unsupported SDK snapshot publishes NOTHING (phone keeps last value)', async () => {
    const ctx = await start();
    const sessionId = await createReadySession(ctx);
    ctx.facade.session(sessionId).usageSnapshot = null;
    sendCommand(ctx, { type: 'usage-request', sessionId });
    sendCommand(ctx, { type: 'refresh-sessions' }); // marker command to sequence
    await waitFor(() => ofType(ctx, 'sessions').length >= 2);
    expect(ofType(ctx, 'usage')).toHaveLength(0);
  });

  it('gsd-request: resolves the session cwd through the injected provider and always publishes', async () => {
    const seen: string[] = [];
    const ctx = await start({
      coreOpts: {
        gsdProvider: async (cwd) => {
          seen.push(cwd);
          return {
            installed: true, available: false, hasGit: true, situation: 'no-project',
            summary: '', milestone: null, currentPhase: null, totalPhases: null,
            percent: 0, phases: [], actions: [], recommended: null, paused: false,
            blockers: [], verifyFailed: false, execution: null,
          };
        },
      },
    });
    const sessionId = await createReadySession(ctx);

    sendCommand(ctx, { type: 'gsd-request', sessionId });
    await waitFor(() => ofType(ctx, 'gsd-state').length === 1);

    const msg = ofType(ctx, 'gsd-state')[0]!;
    expect(msg.sessionId).toBe(sessionId);
    // available:false still goes out — the phone can retire a stale strip.
    expect(msg.gsd.available).toBe(false);
    expect(msg.gsd.installed).toBe(true);
    expect(seen).toEqual([ctx.wsRoot]); // default session cwd = first workspace root
    expect(published(ctx).find((p) => p.msg.type === 'gsd-state')!.kind).toBe(LIVE_KIND);
  });

  it('gsd-request for an unknown session publishes nothing', async () => {
    const ctx = await start({ coreOpts: { gsdProvider: async () => { throw new Error('must not be called'); } } });
    sendCommand(ctx, { type: 'gsd-request', sessionId: 'ghost' });
    sendCommand(ctx, { type: 'refresh-sessions' });
    await waitFor(() => ofType(ctx, 'sessions').length >= 2);
    expect(ofType(ctx, 'gsd-state')).toHaveLength(0);
  });

  it('upload-image (chunked): assembles, writes under .codedeck/uploads, injects the path as input', async () => {
    const ctx = await start();
    const sessionId = await createReadySession(ctx);
    const png = Buffer.from('89504e470d0a1a0a', 'hex');

    sendCommand(ctx, {
      type: 'upload-image',
      sessionId,
      uploadId: 'up-1',
      filename: 'shot.png',
      mimeType: 'image/png',
      base64Data: png.toString('base64'),
      text: 'inspect this',
      chunkIndex: 0,
      totalChunks: 1,
    });

    const session = ctx.facade.session(sessionId);
    await waitFor(() => session.inputs.length === 1);
    expect(session.inputs[0]).toContain('inspect this');
    expect(session.inputs[0]).toContain('[Attached image: ');
    expect(session.inputs[0]).toContain(path.join(ctx.wsRoot, '.codedeck', 'uploads'));
  });

  it('set-credentials: stores in host storage, validates via injected fetch, acks — key NEVER logged', async () => {
    const envBackup = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const fetched: Array<{ url: string; init?: RequestInit }> = [];
      const ctx = await start({
        coreOpts: {
          fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
            fetched.push({ url: String(url), init });
            return new Response('{}', { status: 200 });
          }) as typeof fetch,
        },
      });

      const SECRET_KEY = 'sk-ant-test-SECRETSECRET';
      sendCommand(ctx, { type: 'set-credentials', anthropicApiKey: SECRET_KEY, githubPat: 'ghp_PATPAT' });
      await waitFor(() => ofType(ctx, 'credentials-ack').length === 1);

      const ack = ofType(ctx, 'credentials-ack')[0]!;
      expect(ack.success).toBe(true);
      expect(ack.hasAnthropicKey).toBe(true);
      expect(ack.hasGithubPat).toBe(true);
      expect(ack.keyValid).toBe(true); // 200 ≠ 401/403

      // Stored in host storage…
      const stored = JSON.parse(ctx.storage.get('credentials')!);
      expect(stored.anthropicApiKey).toBe(SECRET_KEY);
      expect(stored.githubPat).toBe('ghp_PATPAT');
      // …validated against the API with the key in the header…
      expect(fetched).toHaveLength(1);
      expect(fetched[0]!.url).toContain('api.anthropic.com');
      expect((fetched[0]!.init?.headers as Record<string, string>)['x-api-key']).toBe(SECRET_KEY);
      // …and the secret appears in NO log line.
      expect(ctx.logs.join('\n')).not.toContain(SECRET_KEY);
      expect(ctx.logs.join('\n')).not.toContain('ghp_PATPAT');

      // Explicit null DELETES a credential (ported semantics).
      sendCommand(ctx, { type: 'set-credentials', anthropicApiKey: null });
      await waitFor(() => ofType(ctx, 'credentials-ack').length === 2);
      const ack2 = ofType(ctx, 'credentials-ack')[1]!;
      expect(ack2.hasAnthropicKey).toBe(false);
      expect(ack2.hasGithubPat).toBe(true); // untouched
      expect(JSON.parse(ctx.storage.get('credentials')!).anthropicApiKey).toBeUndefined();
    } finally {
      if (envBackup !== undefined) process.env.ANTHROPIC_API_KEY = envBackup;
    }
  });

  it('stored credentials feed the SDK subprocess env at spawn — secret in env, never in logs', async () => {
    const envBackup = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const ctx = await start({
        coreOpts: { fetchFn: (async () => new Response('{}', { status: 200 })) as typeof fetch },
      });
      const SECRET_KEY = 'sk-ant-test-ENVSPAWNSECRET';
      sendCommand(ctx, { type: 'set-credentials', anthropicApiKey: SECRET_KEY, githubPat: 'ghp_ENVPAT' });
      await waitFor(() => ofType(ctx, 'credentials-ack').length === 1);

      const sessionId = await createReadySession(ctx);
      const env = ctx.facade.session(sessionId).options.env;
      expect(env).toBeDefined();
      expect(env!.ANTHROPIC_API_KEY).toBe(SECRET_KEY);
      expect(env!.GITHUB_TOKEN).toBe('ghp_ENVPAT');
      // The SDK REPLACES the env wholesale — process.env must be spread in
      // (the subprocess still needs PATH/HOME to even start).
      expect(env!.PATH).toBe(process.env.PATH);
      // The secret reached the spawn but NO log line.
      expect(ctx.logs.join('\n')).not.toContain(SECRET_KEY);
      expect(ctx.logs.join('\n')).not.toContain('ghp_ENVPAT');
    } finally {
      if (envBackup !== undefined) process.env.ANTHROPIC_API_KEY = envBackup;
    }
  });

  it('credentials stored in an earlier run reach sessions after a reboot (loaded at init)', async () => {
    const envBackup = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const ctx = await start({
        seedStorage: (storage) =>
          storage.set('credentials', JSON.stringify({ anthropicApiKey: 'sk-ant-persisted-KEY' })),
      });
      const sessionId = await createReadySession(ctx);
      expect(ctx.facade.session(sessionId).options.env?.ANTHROPIC_API_KEY).toBe('sk-ant-persisted-KEY');
      expect(ctx.logs.join('\n')).not.toContain('sk-ant-persisted-KEY');
    } finally {
      if (envBackup !== undefined) process.env.ANTHROPIC_API_KEY = envBackup;
    }
  });

  it('no stored credentials → no env override (subprocess inherits process.env)', async () => {
    const ctx = await start();
    const sessionId = await createReadySession(ctx);
    expect(ctx.facade.session(sessionId).options.env).toBeUndefined();
  });

  it('sessionEnvFromCredentials: env ANTHROPIC_API_KEY wins over stored; PAT is stored-wins', () => {
    // env key beats the stored one (bridge operator's env is authoritative).
    const env = sessionEnvFromCredentials(
      { anthropicApiKey: 'sk-stored', githubPat: 'ghp_stored' },
      { ANTHROPIC_API_KEY: 'sk-env', GITHUB_TOKEN: 'ghp_env', PATH: '/bin', UNDEF: undefined },
    );
    expect(env).toEqual({
      ANTHROPIC_API_KEY: 'sk-env',
      GITHUB_TOKEN: 'ghp_stored',
      PATH: '/bin',
    });
    // Nothing stored → undefined (inherit), even with env vars present.
    expect(sessionEnvFromCredentials({}, { ANTHROPIC_API_KEY: 'sk-env' })).toBeUndefined();
    // Stored key alone, no env key → stored key used.
    expect(
      sessionEnvFromCredentials({ anthropicApiKey: 'sk-stored' }, { PATH: '/bin' }),
    ).toEqual({ ANTHROPIC_API_KEY: 'sk-stored', PATH: '/bin' });
  });

  it('set-device-config: persists per-phone + workspace file, derives the mesh serial, acks', async () => {
    const ctx = await start();
    sendCommand(ctx, {
      type: 'set-device-config',
      config: {
        label: 'tokay',
        role: 'test-target',
        meshIp: '10.44.0.9',
        meshPubkey: 'm'.repeat(64),
        appUnderTest: 'custom',
        customPackage: 'com.example.app',
      },
    });
    await waitFor(() => ofType(ctx, 'device-config-ack').length === 1);
    expect(ofType(ctx, 'device-config-ack')[0]).toEqual({ type: 'device-config-ack', success: true });

    // Per-phone storage + the workspace file the test-session reads — with the
    // transport-only mesh fields stripped and the serial derived.
    const persisted = JSON.parse(ctx.storage.get(`deviceConfig.${phonePubkey}`)!);
    expect(persisted.serial).toBe('10.44.0.9:0');
    expect(persisted.meshIp).toBeUndefined();
    expect(persisted.meshPubkey).toBeUndefined();
    const file = JSON.parse(
      readFileSync(path.join(ctx.wsRoot, '.codedeck', 'device-config.json'), 'utf8'),
    );
    expect(file).toEqual(persisted);
  });

  it('set-device-config (test-target): authorizes the MESH pubkey on the nvpn roster (add-device --publish) + warns when the daemon is down (Phase 5d, CDX-005 deferral)', async () => {
    const meshPubkey = 'a'.repeat(64);
    const added: string[] = [];
    const notices: Array<{ level: string; msg: string }> = [];
    const fakeMesh = {
      available: true,
      onboardingInfo: async () => null,
      activeNetworkId: async () => 'a237c978',
      addDevice: async (pk: string) => {
        added.push(pk);
        return { ok: true as const };
      },
      derivePeerIp: async () => null,
      daemonRunning: async () => false, // daemon down → warn notice
    };
    const ctx = await start({ coreOpts: { meshAdmin: fakeMesh } });
    // Capture host notifications (makeHost's notify is a no-op — patch it).
    (ctx.core as unknown as { host: { notify: (l: string, m: string) => void } }).host.notify = (
      level,
      msg,
    ) => notices.push({ level, msg });

    sendCommand(ctx, {
      type: 'set-device-config',
      config: {
        label: 'tokay',
        role: 'test-target',
        meshIp: '10.44.0.9',
        meshPubkey,
        appUnderTest: 'kubo',
      },
    });
    await waitFor(() => ofType(ctx, 'device-config-ack').length === 1);
    expect(ofType(ctx, 'device-config-ack')[0]!.success).toBe(true);
    // The MESH pubkey (not the pairing pubkey) went to add-device.
    expect(added).toEqual([meshPubkey]);
    // Daemon down ⇒ the host was warned that the roster change won't propagate.
    expect(notices.some((n) => n.level === 'warn' && /nvpn service isn't running/.test(n.msg))).toBe(true);
  });

  it('set-device-config (test-target): the not-admin refusal is surfaced distinctly (CDX-028)', async () => {
    const meshPubkey = 'c'.repeat(64);
    const notices: Array<{ level: string; msg: string }> = [];
    const fakeMesh = {
      available: true,
      onboardingInfo: async () => null,
      activeNetworkId: async () => 'a237c978',
      addDevice: async () => ({
        ok: false as const,
        notAdmin: true,
        error: 'error: active network is not administered by this device',
      }),
      derivePeerIp: async () => null,
      daemonRunning: async () => true,
    };
    const ctx = await start({ coreOpts: { meshAdmin: fakeMesh } });
    (ctx.core as unknown as { host: { notify: (l: string, m: string) => void } }).host.notify = (
      level,
      msg,
    ) => notices.push({ level, msg });

    sendCommand(ctx, {
      type: 'set-device-config',
      config: {
        label: 'tokay',
        role: 'test-target',
        meshIp: '10.44.0.9',
        meshPubkey,
        appUnderTest: 'kubo',
      },
    });
    await waitFor(() => ofType(ctx, 'device-config-ack').length === 1);
    // Config still saves (best-effort roster add), but the operator learns WHY
    // authorization failed — not the generic "is a network active?" message.
    expect(ofType(ctx, 'device-config-ack')[0]!.success).toBe(true);
    expect(notices.some((n) => n.level === 'warn' && /not an admin/.test(n.msg))).toBe(true);
    expect(notices.some((n) => /is an nvpn network active/.test(n.msg))).toBe(false);
  });

  it('set-device-config (test-target, no reported mesh IP): falls back to derivePeerIp for the serial', async () => {
    const meshPubkey = 'b'.repeat(64);
    const fakeMesh = {
      available: true,
      onboardingInfo: async () => null,
      activeNetworkId: async () => 'a237c978',
      addDevice: async () => ({ ok: true as const }),
      derivePeerIp: async (pk: string) => (pk === meshPubkey ? '10.44.204.101' : null),
      daemonRunning: async () => true,
    };
    const ctx = await start({ coreOpts: { meshAdmin: fakeMesh } });
    sendCommand(ctx, {
      type: 'set-device-config',
      config: { label: 'tokay', role: 'test-target', meshPubkey, appUnderTest: 'kubo' },
    });
    await waitFor(() => ofType(ctx, 'device-config-ack').length === 1);
    const persisted = JSON.parse(ctx.storage.get(`deviceConfig.${phonePubkey}`)!);
    expect(persisted.serial).toBe('10.44.204.101:0');
  });

  it('input to a dead-but-known session fails with reason "error", unknown with "no-session"', async () => {
    const ctx = await start();
    const sessionId = await createReadySession(ctx);
    await ctx.core.runner(sessionId)!.close();

    sendCommand(ctx, { type: 'input', sessionId, text: 'hello?', inputId: 'in-dead' });
    await waitFor(() => ofType(ctx, 'input-failed').some((m) => m.inputId === 'in-dead'));
    expect(ofType(ctx, 'input-failed').find((m) => m.inputId === 'in-dead')!.reason).toBe('error');

    sendCommand(ctx, { type: 'input', sessionId: 'ghost', text: 'hello?', inputId: 'in-ghost' });
    await waitFor(() => ofType(ctx, 'input-failed').some((m) => m.inputId === 'in-ghost'));
    expect(ofType(ctx, 'input-failed').find((m) => m.inputId === 'in-ghost')!.reason).toBe('no-session');
  });
});

// --- CDX-062: custom AI provider profiles ---

const KIMI_TOKEN = 'sk-kimi-TESTSECRET-000';

/** A stored profile as it would sit in host storage after a set-provider-profile. */
function kimiProfile(over: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'kimi',
    label: 'Kimi K3',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    authToken: KIMI_TOKEN,
    models: [{ id: 'kimi-k3', label: 'Kimi K3' }, { id: 'kimi-k3-turbo' }],
    defaultModel: 'kimi-k3',
    ...over,
  };
}

function seedProfiles(storage: Map<string, string>, ...profiles: ProviderProfile[]): void {
  storage.set('providerProfiles', JSON.stringify({ profiles }));
}

describe('BridgeCore — custom provider profiles (CDX-062)', () => {
  const started: Ctx[] = [];

  async function start(partial?: Parameters<typeof startCore>[0]): Promise<Ctx> {
    const ctx = await startCore(partial);
    started.push(ctx);
    return ctx;
  }

  afterEach(async () => {
    while (started.length > 0) {
      const ctx = started.pop()!;
      await ctx.core.shutdown();
      await fs.rm(ctx.dir, { recursive: true, force: true });
    }
  });

  /** Drive create-session (optionally provider-bound) → SDK init → ready.
   *  Size-aware, unlike the top-level createReadySession, so it works when
   *  earlier sessions already exist. */
  async function createSession(ctx: Ctx, opts: { providerId?: string; model?: string } = {}): Promise<string> {
    const before = ctx.facade.sessions.size;
    sendCommand(ctx, {
      type: 'create-session',
      ...(opts.providerId ? { providerId: opts.providerId } : {}),
      ...(opts.model ? { model: opts.model } : {}),
    });
    await waitFor(() => ctx.facade.sessions.size > before);
    const sessionId = [...ctx.facade.sessions.keys()].at(-1)!;
    ctx.facade.emit(sessionId, initMsg(`sdk-${sessionId}`));
    await waitFor(() => ofType(ctx, 'session-ready').some((m) => m.pendingId === sessionId));
    return sessionId;
  }

  async function createProviderSession(ctx: Ctx, providerId: string, model?: string): Promise<string> {
    return createSession(ctx, { providerId, ...(model ? { model } : {}) });
  }

  it('set-provider-profile: stores, validates against the profile base URL (Bearer), acks, broadcasts redacted — token NEVER logged or on the wire', async () => {
    const fetched: Array<{ url: string; init?: RequestInit }> = [];
    const ctx = await start({
      coreOpts: {
        fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
          fetched.push({ url: String(url), init });
          return new Response('{}', { status: 200 });
        }) as typeof fetch,
      },
    });

    sendCommand(ctx, {
      type: 'set-provider-profile',
      profileId: 'kimi',
      profile: {
        label: 'Kimi K3',
        // Trailing slash on purpose: the validation URL must not double it.
        baseUrl: 'https://api.moonshot.ai/anthropic/',
        authToken: KIMI_TOKEN,
        models: [{ id: 'kimi-k3' }, { id: 'kimi-k3-turbo' }],
        defaultModel: 'kimi-k3',
      },
    });
    await waitFor(() => ofType(ctx, 'provider-profile-ack').length === 1);

    const ack = ofType(ctx, 'provider-profile-ack')[0]!;
    expect(ack).toMatchObject({ profileId: 'kimi', success: true, tokenValid: true });

    // Stored in host storage (the SECRET storage key)…
    const stored = JSON.parse(ctx.storage.get('providerProfiles')!) as { profiles: ProviderProfile[] };
    expect(stored.profiles).toHaveLength(1);
    expect(stored.profiles[0]).toMatchObject({ id: 'kimi', authToken: KIMI_TOKEN });

    // …validated against the PROFILE's endpoint with a Bearer header…
    expect(fetched).toHaveLength(1);
    expect(fetched[0]!.url).toBe('https://api.moonshot.ai/anthropic/v1/messages');
    const headers = fetched[0]!.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${KIMI_TOKEN}`);
    expect(headers['anthropic-version']).toBeDefined();
    const body = JSON.parse(String(fetched[0]!.init?.body)) as { model: string; max_tokens: number };
    expect(body.model).toBe('kimi-k3');
    expect(body.max_tokens).toBe(1);

    // …broadcast REDACTED to phones…
    await waitFor(() => ofType(ctx, 'provider-profiles').length === 1);
    const list = ofType(ctx, 'provider-profiles')[0]!;
    expect(list.profiles).toEqual([{
      id: 'kimi',
      label: 'Kimi K3',
      baseUrl: 'https://api.moonshot.ai/anthropic/',
      models: [{ id: 'kimi-k3' }, { id: 'kimi-k3-turbo' }],
      defaultModel: 'kimi-k3',
      hasToken: true,
    }]);

    // …and the token appears in NO log line and NO published payload.
    expect(ctx.logs.join('\n')).not.toContain(KIMI_TOKEN);
    expect(JSON.stringify(published(ctx).map((p) => p.msg))).not.toContain(KIMI_TOKEN);
  });

  it('token validation: 401 → tokenValid=false; network error → tokenValid omitted', async () => {
    let behavior: 'unauthorized' | 'down' = 'unauthorized';
    const ctx = await start({
      coreOpts: {
        fetchFn: (async () => {
          if (behavior === 'down') throw new Error('ECONNREFUSED');
          return new Response('{}', { status: 401 });
        }) as typeof fetch,
      },
    });

    sendCommand(ctx, {
      type: 'set-provider-profile',
      profileId: 'kimi',
      profile: { label: 'Kimi K3', baseUrl: 'https://api.moonshot.ai/anthropic', authToken: 'sk-bad', models: [{ id: 'kimi-k3' }] },
    });
    await waitFor(() => ofType(ctx, 'provider-profile-ack').length === 1);
    expect(ofType(ctx, 'provider-profile-ack')[0]).toMatchObject({ success: true, tokenValid: false });

    behavior = 'down';
    sendCommand(ctx, {
      type: 'set-provider-profile',
      profileId: 'or',
      profile: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api', authToken: 'sk-or', models: [{ id: 'meta/llama' }] },
    });
    await waitFor(() => ofType(ctx, 'provider-profile-ack').length === 2);
    const ack = ofType(ctx, 'provider-profile-ack')[1]!;
    expect(ack.success).toBe(true);
    expect(ack.tokenValid).toBeUndefined();
  });

  it('authToken tri-state: undefined keeps the stored token, null deletes it; profile:null deletes the profile', async () => {
    const ctx = await start({
      coreOpts: { fetchFn: (async () => new Response('{}', { status: 200 })) as typeof fetch },
      seedStorage: (storage) => seedProfiles(storage, kimiProfile()),
    });

    // undefined = keep: an edit without the token field keeps the secret.
    sendCommand(ctx, {
      type: 'set-provider-profile',
      profileId: 'kimi',
      profile: { label: 'Kimi renamed', baseUrl: 'https://api.moonshot.ai/anthropic', models: [{ id: 'kimi-k3' }] },
    });
    await waitFor(() => ofType(ctx, 'provider-profile-ack').length === 1);
    let stored = JSON.parse(ctx.storage.get('providerProfiles')!) as { profiles: ProviderProfile[] };
    expect(stored.profiles[0]!.authToken).toBe(KIMI_TOKEN);
    expect(stored.profiles[0]!.label).toBe('Kimi renamed');
    // Token still present → the ack revalidated it.
    expect(ofType(ctx, 'provider-profile-ack')[0]!.tokenValid).toBe(true);

    // null = delete the token (profile stays).
    sendCommand(ctx, {
      type: 'set-provider-profile',
      profileId: 'kimi',
      profile: { label: 'Kimi renamed', baseUrl: 'https://api.moonshot.ai/anthropic', authToken: null, models: [{ id: 'kimi-k3' }] },
    });
    await waitFor(() => ofType(ctx, 'provider-profile-ack').length === 2);
    stored = JSON.parse(ctx.storage.get('providerProfiles')!) as { profiles: ProviderProfile[] };
    expect(stored.profiles[0]!.authToken).toBeUndefined();
    // No token → nothing to validate.
    expect(ofType(ctx, 'provider-profile-ack')[1]!.tokenValid).toBeUndefined();
    await waitFor(() => ofType(ctx, 'provider-profiles').length >= 2);
    expect(ofType(ctx, 'provider-profiles').at(-1)!.profiles[0]!.hasToken).toBe(false);

    // profile: null = delete the whole profile.
    sendCommand(ctx, { type: 'set-provider-profile', profileId: 'kimi', profile: null });
    await waitFor(() => ofType(ctx, 'provider-profile-ack').length === 3);
    expect(ofType(ctx, 'provider-profile-ack')[2]!.success).toBe(true);
    stored = JSON.parse(ctx.storage.get('providerProfiles')!) as { profiles: ProviderProfile[] };
    expect(stored.profiles).toHaveLength(0);
    await waitFor(() => ofType(ctx, 'provider-profiles').length >= 3);
    expect(ofType(ctx, 'provider-profiles').at(-1)!.profiles).toEqual([]);
  });

  it('provider-profiles-request answers the redacted list; corrupt store tolerated at boot (empty list, no crash)', async () => {
    const ctx = await start({
      seedStorage: (storage) => seedProfiles(storage, kimiProfile()),
    });
    sendCommand(ctx, { type: 'provider-profiles-request' });
    await waitFor(() => ofType(ctx, 'provider-profiles').length === 1);
    const list = ofType(ctx, 'provider-profiles')[0]!;
    expect(list.profiles).toHaveLength(1);
    expect(list.profiles[0]).toMatchObject({ id: 'kimi', hasToken: true });
    expect(JSON.stringify(list)).not.toContain(KIMI_TOKEN);

    const corrupt = await start({
      seedStorage: (storage) => storage.set('providerProfiles', 'NOT VALID JSON{{'),
    });
    sendCommand(corrupt, { type: 'provider-profiles-request' });
    await waitFor(() => ofType(corrupt, 'provider-profiles').length === 1);
    expect(ofType(corrupt, 'provider-profiles')[0]!.profiles).toEqual([]);
  });

  it('create-session with providerId: D4 env recipe, fallbackModel null, model defaults from the profile', async () => {
    const envBackup = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-MUST-NOT-LEAK-INTO-PROVIDER-SESSION';
    try {
      const ctx = await start({
        seedStorage: (storage) => {
          seedProfiles(storage, kimiProfile({ defaultModel: 'kimi-k3-turbo' }));
          storage.set('credentials', JSON.stringify({ githubPat: 'ghp_PROVIDERPAT' }));
        },
      });

      const sessionId = await createProviderSession(ctx, 'kimi');
      const opts = ctx.facade.session(sessionId).options;
      expect(opts.model).toBe('kimi-k3-turbo'); // no msg.model → profile.defaultModel
      expect(opts.fallbackModel).toBeNull(); // the Anthropic constant is invalid here
      const env = opts.env!;
      expect(env.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe(KIMI_TOKEN);
      expect(env.ANTHROPIC_API_KEY).toBeUndefined(); // deleted, never inherited
      expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('kimi-k3-turbo');
      expect(env.GITHUB_TOKEN).toBe('ghp_PROVIDERPAT'); // stored-wins unchanged
      expect(env.PATH).toBe(process.env.PATH); // base env spread in

      // Explicit msg.model overrides the profile default.
      const second = await createProviderSession(ctx, 'kimi', 'kimi-k3');
      expect(ctx.facade.session(second).options.model).toBe('kimi-k3');

      // The token reached the spawn but NO log line.
      expect(ctx.logs.join('\n')).not.toContain(KIMI_TOKEN);

      // A parallel NON-provider session still gets plain Anthropic behavior.
      const plain = await createSession(ctx);
      const plainOpts = ctx.facade.session(plain).options;
      expect(plainOpts.fallbackModel).toBeUndefined();
      expect(plainOpts.env?.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(plainOpts.env?.GITHUB_TOKEN).toBe('ghp_PROVIDERPAT');
    } finally {
      if (envBackup !== undefined) process.env.ANTHROPIC_API_KEY = envBackup;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('unknown providerId → session-pending then immediate session-failed (no spawn)', async () => {
    const ctx = await start();
    sendCommand(ctx, { type: 'create-session', providerId: 'ghost' });
    await waitFor(() => ofType(ctx, 'session-failed').length === 1);
    const pendingId = ofType(ctx, 'session-pending')[0]!.pendingId;
    const failed = ofType(ctx, 'session-failed')[0]!;
    expect(failed.pendingId).toBe(pendingId);
    expect(failed.reason).toMatch(/Unknown provider profile 'ghost'/);
    expect(ctx.facade.sessions.size).toBe(0);
  });

  it('token-less profile → session-pending then immediate session-failed (no spawn)', async () => {
    const ctx = await start({
      seedStorage: (storage) => seedProfiles(storage, kimiProfile({ authToken: undefined as unknown as string })),
    });
    sendCommand(ctx, { type: 'create-session', providerId: 'kimi' });
    await waitFor(() => ofType(ctx, 'session-failed').length === 1);
    expect(ofType(ctx, 'session-failed')[0]!.reason).toMatch(/no API token stored/);
    expect(ctx.facade.sessions.size).toBe(0);
  });

  // --- CDX-071 amendment: the https rule enforced at USE, not only at write ---
  //
  // CDX-071 put the rule on the `set-provider-profile` decode only, so it
  // protected NEW writes and nothing else. A row written before that commit
  // keeps its `http://` base, and every one of these paths would still have
  // handed the profile's token to a cleartext destination.

  it('LEGACY http:// profile: create-session refuses with the rule as the reason — no spawn, token never handed out', async () => {
    const ctx = await start({
      // Exactly what a pre-CDX-071 set-provider-profile left on disk: the write
      // gate did not exist yet, so this row was legal when it was stored.
      seedStorage: (storage) => seedProfiles(storage, kimiProfile({ baseUrl: 'http://api.moonshot.ai/anthropic' })),
    });
    sendCommand(ctx, { type: 'create-session', providerId: 'kimi' });
    await waitFor(() => ofType(ctx, 'session-failed').length === 1);

    const failed = ofType(ctx, 'session-failed')[0]!;
    expect(failed.pendingId).toBe(ofType(ctx, 'session-pending')[0]!.pendingId);
    // The operator learns WHY, in the same sentence the phone's Save gate shows.
    expect(failed.reason).toContain(PROVIDER_BASE_URL_ERROR);
    expect(failed.reason).toMatch(/insecure base URL/);
    expect(failed.reason).toContain('http://api.moonshot.ai/anthropic');
    expect(failed.reason).toMatch(/cleartext/);
    // Nothing spawned, so nothing could have carried the token.
    expect(ctx.facade.sessions.size).toBe(0);
    expect(ctx.logs.join('\n')).not.toContain(KIMI_TOKEN);

    // …but the profile is STILL LISTED. Refusing to publish it would leave the
    // operator unable to see, fix or delete the very row that needs fixing —
    // the read echo is permissive on purpose (providerProfileInfoSchema).
    sendCommand(ctx, { type: 'provider-profiles-request' });
    await waitFor(() => ofType(ctx, 'provider-profiles').length >= 1);
    const listed = ofType(ctx, 'provider-profiles').at(-1)!.profiles;
    expect(listed.map((p) => p.id)).toEqual(['kimi']);
    expect(listed[0]!.baseUrl).toBe('http://api.moonshot.ai/anthropic');
    expect(listed[0]!.hasToken).toBe(true);
  });

  it('LEGACY http:// profile: an operator can still DELETE it — the refusal is never a lockout', async () => {
    const ctx = await start({
      seedStorage: (storage) => seedProfiles(storage, kimiProfile({ baseUrl: 'http://api.moonshot.ai/anthropic' })),
    });
    sendCommand(ctx, { type: 'set-provider-profile', profileId: 'kimi', profile: null });
    await waitFor(() => ofType(ctx, 'provider-profile-ack').length === 1);
    expect(ofType(ctx, 'provider-profile-ack')[0]!.success).toBe(true);
    expect(JSON.parse(ctx.storage.get('providerProfiles')!).profiles).toEqual([]);
  });

  it('LEGACY http:// profile on loopback still works — Ollama/LM Studio are not collateral', async () => {
    const ctx = await start({
      seedStorage: (storage) => seedProfiles(storage, kimiProfile({ baseUrl: 'http://127.0.0.1:11434' })),
    });
    const bound = await createProviderSession(ctx, 'kimi');
    expect(ctx.facade.session(bound).options.env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:11434');
    expect(ofType(ctx, 'session-failed')).toHaveLength(0);
  });

  it('LEGACY http:// profile: resume-on-boot refuses loudly with an error entry — never a silent downgrade', async () => {
    const ctx = await start({
      seedStorage: (storage) => seedProfiles(storage, kimiProfile({ baseUrl: 'http://api.moonshot.ai/anthropic' })),
      seedRegistry: async (stateDir) => {
        const registry = new SessionRegistry(stateDir);
        await registry.upsert({
          sessionId: 'legacy-kimi',
          sdkSessionId: 'sdk-kimi-old',
          cwd: '/work/proj',
          providerId: 'kimi',
          title: 'Kimi work',
          project: 'proj',
          createdAt: '2026-08-09T00:00:00Z',
          lastActivity: '2026-08-09T00:00:00Z',
          state: 'offline',
        });
      },
    });
    // Resume-on-boot never reaches handleCreateSession — buildSessionEnv is the
    // gate that has to hold here, and it does: no SDK session was spawned.
    expect(ctx.facade.sessions.has('legacy-kimi')).toBe(false);
    await waitFor(() => ctx.core.transcript.seqHigh('legacy-kimi') >= 1);
    const entries = await ctx.core.transcript.readRange('legacy-kimi', [1, 10]);
    const error = entries.find((e) => e.entry.entryType === 'error');
    expect(error?.entry.content).toContain(PROVIDER_BASE_URL_ERROR);
    expect(error?.entry.content).toMatch(/insecure base URL/);
    expect(ctx.logs.join('\n')).not.toContain(KIMI_TOKEN);
  });

  it('an insecure base URL cannot be WRITTEN either — nothing stored, no Bearer validation POST', async () => {
    const fetched: string[] = [];
    const ctx = await start({
      coreOpts: {
        fetchFn: (async (url: string | URL | Request) => {
          fetched.push(String(url));
          return new Response('{}', { status: 200 });
        }) as unknown as typeof fetch,
      },
    });
    // encodePhoneToBridge would throw on this shape (that is CDX-071's phone-side
    // gate), so the only way to put it on the wire is to skip the encoder — which
    // is exactly what a pre-gate or hostile phone does.
    sendRawCommand(ctx, JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'set-provider-profile',
      profileId: 'evil',
      profile: {
        label: 'Evil',
        baseUrl: 'http://evil.example.com',
        authToken: 'sk-MUST-NOT-BE-POSTED',
        models: [{ id: 'm1' }],
      },
    }));
    await waitFor(() => ctx.logs.some((l) => l.includes('baseUrl')));

    // Never stored, so no later spawn can pick it up…
    expect(ctx.storage.get('providerProfiles')).toBeUndefined();
    // …and the token was never POSTed anywhere as `Authorization: Bearer`.
    expect(fetched).toEqual([]);
    expect(ctx.logs.join('\n')).not.toContain('sk-MUST-NOT-BE-POSTED');
    // The reason is on record; the phone already refuses this at Save (58e5df2),
    // so the operator sees the sentence there rather than waiting for an ack.
    expect(ctx.logs.some((l) => l.includes(PROVIDER_BASE_URL_ERROR))).toBe(true);
    // …and it was `decodePhoneToBridge` that caught it, naming the field.
    expect(ctx.logs.some((l) => l.includes('Dropping invalid payload') && l.includes('baseUrl'))).toBe(true);
  });

  it('handleSetProviderProfile itself refuses an insecure URL — the store invariant does not depend on decode', async () => {
    // Deliberately called DIRECTLY. The decode gate above means no wire payload
    // can reach this branch today, and an uncovered security guard rots — so the
    // second layer is exercised at its own seam rather than left to inspection.
    // What it buys: "the bridge never PERSISTS an insecure profile" becomes a
    // property of the store, so relaxing the schema can never silently re-open
    // the validation POST's cleartext `Authorization: Bearer`.
    const fetched: string[] = [];
    const ctx = await start({
      coreOpts: {
        fetchFn: (async (url: string | URL | Request) => {
          fetched.push(String(url));
          return new Response('{}', { status: 200 });
        }) as unknown as typeof fetch,
      },
    });
    const handler = (ctx.core as unknown as {
      handleSetProviderProfile(msg: SetProviderProfileMessage, phone: string): Promise<void>;
    }).handleSetProviderProfile.bind(ctx.core);

    await handler({
      v: PROTOCOL_VERSION,
      type: 'set-provider-profile',
      profileId: 'evil',
      profile: {
        label: 'Evil',
        baseUrl: 'http://evil.example.com',
        authToken: 'sk-MUST-NOT-BE-POSTED',
        models: [{ id: 'm1' }],
      },
    }, phonePubkey);

    const ack = ofType(ctx, 'provider-profile-ack').at(-1)!;
    expect(ack.success).toBe(false);
    expect(ack.error).toBe(PROVIDER_BASE_URL_ERROR);
    expect(ctx.storage.get('providerProfiles')).toBeUndefined();
    expect(fetched).toEqual([]);
    expect(ctx.logs.join('\n')).not.toContain('sk-MUST-NOT-BE-POSTED');

    // A DELETE is still honoured on the same handler — the guard sits after the
    // delete branch on purpose, so a legacy row can always be removed.
    await handler({
      v: PROTOCOL_VERSION,
      type: 'set-provider-profile',
      profileId: 'evil',
      profile: null,
    }, phonePubkey);
    expect(ofType(ctx, 'provider-profile-ack').at(-1)!.success).toBe(true);
  });

  it('usage-request for a provider-bound session is WITHHELD (published for Anthropic sessions)', async () => {
    const ctx = await start({
      seedStorage: (storage) => seedProfiles(storage, kimiProfile()),
    });
    const bound = await createProviderSession(ctx, 'kimi');
    ctx.facade.session(bound).usageSnapshot = {
      rate_limits_available: true,
      subscription_type: 'max',
      rate_limits: { five_hour: { utilization: 55, resets_at: '2026-08-09T15:00:00Z' } },
    };
    sendCommand(ctx, { type: 'usage-request', sessionId: bound });
    sendCommand(ctx, { type: 'refresh-sessions' }); // marker to sequence
    await waitFor(() => ofType(ctx, 'sessions').length >= 2);
    expect(ofType(ctx, 'usage')).toHaveLength(0);
    expect(ctx.logs.some((l) => l.includes('withheld'))).toBe(true);

    // Anthropic sessions still publish usage.
    const plain = await createSession(ctx);
    ctx.facade.session(plain).usageSnapshot = {
      rate_limits_available: true,
      subscription_type: 'max',
      rate_limits: { five_hour: { utilization: 12, resets_at: '2026-08-09T15:00:00Z' } },
    };
    sendCommand(ctx, { type: 'usage-request', sessionId: plain });
    await waitFor(() => ofType(ctx, 'usage').length === 1);
    expect(ofType(ctx, 'usage')[0]!.sessionId).toBe(plain);
  });

  it('model change guard: provider-bound sessions accept only models from their profile list', async () => {
    const ctx = await start({
      seedStorage: (storage) => seedProfiles(storage, kimiProfile()),
    });
    const bound = await createProviderSession(ctx, 'kimi');

    // Off-list (Anthropic) model → rejected: log + NO model-confirmed.
    sendCommand(ctx, { type: 'model', sessionId: bound, model: 'claude-sonnet-4-6' });
    sendCommand(ctx, { type: 'refresh-sessions' });
    await waitFor(() => ofType(ctx, 'sessions').length >= 2);
    expect(ofType(ctx, 'model-confirmed')).toHaveLength(0);
    expect(ctx.facade.session(bound).models).toEqual([]);
    expect(ctx.logs.some((l) => l.includes('model change rejected'))).toBe(true);

    // In-list model → applied + confirmed.
    sendCommand(ctx, { type: 'model', sessionId: bound, model: 'kimi-k3-turbo' });
    await waitFor(() => ofType(ctx, 'model-confirmed').length === 1);
    expect(ofType(ctx, 'model-confirmed')[0]).toMatchObject({ sessionId: bound, model: 'kimi-k3-turbo' });

    // Profile deleted → even in-list changes are rejected.
    sendCommand(ctx, { type: 'set-provider-profile', profileId: 'kimi', profile: null });
    await waitFor(() => ofType(ctx, 'provider-profile-ack').length === 1);
    sendCommand(ctx, { type: 'model', sessionId: bound, model: 'kimi-k3' });
    sendCommand(ctx, { type: 'refresh-sessions' });
    await waitFor(() => ofType(ctx, 'sessions').length >= 3);
    expect(ofType(ctx, 'model-confirmed')).toHaveLength(1); // unchanged
    expect(ctx.logs.some((l) => l.includes("provider profile 'kimi' was deleted"))).toBe(true);
  });

  it('session list carries providerId + providerLabel; a deleted profile degrades to the raw id', async () => {
    const ctx = await start({
      seedStorage: (storage) => seedProfiles(storage, kimiProfile()),
    });
    const bound = await createProviderSession(ctx, 'kimi');

    await waitFor(() => ofType(ctx, 'sessions').some((l) =>
      l.sessions.some((s) => s.id === bound && s.providerId === 'kimi' && s.providerLabel === 'Kimi K3')));

    // session-ready carried it too.
    const ready = ofType(ctx, 'session-ready').find((m) => m.pendingId === bound)!;
    expect(ready.session.providerId).toBe('kimi');
    expect(ready.session.providerLabel).toBe('Kimi K3');

    // Registry record persists the binding (survives resume-on-boot).
    expect(ctx.core.registry.get(bound)?.providerId).toBe('kimi');

    // Delete the profile — the display label degrades to the raw id.
    sendCommand(ctx, { type: 'set-provider-profile', profileId: 'kimi', profile: null });
    await waitFor(() => ofType(ctx, 'provider-profile-ack').length === 1);
    sendCommand(ctx, { type: 'refresh-sessions' });
    await waitFor(() => ofType(ctx, 'sessions').some((l) =>
      l.sessions.some((s) => s.id === bound && s.providerLabel === 'kimi')));
  });

  it('models-request: a lone provider-bound live handle does not poison the Anthropic model list (empty + reason)', async () => {
    const ctx = await start({
      seedStorage: (storage) => seedProfiles(storage, kimiProfile()),
    });
    ctx.facade.models = [{ id: 'claude-opus-4', label: 'Opus' }];
    await createProviderSession(ctx, 'kimi');

    // Only a provider-bound handle is live — the facade must NOT let it answer.
    sendCommand(ctx, { type: 'models-request' });
    await waitFor(() => ofType(ctx, 'models').length === 1);
    expect(ofType(ctx, 'models')[0]!.models).toEqual([]);
    expect(ofType(ctx, 'models')[0]!.error).toMatch(/No live Claude session answered/);

    // With an Anthropic session alongside, the real list comes back.
    await createSession(ctx);
    sendCommand(ctx, { type: 'models-request' });
    await waitFor(() => ofType(ctx, 'models').length === 2);
    expect(ofType(ctx, 'models')[1]!.models).toEqual([{ id: 'claude-opus-4', label: 'Opus' }]);
  });

  it('resume-on-boot: a provider-bound session resumes onto its provider (record → env), not Anthropic', async () => {
    const ctx = await start({
      seedStorage: (storage) => seedProfiles(storage, kimiProfile()),
      seedRegistry: async (stateDir) => {
        const registry = new SessionRegistry(stateDir);
        await registry.upsert({
          sessionId: 'kimi-persisted',
          sdkSessionId: 'sdk-kimi-old',
          cwd: '/work/proj',
          model: 'kimi-k3',
          providerId: 'kimi',
          title: 'Kimi work',
          project: 'proj',
          createdAt: '2026-08-09T00:00:00Z',
          lastActivity: '2026-08-09T00:00:00Z',
          state: 'offline',
        });
      },
    });
    await waitFor(() => ctx.facade.sessions.has('kimi-persisted'));
    const opts = ctx.facade.session('kimi-persisted').options;
    expect(opts.resume).toBe('sdk-kimi-old');
    expect(opts.fallbackModel).toBeNull();
    expect(opts.env?.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
    expect(opts.env?.ANTHROPIC_AUTH_TOKEN).toBe(KIMI_TOKEN);
    expect(ctx.logs.join('\n')).not.toContain(KIMI_TOKEN);
  });

  it('resume-on-boot with the profile DELETED: fails loudly with an error entry — never a silent Anthropic fallback', async () => {
    const ctx = await start({
      // No profiles seeded — the record's provider is gone.
      seedRegistry: async (stateDir) => {
        const registry = new SessionRegistry(stateDir);
        await registry.upsert({
          sessionId: 'orphan-kimi',
          sdkSessionId: 'sdk-kimi-old',
          cwd: '/work/proj',
          providerId: 'kimi',
          title: 'Kimi work',
          project: 'proj',
          createdAt: '2026-08-09T00:00:00Z',
          lastActivity: '2026-08-09T00:00:00Z',
          state: 'offline',
        });
      },
    });
    // No SDK session was ever spawned (the env builder refused)…
    expect(ctx.facade.sessions.has('orphan-kimi')).toBe(false);
    // …and the failure is on record in the transcript, naming the cause.
    await waitFor(() => ctx.core.transcript.seqHigh('orphan-kimi') >= 1);
    const entries = await ctx.core.transcript.readRange('orphan-kimi', [1, 10]);
    expect(entries.some((e) =>
      e.entry.entryType === 'error' && /provider profile 'kimi' was deleted/.test(e.entry.content))).toBe(true);
  });

  it('buildSessionEnv: no profile delegates to sessionEnvFromCredentials; D4 recipe with one; throws without a token', () => {
    const base = {
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'sk-env',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-env',
      GITHUB_TOKEN: 'ghp_env',
      UNDEF: undefined,
    };

    // No profile → exact delegation (zero behavior change, OAuth token untouched).
    expect(buildSessionEnv({}, undefined, base)).toEqual(sessionEnvFromCredentials({}, base));
    expect(buildSessionEnv({ anthropicApiKey: 'sk-stored' }, undefined, base))
      .toEqual(sessionEnvFromCredentials({ anthropicApiKey: 'sk-stored' }, base));
    expect(sessionEnvFromCredentials({ anthropicApiKey: 'sk-stored' }, base)!.CLAUDE_CODE_OAUTH_TOKEN)
      .toBe('sk-ant-oat-env');

    // With a profile: the vendor namespace is scrubbed (the subscription OAuth
    // token must never be offered to a third-party host), then the trio is set.
    const env = buildSessionEnv({ githubPat: 'ghp_stored' }, kimiProfile(), base)!;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(KIMI_TOKEN);
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('kimi-k3'); // defaultModel
    expect(env.GITHUB_TOKEN).toBe('ghp_stored'); // stored-wins unchanged
    expect(env.PATH).toBe('/bin');
    expect('UNDEF' in env).toBe(false);

    // defaultModel absent → first model in the list.
    const noDefault = buildSessionEnv({}, kimiProfile({ defaultModel: undefined as unknown as string }), base)!;
    expect(noDefault.ANTHROPIC_SMALL_FAST_MODEL).toBe('kimi-k3');

    // No stored token → throw (the caller fails the spawn loudly).
    expect(() => buildSessionEnv({}, kimiProfile({ authToken: undefined as unknown as string }), base))
      .toThrow(/no stored auth token/);
  });

  it('buildSessionEnv: a stored insecure base URL throws — the https rule is enforced at USE, not only at write (CDX-071)', () => {
    const base: Record<string, string | undefined> = { PATH: '/bin' };

    // The whole point of the amendment: this row is *already in storage*, so no
    // write gate will ever see it again. The last seam before the token becomes
    // subprocess env has to be the one that refuses.
    for (const bad of [
      'http://api.moonshot.ai/anthropic',
      'http://evil.localhost:8080',       // resolves wherever its DNS says
      'http://0.0.0.0:11434',             // a bind address, not a destination
      'ftp://api.moonshot.ai',
      'not-a-url',
    ]) {
      expect(() => buildSessionEnv({}, kimiProfile({ baseUrl: bad }), base))
        .toThrow(PROVIDER_BASE_URL_ERROR);
      // The refusal names the offending URL, so the operator can fix it.
      expect(() => buildSessionEnv({}, kimiProfile({ baseUrl: bad }), base)).toThrow(bad);
    }

    // Loopback http stays legal — a local model server has no certificate and
    // that traffic never leaves the machine.
    for (const ok of ['http://localhost:11434', 'http://127.0.0.1:1234', 'http://[::1]:8080']) {
      expect(buildSessionEnv({}, kimiProfile({ baseUrl: ok }), base)!.ANTHROPIC_BASE_URL).toBe(ok);
    }

    // The base URL is checked BEFORE the token: a profile that is both
    // token-less AND insecure must not report the fixable problem first and
    // send the operator round a loop that ends in cleartext.
    expect(() => buildSessionEnv(
      {},
      kimiProfile({ baseUrl: 'http://api.moonshot.ai', authToken: undefined as unknown as string }),
      base,
    )).toThrow(/insecure base URL/);
  });
});

// --- CDX-071: env sanitization for provider-bound sessions ---

/**
 * A REALISTIC polluted operator environment. The CDX-062 tests all passed a
 * synthetic base containing only the vars under test, so the whole inherited
 * surface — which is what an operator's shell actually looks like — was never
 * exercised. Everything here is a documented Claude Code / cloud-SDK variable
 * a bridge operator plausibly has exported.
 */
const OPERATOR_ENV: Record<string, string | undefined> = {
  // --- legitimate, must survive ---
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/home/op',
  SHELL: '/bin/bash',
  TERM: 'xterm-256color',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  TMPDIR: '/tmp',
  XDG_RUNTIME_DIR: '/run/user/1000',
  SSH_AUTH_SOCK: '/run/user/1000/keyring/ssh',
  HTTPS_PROXY: 'http://proxy.corp:3128',
  HTTP_PROXY: 'http://proxy.corp:3128',
  NO_PROXY: 'localhost,127.0.0.1',
  ALL_PROXY: 'socks5://proxy.corp:1080',
  NODE_EXTRA_CA_CERTS: '/etc/ssl/corp-ca.pem',
  NODE_OPTIONS: '--max-old-space-size=4096',
  GITHUB_TOKEN: 'ghp_env',
  EDITOR: 'vim',
  // --- vendor namespace, must NOT survive ---
  // 1. cloud provider selection — documented to OUTRANK ANTHROPIC_AUTH_TOKEN
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_VERTEX: '1',
  CLAUDE_CODE_USE_FOUNDRY: '1',
  CLAUDE_CODE_USE_ANTHROPIC_AWS: '1',
  CLAUDE_CODE_USE_GATEWAY: '1',
  CLAUDE_CODE_USE_MANTLE: '1',
  CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
  CLOUD_ML_REGION: 'us-east5',
  // 2. alternate base URLs
  ANTHROPIC_BASE_URL: 'https://gateway.corp/v1',
  ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock.corp',
  ANTHROPIC_VERTEX_BASE_URL: 'https://vertex.corp',
  ANTHROPIC_FOUNDRY_BASE_URL: 'https://foundry.corp',
  ANTHROPIC_UNIX_SOCKET: '/run/anthropic.sock',
  // 3. credentials
  ANTHROPIC_API_KEY: 'sk-env',
  ANTHROPIC_AUTH_TOKEN: 'sk-gateway-token',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-env',
  AWS_ACCESS_KEY_ID: 'AKIAOPERATOR',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  AWS_SESSION_TOKEN: 'aws-session',
  AWS_BEARER_TOKEN_BEDROCK: 'bedrock-bearer',
  AWS_PROFILE: 'prod',
  AWS_REGION: 'eu-west-1',
  ANTHROPIC_FOUNDRY_API_KEY: 'foundry-key',
  ANTHROPIC_AWS_API_KEY: 'aws-anthropic-key',
  GOOGLE_APPLICATION_CREDENTIALS: '/home/op/gcp.json',
  GOOGLE_CLOUD_PROJECT: 'op-project',
  GCLOUD_PROJECT: 'op-project',
  CLOUDSDK_AUTH_ACCESS_TOKEN: 'gcp-access-token',
  CLAUDE_CODE_HFI_BEARER_TOKEN: 'hfi-bearer',
  CLAUDE_TRUSTED_DEVICE_TOKEN: 'device-token',
  // 4. the header leak: a gateway credential / tenant key, sent verbatim as an
  //    HTTP header to whatever host ANTHROPIC_BASE_URL names
  ANTHROPIC_CUSTOM_HEADERS: 'X-Gateway-Key: gw-secret-abc\nX-Tenant: acme',
  // 5. mTLS identity
  CLAUDE_CODE_CLIENT_CERT: '/home/op/client.pem',
  CLAUDE_CODE_CLIENT_KEY: '/home/op/client.key',
  CLAUDE_CODE_CLIENT_KEY_PASSPHRASE: 'passphrase',
  // 6. model overrides — would point background/alias work at Claude ids
  ANTHROPIC_MODEL: 'claude-opus-4-5',
  ANTHROPIC_BETAS: 'context-1m-2025-08-07',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
  ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-4-5',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
  CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-4-6',
  // 7. keep-list members (inside the namespace, deliberately inherited)
  CLAUDE_CONFIG_DIR: '/home/op/.config/claude',
  CLAUDE_CODE_SHELL: '/bin/zsh',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  UNSET: undefined,
};

/** Every secret seeded into OPERATOR_ENV that must not reach a third party. */
const OPERATOR_SECRETS = [
  'sk-env', 'sk-gateway-token', 'sk-ant-oat-env', 'AKIAOPERATOR', 'aws-secret',
  'aws-session', 'bedrock-bearer', 'foundry-key', 'aws-anthropic-key',
  'gcp-access-token', 'hfi-bearer', 'device-token', 'gw-secret-abc', 'passphrase',
];

describe('buildSessionEnv — provider env sanitization (CDX-071)', () => {
  it('a Bedrock/Vertex/Foundry-configured operator shell cannot outrank the profile', () => {
    // Pre-fix symptom: the provider branch spread all of process.env and
    // deleted only ANTHROPIC_API_KEY + CLAUDE_CODE_OAUTH_TOKEN, so an operator
    // with CLAUDE_CODE_USE_BEDROCK=1 exported got a "Kimi" session that ran on
    // Bedrock and billed their AWS account — ANTHROPIC_BASE_URL ignored, no error.
    const env = buildSessionEnv({}, kimiProfile(), OPERATOR_ENV)!;
    for (const flag of [
      'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_GATEWAY', 'CLAUDE_CODE_USE_MANTLE',
      'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'CLOUD_ML_REGION',
    ]) {
      expect(env[flag], flag).toBeUndefined();
    }
    // …and the profile is the only backend left standing.
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(KIMI_TOKEN);
    for (const url of [
      'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL',
      'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_UNIX_SOCKET',
    ]) {
      expect(env[url], url).toBeUndefined();
    }
  });

  it('no operator credential reaches the third-party host — headers, mTLS identity and cloud keys all dropped', () => {
    const env = buildSessionEnv({}, kimiProfile(), OPERATOR_ENV)!;
    // ANTHROPIC_CUSTOM_HEADERS is the sharpest one: it is sent verbatim as HTTP
    // headers to whatever ANTHROPIC_BASE_URL names, with no host filtering.
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    for (const name of [
      'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
      'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
      'AWS_BEARER_TOKEN_BEDROCK', 'AWS_PROFILE', 'AWS_REGION',
      'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_AWS_API_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT',
      'CLOUDSDK_AUTH_ACCESS_TOKEN', 'CLAUDE_CODE_HFI_BEARER_TOKEN',
      'CLAUDE_TRUSTED_DEVICE_TOKEN',
      'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY', 'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
    ]) {
      expect(env[name], name).toBeUndefined();
    }
    // Blanket check: the ONLY secret in the result is the profile's own token.
    const serialized = JSON.stringify(env);
    for (const secret of OPERATOR_SECRETS) {
      expect(serialized.includes(secret), secret).toBe(false);
    }
    expect(serialized).toContain(KIMI_TOKEN);
  });

  it('inherited model overrides cannot point the session at a Claude model id', () => {
    const env = buildSessionEnv({}, kimiProfile(), OPERATOR_ENV)!;
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_BETAS).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
    // The operator's claude-haiku-4-5 is REPLACED, not merely coexisting.
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-k3');
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('kimi-k3');
  });

  it('the background model is set under BOTH names — deprecated and current', () => {
    // ANTHROPIC_SMALL_FAST_MODEL is documented as deprecated in favour of
    // ANTHROPIC_DEFAULT_HAIKU_MODEL but is still read by the installed SDK.
    // Setting both means neither a CLI upgrade nor a downgrade can silently
    // send background tasks to a model id the provider does not serve.
    const env = buildSessionEnv({}, kimiProfile({ defaultModel: 'kimi-k3-turbo' }), OPERATOR_ENV)!;
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-k3-turbo');
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('kimi-k3-turbo');
    // defaultModel absent → first model in the list, under both names.
    const first = buildSessionEnv(
      {}, kimiProfile({ defaultModel: undefined as unknown as string }), OPERATOR_ENV)!;
    expect(first.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-k3');
    expect(first.ANTHROPIC_SMALL_FAST_MODEL).toBe('kimi-k3');
  });

  it('legitimate inherited env survives — a scrubbed session is still a working session', () => {
    const env = buildSessionEnv({}, kimiProfile(), OPERATOR_ENV)!;
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin:/bin');
    expect(env.HOME).toBe('/home/op');
    expect(env.SHELL).toBe('/bin/bash');
    expect(env.TERM).toBe('xterm-256color');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.LC_ALL).toBe('en_US.UTF-8');
    expect(env.TMPDIR).toBe('/tmp');
    expect(env.XDG_RUNTIME_DIR).toBe('/run/user/1000');
    expect(env.SSH_AUTH_SOCK).toBe('/run/user/1000/keyring/ssh');
    expect(env.EDITOR).toBe('vim');
    // Proxy + CA config is the operator's network reality, applied identically
    // on the Anthropic path — a session that cannot reach the internet is not
    // more secure.
    expect(env.HTTPS_PROXY).toBe('http://proxy.corp:3128');
    expect(env.HTTP_PROXY).toBe('http://proxy.corp:3128');
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1');
    expect(env.ALL_PROXY).toBe('socks5://proxy.corp:1080');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/corp-ca.pem');
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096');
    // GITHUB_TOKEN is outside the namespace: inherited, and stored still wins.
    expect(env.GITHUB_TOKEN).toBe('ghp_env');
    expect(buildSessionEnv({ githubPat: 'ghp_stored' }, kimiProfile(), OPERATOR_ENV)!.GITHUB_TOKEN)
      .toBe('ghp_stored');
    // Undefined values never materialize as the string "undefined".
    expect('UNSET' in env).toBe(false);
  });

  it('the keep-list survives: config dir, shell and the privacy switch', () => {
    const env = buildSessionEnv({}, kimiProfile(), OPERATOR_ENV)!;
    // Dropping these breaks the session (config/state root, Bash tool shell) or
    // silently re-enables traffic the operator switched off.
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/op/.config/claude');
    expect(env.CLAUDE_CODE_SHELL).toBe('/bin/zsh');
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
  });

  it('a vendor var invented AFTER this code was written is dropped by default', () => {
    // The whole point of the prefix rule: the CLI registers 558 vars under
    // these namespaces today and adds more every release. A denylist would
    // honour each new one until someone noticed.
    const env = sanitizeProviderBaseEnv({
      PATH: '/bin',
      CLAUDE_CODE_USE_SOME_CLOUD_2027: '1',
      ANTHROPIC_FUTURE_ROUTING_HINT: 'x',
      AWS_NEW_CREDENTIAL_THING: 'x',
      GOOGLE_NEXT_THING: 'x',
      VERTEX_SOMETHING: 'x',
      BEDROCK_SOMETHING: 'x',
      AZURE_SOMETHING: 'x',
      CLOUDSDK_SOMETHING: 'x',
      GCLOUD_SOMETHING: 'x',
    });
    expect(env).toEqual({ PATH: '/bin' });
  });

  it('is case-insensitive about var names (Windows env is case-insensitive)', () => {
    const env = sanitizeProviderBaseEnv({
      Path: 'C:\\bin',
      anthropic_api_key: 'sk-env',
      Claude_Code_Use_Bedrock: '1',
      claude_config_dir: '/home/op/.config/claude',
    });
    expect(env.anthropic_api_key).toBeUndefined();
    expect(env.Claude_Code_Use_Bedrock).toBeUndefined();
    expect(env.Path).toBe('C:\\bin');
    expect(env.claude_config_dir).toBe('/home/op/.config/claude'); // keep-list, either case
  });

  it('the Anthropic (no-profile) path is BYTE-IDENTICAL on the same polluted env', () => {
    // The scrub is provider-branch-only. A plain Anthropic session on this
    // machine must behave exactly as it did before CDX-071 — including keeping
    // the operator's Bedrock flags, which are their deliberate configuration.
    for (const stored of [
      {},
      { anthropicApiKey: 'sk-stored' },
      { githubPat: 'ghp_stored' },
      { anthropicApiKey: 'sk-stored', githubPat: 'ghp_stored' },
    ]) {
      expect(buildSessionEnv(stored, undefined, OPERATOR_ENV))
        .toEqual(sessionEnvFromCredentials(stored, OPERATOR_ENV));
    }
    const anthropic = sessionEnvFromCredentials({ anthropicApiKey: 'sk-stored' }, OPERATOR_ENV)!;
    expect(anthropic.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(anthropic.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Gateway-Key: gw-secret-abc\nX-Tenant: acme');
    expect(anthropic.ANTHROPIC_API_KEY).toBe('sk-env'); // env wins, unchanged
  });
});

// --- CDX-013: transcript retention sweep ---

describe('BridgeCore — transcript retention (CDX-013)', () => {
  it('boot sweep removes orphaned transcripts and caps live ones without renumbering', async () => {
    const line = (seq: number): string =>
      JSON.stringify({
        seq,
        entry: { entryType: 'text', content: `e${seq}`, timestamp: '2026-08-05T00:00:00Z' },
      });

    const ctx = await startCore({
      seedRegistry: async (stateDir) => {
        const registry = new SessionRegistry(stateDir);
        await registry.upsert({
          sessionId: 'live-sess',
          sdkSessionId: null,
          cwd: path.join(stateDir, '..', 'workspace'),
          title: null,
          project: 'p',
          createdAt: '2026-08-05T00:00:00Z',
          lastActivity: '2026-08-05T00:00:00Z',
          state: 'offline',
        });
        const tdir = path.join(stateDir, 'transcripts');
        mkdirSync(tdir, { recursive: true });
        // Orphan: transcript with NO registry record (crash between removes).
        await fs.writeFile(path.join(tdir, 'orphan.jsonl'), [line(1), line(2)].join('\n') + '\n');
        // Live session over the default 5000-entry cap.
        const lines: string[] = [];
        for (let i = 1; i <= 5010; i++) lines.push(line(i));
        await fs.writeFile(path.join(tdir, 'live-sess.jsonl'), lines.join('\n') + '\n');
      },
    });

    try {
      const orphanFile = path.join(ctx.stateDir, 'transcripts', 'orphan.jsonl');
      const liveFile = path.join(ctx.stateDir, 'transcripts', 'live-sess.jsonl');
      await waitFor(() => !existsSync(orphanFile));
      await waitFor(() => {
        const kept = readFileSync(liveFile, 'utf8').trim().split('\n');
        return kept.length === 5000;
      });
      const kept = readFileSync(liveFile, 'utf8').trim().split('\n');
      // Original seqs survive the prune (sync coherence): oldest kept is 11.
      expect((JSON.parse(kept[0]!) as { seq: number }).seq).toBe(11);
      expect((JSON.parse(kept.at(-1)!) as { seq: number }).seq).toBe(5010);
      expect(ctx.core.transcript.seqHigh('live-sess')).toBe(5010);
    } finally {
      await ctx.core.shutdown();
      await fs.rm(ctx.dir, { recursive: true, force: true });
    }
  });

  it('transcriptKeepLast: 0 disables the sweep (orphans and long transcripts untouched)', async () => {
    const line = (seq: number): string =>
      JSON.stringify({
        seq,
        entry: { entryType: 'text', content: `e${seq}`, timestamp: '2026-08-05T00:00:00Z' },
      });
    const ctx = await startCore({
      seedRegistry: async (stateDir) => {
        const tdir = path.join(stateDir, 'transcripts');
        mkdirSync(tdir, { recursive: true });
        await fs.writeFile(path.join(tdir, 'orphan.jsonl'), line(1) + '\n');
      },
    });
    // Let the first boot's sweep (default on) finish removing the orphan
    // BEFORE shutdown, so its async removal cannot race the re-seed below.
    const tdirEarly = path.join(ctx.stateDir, 'transcripts');
    await waitFor(() => !existsSync(path.join(tdirEarly, 'orphan.jsonl')));
    await ctx.core.shutdown();
    try {
      // Re-seed the orphan, then boot a core whose host disables retention.
      const tdir = path.join(ctx.stateDir, 'transcripts');
      await fs.writeFile(path.join(tdir, 'orphan.jsonl'), line(1) + '\n');
      const host = {
        config: {
          machineName: 'test-machine',
          host: 'cli' as const,
          relays: ['wss://fake.relay'],
          workspaceRoots: [ctx.wsRoot],
          transcriptKeepLast: 0,
        },
        storage: {
          get: async (k: string) => ctx.storage.get(k),
          set: async (k: string, v: string) => { ctx.storage.set(k, v); },
          delete: async (k: string) => { ctx.storage.delete(k); },
        },
        sessionStateDir: () => ctx.stateDir,
        log: () => {},
        notify: () => {},
        presentPairing: (): PairingHandle => ({ close: () => {} }),
        onShutdown: () => {},
      } satisfies BridgeHost;
      const core2 = await BridgeCore.start({
        host,
        secretKey: bridgeSecret,
        facade: new FakeSdkFacade(),
        poolFactory: (options, cb) => new FakePool(options, cb),
        heartbeatIntervalMs: 0,
        gitPollIntervalMs: 0,
        meshAdmin: disabledMeshAdmin(),
      });
      await new Promise((r) => setTimeout(r, 100));
      expect(existsSync(path.join(tdir, 'orphan.jsonl'))).toBe(true);
      await core2.shutdown();
    } finally {
      await fs.rm(ctx.dir, { recursive: true, force: true });
    }
  });
});
