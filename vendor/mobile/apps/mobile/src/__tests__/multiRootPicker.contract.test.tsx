// @vitest-environment jsdom
/**
 * CDX-031 end-to-end: a bridge started on TWO `--workspace` roots must let the
 * phone start a session in the SECOND root.
 *
 * This settles the unconfirmed device observation of 2026-08-08 — bridge on
 * `gsd-proj` + `plain-proj`, and the NewSessionModal offered only "Default
 * (workspace root)" + "New folder…". It was REAL, and the gap was bridge-side:
 * the heartbeat's `folders` is the union of what lives INSIDE the roots
 * (`listAllWorkspaceFolders` enumerates each root's children), so a root never
 * appears among its own entries and two flat project roots advertise nothing
 * at all. Every downstream link — codec, machines store, modal — was fine and
 * faithfully rendered the empty list it was given.
 *
 * The chain is exercised for real, not stubbed: real BridgeCore over the
 * in-memory relay → real 30515 heartbeat → the production phone core's
 * machines store → the actual NewSessionModal → back down to the SDK session
 * the bridge spawns. The only fakes are the relay and the Claude SDK.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  BridgeCore,
  generateKeypair,
  type BridgeHost,
  type PairingHandle,
  type PairingPayload,
} from '@codedeck/core';
import { FakeSdkFacade, InMemoryRelay, ManualTimers, inMemoryPoolFactory } from '@codedeck/testkit';
import type { RelayEvent, RelayFilter } from '@codedeck/testkit';
import type { NostrEvent } from 'nostr-tools/core';
import { createPhoneCore, memoryKV, parsePairingUrl, type PhoneCore, type PhoneTransport } from '../core';
import { PhoneCoreProvider } from '../ui/coreContext';
import { NewSessionModal } from '../ui/NewSessionModal';

// --- Harness (same shape as phoneCore.contract.test.ts) ---

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

async function until(cond: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`until timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

interface World {
  rootA: string;
  rootB: string;
  core: BridgeCore;
  facade: FakeSdkFacade;
  phone: PhoneCore;
  machine: string;
}

const teardown: Array<() => Promise<void>> = [];

afterEach(async () => {
  cleanup();
  while (teardown.length > 0) await teardown.pop()!();
});

/**
 * A bridge on two workspace roots, paired with a live phone core.
 *
 * The roots mirror the device rig exactly: two PROJECT directories passed
 * straight to `--workspace`, not two containers of projects. `rootA` holds one
 * pickable child so `folders` is non-empty and the assertions below can tell
 * "the roots are missing" apart from "nothing was advertised at all"; `rootB`
 * is flat, the shape that produced the empty picker on the device.
 */
async function makeWorld(): Promise<World> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codedeck-multiroot-'));
  const stateDir = path.join(dir, 'state');
  const rootA = path.join(dir, 'gsd-proj');
  const rootB = path.join(dir, 'plain-proj');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(path.join(rootA, 'projA'), { recursive: true });
  mkdirSync(rootB, { recursive: true });

  const storage = new Map<string, string>();
  const relay = new InMemoryRelay();
  const bridgeKeys = generateKeypair();
  const facade = new FakeSdkFacade();

  const host: BridgeHost = {
    config: {
      machineName: 'multiroot-machine',
      host: 'cli',
      relays: ['wss://in-memory.test'],
      workspaceRoots: [rootA, rootB],
    },
    storage: {
      get: async (k) => storage.get(k),
      set: async (k, v) => { storage.set(k, v); },
      delete: async (k) => { storage.delete(k); },
    },
    sessionStateDir: () => stateDir,
    log: () => {},
    notify: () => {},
    presentPairing: (_payload: PairingPayload): PairingHandle => ({ close: () => {} }),
    onShutdown: () => {},
  };

  const core = await BridgeCore.start({
    host,
    secretKey: bridgeKeys.secretKey,
    facade,
    poolFactory: inMemoryPoolFactory(relay),
    heartbeatIntervalMs: 0,
    syncTimers: new ManualTimers(),
  });

  const phone = await createPhoneCore({
    kv: memoryKV(),
    transport: inMemoryTransport(relay),
    timers: new ManualTimers(),
    random: () => 0,
  });
  phone.start();
  await until(() => phone.connection.getState().status === 'connected', 'FSM connected');

  const info = core.openPairingWindow();
  const parsed = parsePairingUrl(info.url);
  if (!parsed.ok) throw new Error(parsed.error);
  phone.pairing.getState().beginPair(parsed.parts, 'Multiroot Phone');
  await until(() => phone.pairing.getState().phase === 'paired', 'paired');
  const machine = bridgeKeys.pubkeyHex;
  await until(() => phone.machines.getState().machine(machine) !== undefined, 'greeting heartbeat');

  teardown.push(async () => {
    await phone.stop();
    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  });

  return { rootA, rootB, core, facade, phone, machine };
}

