/**
 * CDX-009 Phase 3a — the PRODUCTION phone core against a REAL BridgeCore over
 * the in-memory relay (the CDX-008 harness, with the PhoneSimulator replaced
 * by createPhoneCore). Mirrors contract Scenario A end-to-end:
 *
 *   pair via the real pairing window → session in a folder → live output lands
 *   in transcriptStore → input via the outbox reaches confirmed → bridge
 *   restart → phone FSM reconnect → refresh + sync gap-refill → contiguous
 *   transcript identical to the bridge's store.
 *
 * @codedeck/core and @codedeck/testkit are devDependencies used ONLY here —
 * the production tree under src/core never imports them (layering.test.ts
 * enforces that).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BridgeCore,
  generateKeypair,
  type BridgeHost,
  type Keypair,
  type PairingHandle,
  type PairingPayload,
  type SdkMessage,
} from '@codedeck/core';
import { FakeSdkFacade, InMemoryRelay, ManualTimers, inMemoryPoolFactory } from '@codedeck/testkit';
import type { NostrEvent } from 'nostr-tools/core';
import { finalizeEvent } from 'nostr-tools/pure';
import { PROTOCOL_VERSION, RESPONSE_KIND, encodeBridgeToPhone } from '@codedeck/protocol';
import {
  createPhoneCore,
  memoryKV,
  parsePairingUrl,
  encryptTo,
  decryptFrom,
  type PhoneCore,
  type PhoneTransport,
} from '../core';
import type { RelayEvent, RelayFilter } from '@codedeck/testkit';

// --- Harness ---

/** The InMemoryRelay as a PhoneTransport (EOSE fires synchronously). */
function inMemoryTransport(relay: InMemoryRelay): PhoneTransport {
  return {
    subscribe: (filter, params) => {
      const sub = relay.subscribe(
        [filter as RelayFilter],
        (event) => params.onEvent(event as NostrEvent),
        () => params.onEose?.(),
      );
      return { close: () => sub.close() };
    },
    publish: async (event) => relay.publish(event as RelayEvent),
  };
}

async function until(
  cond: () => boolean,
  opts: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`until timed out after ${timeoutMs}ms${opts.label ? `: ${opts.label}` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

interface World {
  dir: string;
  relay: InMemoryRelay;
  bridgeKeys: Keypair;
  /** The bridge host's KV — exposed so tests can seed stored state (e.g. a
   *  CDX-062 provider profile persisted by "an earlier run"). */
  storage: Map<string, string>;
  logs: string[];
  cores: BridgeCore[];
  /** CDX-062: `fetchFn` injects the token-validation probe (same seam the
   *  testkit contract harness grew in phase A) — validation NEVER hits a real
   *  network from a test. */
  startBridge(facade: FakeSdkFacade, opts?: { fetchFn?: typeof fetch }): Promise<BridgeCore>;
  cleanup(): Promise<void>;
}

const worlds: World[] = [];
const phones: PhoneCore[] = [];

afterEach(async () => {
  while (phones.length > 0) await phones.pop()!.stop();
  while (worlds.length > 0) await worlds.pop()!.cleanup();
});

async function makeWorld(): Promise<World> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codedeck-phonecore-'));
  const stateDir = path.join(dir, 'state');
  const wsRoot = path.join(dir, 'workspace');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(path.join(wsRoot, 'projA'), { recursive: true });

  const storage = new Map<string, string>();
  const relay = new InMemoryRelay();
  const bridgeKeys = generateKeypair();
  const logs: string[] = [];
  const cores: BridgeCore[] = [];

  const host: BridgeHost = {
    config: {
      machineName: 'phonecore-machine',
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
    dir, relay, bridgeKeys, storage, logs, cores,
    startBridge: async (facade, o = {}) => {
      const core = await BridgeCore.start({
        host,
        secretKey: bridgeKeys.secretKey,
        facade,
        poolFactory: inMemoryPoolFactory(relay),
        heartbeatIntervalMs: 0,
        syncTimers: new ManualTimers(),
        ...(o.fetchFn ? { fetchFn: o.fetchFn } : {}),
      });
      cores.push(core);
      return core;
    },
    cleanup: async () => {
      for (const core of cores) await core.shutdown();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
  worlds.push(world);
  return world;
}

async function makePhone(world: World): Promise<PhoneCore> {
  const phone = await createPhoneCore({
    kv: memoryKV(),
    transport: inMemoryTransport(world.relay),
    timers: new ManualTimers(), // nothing fires unless the test advances it
    random: () => 0,
  });
  phones.push(phone);
  return phone;
}

// --- SDK message builders (same shapes the CDX-008 contract test drives) ---

function initMsg(sdkSessionId: string): SdkMessage {
  return {
    type: 'system', subtype: 'init', session_id: sdkSessionId,
    model: 'claude-test-1', permissionMode: 'plan', claude_code_version: '2.0.0',
    apiKeySource: 'none', cwd: '/work', tools: [], mcp_servers: [],
    slash_commands: [], output_style: 'default', skills: [], plugins: [], uuid: 'u-init',
  } as unknown as SdkMessage;
}

function assistantMsg(sdkSessionId: string, ...texts: string[]): SdkMessage {
  return {
    type: 'assistant', session_id: sdkSessionId, parent_tool_use_id: null,
    message: { model: 'claude-test-1', content: texts.map((text) => ({ type: 'text', text })) },
  } as unknown as SdkMessage;
}

/** Pair the phone through the REAL pairing window: QR URL → parse → pair flow. */
async function pairPhone(world: World, core: BridgeCore, phone: PhoneCore): Promise<string> {
  const info = core.openPairingWindow();
  const parsed = parsePairingUrl(info.url);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error);
  expect(parsed.parts.pubkeyHex).toBe(world.bridgeKeys.pubkeyHex);
  expect(parsed.parts.token).toBe(info.token);

  phone.pairing.getState().beginPair(parsed.parts, 'Contract Phone');
  await until(() => phone.pairing.getState().phase === 'paired', { label: 'pair-ack ok' });
  expect(core.pairingWindowOpen).toBe(false); // window closed itself on success
  return world.bridgeKeys.pubkeyHex;
}

/** create-session → SDK init → session-ready, all through the production path. */
async function createReadySession(
  world: World,
  facade: FakeSdkFacade,
  phone: PhoneCore,
  machine: string,
  opts: { cwd?: string } = {},
): Promise<string> {
  const before = facade.sessions.size;
  void phone.api.createSession(machine, opts.cwd ? { cwd: opts.cwd } : {});
  await until(() => facade.sessions.size > before, { label: 'SDK session spawned' });
  const sessionId = [...facade.sessions.keys()].at(-1)!;
  facade.emit(sessionId, initMsg(`sdk-${sessionId}`));
  await until(
    () => phone.machines.getState().session(machine, sessionId) !== undefined,
    { label: 'session visible on the phone' },
  );
  return sessionId;
}

// --- Scenarios ---

describe('phone core ⇄ BridgeCore contract (production phone code)', () => {
  it(
    'full loop: pairing window → session → live output → outbox confirm → bridge restart → FSM reconnect → sync gap-refill',
    async () => {
      const world = await makeWorld();
      const facade1 = new FakeSdkFacade();
      const core1 = await world.startBridge(facade1);
      const phone = await makePhone(world);

      // Boot the phone: FSM connects (vacuous — nothing paired yet).
      phone.start();
      await until(() => phone.connection.getState().status === 'connected', { label: 'FSM connected' });

      // Pair through the real pairing window.
      const machine = await pairPhone(world, core1, phone);
      await until(
        () => phone.machines.getState().machine(machine) !== undefined,
        { label: 'greeting heartbeat applied' },
      );
      const machineView = phone.machines.getState().machine(machine)!;
      expect(machineView.name).toBe('phonecore-machine');
      expect(machineView.host).toBe('cli');
      expect(machineView.label).toBe('phonecore-machine'); // from the pairing URL
      expect(machineView.capabilities).toContain('sync/1');
      expect(machineView.folders).toContain('projA');
      expect(core1.pairedPhones()[0]!.pubkeyHex).toBe(phone.identity.getState().pubkeyHex);
      expect(core1.pairedPhones()[0]!.label).toBe('Contract Phone');
      // Presence: heartbeat fresh + socket up = live.
      expect(phone.connection.getState().presence(machine)).toBe('live');

      // Session in a workspace folder.
      const sessionId = await createReadySession(world, facade1, phone, machine, { cwd: 'projA' });

      // Live output over ephemeral 24515 lands in the transcript store.
      facade1.emit(sessionId, assistantMsg(`sdk-${sessionId}`, 'hello from claude'));
      await until(
        () => phone.transcript.getState().entriesOf(machine, sessionId).length === 2,
        { label: 'live output (init + hello)' },
      );

      // Input through the outbox: pending → published → confirmed by input-ack.
      const sent = await phone.outbox.getState().send(machine, sessionId, 'do the thing');
      expect(['published', 'confirmed']).toContain(sent.state);
      await until(
        () => phone.outbox.getState().item(sent.id)!.state === 'confirmed',
        { label: 'outbox confirmed' },
      );
      expect(facade1.session(sessionId).inputs[0]).toContain('do the thing');

      facade1.emit(sessionId, assistantMsg(`sdk-${sessionId}`, 'work done'));
      // init, hello, the user's own entry, work done. CDX-082: the bridge
      // authors a role:'user' entry when it accepts input (the CLI does not
      // echo pushed messages), so a sent message occupies a seq of its own.
      const preRestartHigh = 4;
      await until(
        () => phone.transcript.getState().hasContiguous(machine, sessionId, preRestartHigh),
        { label: 'pre-restart transcript' },
      );

      // KILL the bridge: the phone sees a truthful offline list — sessions kept.
      await core1.shutdown();
      await until(
        () => phone.machines.getState().machine(machine)!.machineOffline,
        { label: 'offline heartbeat' },
      );
      expect(phone.machines.getState().session(machine, sessionId)).toBeDefined();
      expect(phone.machines.getState().session(machine, sessionId)!.presence).toBe('offline');

      // The phone loses the network (FSM offline — deliberate teardown, so the
      // epoch guard swallows it: no socket-close, no retry storm).
      phone.connection.getState().dispatch({ type: 'offline' });
      expect(phone.connection.getState().status).toBe('offline');

      // RESTART: a new BridgeCore over the same state dir resumes the session
      // and produces output the dark phone misses.
      const facade2 = new FakeSdkFacade();
      const core2 = await world.startBridge(facade2);
      await until(() => facade2.sessions.has(sessionId), { label: 'resume-on-boot' });
      facade2.emit(sessionId, assistantMsg(`sdk-${sessionId}`, 'missed-1', 'missed-2'));
      await until(
        () => core2.transcript.seqHigh(sessionId) === preRestartHigh + 2,
        { label: 'post-restart output persisted bridge-side' },
      );

      // Network back → FSM reconnects → refresh-sessions + sync reconcile fire
      // automatically (the production connect procedure, no manual nudging).
      phone.connection.getState().dispatch({ type: 'online' });
      await until(() => phone.connection.getState().status === 'connected', { label: 'FSM reconnected' });
      await until(
        () => phone.transcript.getState().hasContiguous(machine, sessionId, preRestartHigh + 2),
        { label: 'sync gap-refill', timeoutMs: 5000 },
      );

      // The phone transcript is byte-identical to the bridge's store.
      const bridgeLines = await core2.transcript.readRange(sessionId, [1, preRestartHigh + 2]);
      expect(phone.transcript.getState().entriesOf(machine, sessionId)).toEqual(bridgeLines);
      expect(phone.transcript.getState().seqConflicts).toEqual([]);
      expect(phone.transcript.getState().session(machine, sessionId)!.sync.state).toBe('complete');

      // Machine is back to a live, truthful view.
      await until(() => !phone.machines.getState().machine(machine)!.machineOffline, { label: 'live heartbeat' });
      expect(phone.connection.getState().presence(machine)).toBe('live');

      // Nothing invalid crossed the wire in either direction.
      expect(phone.api.diagnostics.decryptFailures).toBe(0);
      expect(phone.api.diagnostics.decodeFailures).toBe(0);
      expect(phone.connection.getState().needsPairingCheck).toBe(false);
    },
    15000,
  );

  it('wrong-token phone is rejected; the right token pairs after it', async () => {
    const world = await makeWorld();
    const facade = new FakeSdkFacade();
    const core = await world.startBridge(facade);
    const phone = await makePhone(world);
    phone.start();

    const info = core.openPairingWindow();
    const parsed = parsePairingUrl(info.url);
    if (!parsed.ok) throw new Error(parsed.error);

    phone.pairing.getState().beginPair({ ...parsed.parts, token: 'WRONG' }, 'Evil Phone');
    await until(() => phone.pairing.getState().phase === 'failed', { label: 'bad-token rejection' });
    expect(phone.pairing.getState().error).toBe('bad-token');
    expect(core.pairedPhones()).toEqual([]);
    expect(core.pairingWindowOpen).toBe(true); // a bad guess must not burn the window

    phone.pairing.getState().reset();
    phone.pairing.getState().beginPair(parsed.parts, 'Good Phone');
    await until(() => phone.pairing.getState().phase === 'paired', { label: 'paired with the right token' });
    expect(core.pairedPhones()).toHaveLength(1);
  });

  it('typed folder request/response + session created inside the new folder', async () => {
    const world = await makeWorld();
    const facade = new FakeSdkFacade();
    const core = await world.startBridge(facade);
    const phone = await makePhone(world);
    phone.start();
    const machine = await pairPhone(world, core, phone);

    const ack = await phone.api.createFolder(machine, 'newproj');
    expect(ack).toMatchObject({ success: true, path: 'newproj' });
    await until(
      () => phone.machines.getState().machine(machine)!.folders.includes('newproj'),
      { label: 'folder advertised in the heartbeat' },
    );

    const sessionId = await createReadySession(world, facade, phone, machine, { cwd: 'newproj' });
    expect(facade.session(sessionId).options.cwd).toContain('newproj');
  });

  it('input to a dead session surfaces as a FAILED outbox item, never vanishes', async () => {
    const world = await makeWorld();
    const facade = new FakeSdkFacade();
    const core = await world.startBridge(facade);
    const phone = await makePhone(world);
    phone.start();
    const machine = await pairPhone(world, core, phone);

    const item = await phone.outbox.getState().send(machine, 'ghost-session', 'hello?');
    await until(() => phone.outbox.getState().item(item.id)!.state === 'failed', { label: 'input-failed' });
    expect(phone.outbox.getState().item(item.id)!.error).toBe('no-session');
  });

  it('undecryptable bridge events are diagnostics, never disconnects — and traffic keeps flowing', async () => {
    const world = await makeWorld();
    const facade = new FakeSdkFacade();
    const core = await world.startBridge(facade);
    const phone = await makePhone(world);
    phone.start();
    const machine = await pairPhone(world, core, phone);
    const otherKeys = generateKeypair();

    // Three bridge-signed events the phone cannot decrypt (encrypted to the
    // wrong key) — the old app would have faked a disconnect out of this.
    for (let i = 0; i < 3; i++) {
      world.relay.publish(finalizeEvent(
        {
          kind: RESPONSE_KIND,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['p', phone.identity.getState().pubkeyHex]],
          content: encryptTo(world.bridgeKeys.secretKey, otherKeys.pubkeyHex, '{"type":"x"}'),
        },
        world.bridgeKeys.secretKey,
      ) as unknown as RelayEvent);
    }
    await until(() => phone.api.diagnostics.decryptFailures === 3, { label: 'three decrypt failures' });
    expect(phone.connection.getState().status).toBe('connected'); // NEVER a fake disconnect
    expect(phone.connection.getState().needsPairingCheck).toBe(true); // honest banner instead

    // The channel still works.
    const sessionId = await createReadySession(world, facade, phone, machine);
    expect(phone.machines.getState().session(machine, sessionId)).toBeDefined();
  });

  // --- CDX-062: custom provider profiles, production phone ⇄ real bridge ---

  describe('custom provider profiles (CDX-062)', () => {
    const KIMI_TOKEN = 'sk-kimi-PHONECORE-SECRET-99';
    const KIMI_PROFILE = {
      label: 'Kimi K3',
      baseUrl: 'https://api.moonshot.ai/anthropic',
      models: [{ id: 'kimi-k3', label: 'Kimi K3' }],
      defaultModel: 'kimi-k3',
    };

    /** Seed the bridge KV the way "an earlier run" would have stored a profile
     *  (same shape BridgeCore persists under its 'providerProfiles' key). */
    function seedKimiProfile(world: World): void {
      world.storage.set(
        'providerProfiles',
        JSON.stringify({ profiles: [{ id: 'kimi', ...KIMI_PROFILE, authToken: KIMI_TOKEN }] }),
      );
    }

    it('setProviderProfile → ack(tokenValid via injected fetch) → redacted list in the store; the token NEVER reaches the phone', async () => {
      const world = await makeWorld();
      const facade = new FakeSdkFacade();
      const fetched: Array<{ url: string; init?: RequestInit }> = [];
      const core = await world.startBridge(facade, {
        fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
          fetched.push({ url: String(url), init });
          return new Response('{}', { status: 200 });
        }) as typeof fetch,
      });

      // A phone whose transport RECORDS every relay event so the redaction
      // rule can be asserted on the actual received payloads, not just on
      // store contents.
      const received: NostrEvent[] = [];
      const base = inMemoryTransport(world.relay);
      const phone = await createPhoneCore({
        kv: memoryKV(),
        transport: {
          subscribe: (filter, params) =>
            base.subscribe(filter, {
              ...params,
              onEvent: (event) => {
                received.push(event);
                params.onEvent(event);
              },
            }),
          publish: base.publish,
        },
        timers: new ManualTimers(),
        random: () => 0,
      });
      phones.push(phone);
      phone.start();
      const machine = await pairPhone(world, core, phone);
      await until(() => phone.machines.getState().machine(machine) !== undefined, { label: 'greeting heartbeat' });
      // The bridge advertises the cap the phone gates all provider sends on.
      expect(phone.machines.getState().machine(machine)!.capabilities).toContain('custom-providers');

      await phone.api.setProviderProfile(machine, 'kimi', {
        ...KIMI_PROFILE,
        authToken: KIMI_TOKEN,
      });
      await until(
        () => phone.ui.getState().providerProfileStatus[machine]?.state === 'saved',
        { label: 'provider-profile-ack applied' },
      );
      expect(phone.ui.getState().providerProfileStatus[machine]).toMatchObject({
        profileId: 'kimi',
        tokenValid: true,
      });
      // Validation ran against the injected fetch — the profile's OWN endpoint
      // with a Bearer header, never the real network.
      expect(fetched[0]!.url).toBe('https://api.moonshot.ai/anthropic/v1/messages');
      expect((fetched[0]!.init?.headers as Record<string, string>)['Authorization'])
        .toBe(`Bearer ${KIMI_TOKEN}`);

      // The redacted broadcast landed in the machines store: hasToken, no token.
      await until(
        () => phone.machines.getState().machine(machine)?.providerProfiles?.length === 1,
        { label: 'redacted provider-profiles in the store' },
      );
      expect(phone.machines.getState().machine(machine)!.providerProfiles![0]).toEqual({
        id: 'kimi',
        ...KIMI_PROFILE,
        hasToken: true,
      });

      // The token appears NOWHERE in what the phone received: decrypt every
      // bridge-authored event the phone's subscription delivered and scan the
      // actual plaintext payloads.
      const secretKey = phone.identity.getState().keypair.secretKey;
      const plaintexts = received
        .filter((event) => event.pubkey === world.bridgeKeys.pubkeyHex)
        .map((event) => {
          try {
            return decryptFrom(secretKey, event.pubkey, event.content);
          } catch {
            return ''; // not addressed to us (e.g. pairing-window traffic)
          }
        });
      expect(plaintexts.join('\n')).toContain('kimi'); // sanity: we DID decode provider traffic
      expect(plaintexts.join('\n')).not.toContain(KIMI_TOKEN);
      // …and none of it lingers in any phone store either.
      expect(JSON.stringify(phone.machines.getState().machines)).not.toContain(KIMI_TOKEN);
      expect(JSON.stringify(phone.ui.getState().providerProfileStatus)).not.toContain(KIMI_TOKEN);
      expect(phone.api.diagnostics.decodeFailures).toBe(0);
    });

    it('requestProviderProfiles → provider-profiles → machines store (profile stored by an earlier run)', async () => {
      const world = await makeWorld();
      seedKimiProfile(world);
      const facade = new FakeSdkFacade();
      const core = await world.startBridge(facade);
      const phone = await makePhone(world);
      phone.start();
      const machine = await pairPhone(world, core, phone);
      await until(() => phone.machines.getState().machine(machine) !== undefined, { label: 'greeting heartbeat' });
      expect(phone.machines.getState().machine(machine)!.providerProfiles).toBeUndefined();

      await phone.api.requestProviderProfiles(machine);
      await until(
        () => phone.machines.getState().machine(machine)?.providerProfiles !== undefined,
        { label: 'provider-profiles answer in the store' },
      );
      expect(phone.machines.getState().machine(machine)!.providerProfiles).toEqual([
        { id: 'kimi', ...KIMI_PROFILE, hasToken: true },
      ]);
    });

    it('createSession(providerId) spawns with the D4 provider env: BASE_URL + AUTH_TOKEN, no API_KEY, fallbackModel null', async () => {
      const world = await makeWorld();
      seedKimiProfile(world);
      const facade = new FakeSdkFacade();
      const core = await world.startBridge(facade);
      const phone = await makePhone(world);
      phone.start();
      const machine = await pairPhone(world, core, phone);
      await until(() => phone.machines.getState().machine(machine) !== undefined, { label: 'greeting heartbeat' });

      void phone.api.createSession(machine, { providerId: 'kimi' });
      await until(() => facade.sessions.size === 1, { label: 'SDK session spawned' });
      const sessionId = [...facade.sessions.keys()][0]!;
      const opts = facade.session(sessionId).options;
      expect(opts.model).toBe('kimi-k3'); // profile.defaultModel — no model sent
      expect(opts.fallbackModel).toBeNull();
      expect(opts.env?.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
      expect(opts.env?.ANTHROPIC_AUTH_TOKEN).toBe(KIMI_TOKEN);
      expect(opts.env?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(opts.env?.ANTHROPIC_SMALL_FAST_MODEL).toBe('kimi-k3');

      // The session becomes fully visible on the phone, provider-labeled.
      facade.emit(sessionId, initMsg(`sdk-${sessionId}`));
      await until(
        () => phone.machines.getState().session(machine, sessionId) !== undefined,
        { label: 'session visible on the phone' },
      );
      expect(phone.machines.getState().session(machine, sessionId)!.info).toMatchObject({
        providerId: 'kimi',
        providerLabel: 'Kimi K3',
      });
    });

    it('deleted profile + create(providerId): session-pending then session-failed reach the phone — the D3 loud-failure card, never a silent Anthropic session', async () => {
      const world = await makeWorld();
      seedKimiProfile(world);
      const facade = new FakeSdkFacade();
      const core = await world.startBridge(facade);
      const phone = await makePhone(world);
      phone.start();
      const machine = await pairPhone(world, core, phone);
      await until(() => phone.machines.getState().machine(machine) !== undefined, { label: 'greeting heartbeat' });

      // Delete the profile over the wire (profile: null) and see the empty
      // redacted broadcast land.
      await phone.api.setProviderProfile(machine, 'kimi', null);
      await until(
        () => phone.machines.getState().machine(machine)?.providerProfiles?.length === 0,
        { label: 'empty redacted list after delete' },
      );

      // A create bound to the dead id — exactly what a modal still holding the
      // stale selection sends — fails LOUDLY through the two-phase contract.
      void phone.api.createSession(machine, { providerId: 'kimi' });
      await until(
        () => phone.pendingSessions.getState().pendingFor(machine).some((p) => p.state === 'failed'),
        { label: 'failed pending card on the phone' },
      );
      const failed = phone.pendingSessions.getState().pendingFor(machine)
        .find((p) => p.state === 'failed')!;
      expect(failed.reason).toMatch(/Unknown provider profile 'kimi'/);
      // machine (the pubkey) is only set when the session-pending message was
      // applied FIRST — proving the phone observed pending → failed, not a
      // bare failure.
      expect(failed.machine).toBe(machine);
      expect(facade.sessions.size).toBe(0); // nothing ever spawned
    });
  });

  it('CDX-013: a pairing CANDIDATE cannot self-register as a machine via a session list before the ack', async () => {
    const world = await makeWorld();
    const phone = await makePhone(world);
    phone.start();
    await until(() => phone.connection.getState().status === 'connected', { label: 'FSM connected' });

    // The user pasted an attacker link: the candidate passes the ingest gate
    // (its pair-ack must be able to arrive) — but ONLY the pair-ack path may
    // register a machine.
    const attacker = generateKeypair();
    phone.pairing.getState().beginManualPair(attacker.npub, 'attacker-token', 'P');

    // The attacker skips the ack entirely and publishes a session list.
    world.relay.publish(finalizeEvent(
      {
        kind: RESPONSE_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', phone.identity.getState().pubkeyHex]],
        content: encryptTo(
          attacker.secretKey,
          phone.identity.getState().pubkeyHex,
          encodeBridgeToPhone({
            type: 'sessions',
            machine: 'evil-machine',
            sessions: [],
            protocolVersion: PROTOCOL_VERSION,
          }),
        ),
      },
      attacker.secretKey,
    ) as unknown as RelayEvent);

    // In-memory relay delivery is synchronous; give any stray microtasks a beat.
    await new Promise((r) => setTimeout(r, 20));
    expect(phone.machines.getState().machine(attacker.pubkeyHex)).toBeUndefined();
    expect(phone.pairing.getState().phase).toBe('awaiting-ack'); // flow untouched
  });
});