describe('two workspace roots → folder picker (CDX-031)', () => {
  it('the heartbeat advertises both roots, and folders alone never could', async () => {
    const { rootA, rootB, phone, machine } = await makeWorld();
    const view = phone.machines.getState().machine(machine)!;

    // The fix: absolute, in --workspace order, all the way to the store.
    expect(view.roots).toEqual([rootA, rootB]);

    // The regression this guards: `folders` lists what is INSIDE the roots. It
    // carries rootA's child and cannot name either root, so a picker built
    // from it alone can never reach root 2 — and with two flat project roots
    // it would have been empty, which is exactly what the device showed.
    expect(view.folders).toEqual(['projA']);
    expect(view.folders).not.toContain(rootB);
    expect(view.folders).not.toContain(path.basename(rootB));
  });

  it('the modal offers the second root, and creating there lands the session in it', async () => {
    const { rootA, rootB, facade, phone, machine } = await makeWorld();

    render(
      <PhoneCoreProvider value={phone}>
        <NewSessionModal machinePubkey={machine} onClose={() => {}} />
      </PhoneCoreProvider>,
    );

    // One radio per root, valued with the absolute path the bridge can match.
    expect((screen.getByDisplayValue(rootA) as HTMLInputElement).type).toBe('radio');
    const secondRoot = screen.getByDisplayValue(rootB) as HTMLInputElement;
    expect(secondRoot.type).toBe('radio');
    // Labelled by basename — the absolute path would ellipsize away on a phone.
    expect(screen.getByText(path.basename(rootB))).toBeTruthy();
    expect(screen.getAllByTestId('root-option')).toHaveLength(2);

    // Pick the SECOND root and create — oracle (a) of the CDX-031 device step.
    fireEvent.click(secondRoot);
    fireEvent.click(screen.getByText('Create'));

    await until(() => facade.sessions.size > 0, 'SDK session spawned');
    const spawned = [...facade.sessions.values()][0]!;
    expect(spawned.options.cwd).toBe(rootB);
    expect(spawned.options.cwd).not.toBe(rootA);
  });

  it('a single-root bridge shows no root rows — Default already is that root', async () => {
    // Guard against the fix adding a redundant duplicate row everywhere: the
    // rows only appear when there is a choice to make.
    const { phone, machine } = await makeWorld();
    phone.machines.getState().applySessionList(
      machine,
      { type: 'sessions', machine: 'multiroot-machine', sessions: [], protocolVersion: 10, roots: ['/only/root'] },
      Date.now(),
    );

    render(
      <PhoneCoreProvider value={phone}>
        <NewSessionModal machinePubkey={machine} onClose={() => {}} />
      </PhoneCoreProvider>,
    );

    expect(screen.queryAllByTestId('root-option')).toHaveLength(0);
    expect(screen.getByText('Default (workspace root)')).toBeTruthy();
  });
});
