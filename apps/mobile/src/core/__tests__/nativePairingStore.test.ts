/**
 * nativePairingStore — proves the adapter presents the SAME
 * `PairingStoreState` shape `createPairingStore` does: URL reconstruction
 * for `beginPair`/`stagePair` (the Rust intent needs the raw URL, the
 * caller only has parsed parts), the staged-URL cache (the Rust view only
 * reports a boolean), the sync npub/token format pre-check on
 * `beginManualPair`, and view refresh on the pairing slice's
 * `stateChanged`.
 */
import { describe, it, expect, vi } from 'vitest';
import { createNativePairingStore } from '../stores/nativePairing';
import { generateKeypair } from '../crypto';
import type { ParsedPairingUrl } from '../stores/pairing';
import type { CoreEvent, Intent, PairingView, SliceId } from '../nativeCoreTypes';
import type { NativeCore } from '../../platform/nativeCore';

// A real, bech32-valid npub — `beginManualPair`'s format check runs the actual
// `nip19.decode`, same as production, so a hand-typed placeholder string
// would fail validation before ever reaching the assertions below.
const bridge = generateKeypair();

function fakeCore(initialView: PairingView = { phase: 'idle', error: null, timedOut: false, hasStaged: false, candidate: null }) {
  let view: PairingView | null = initialView;
  const dispatched: Intent[] = [];
  let coreEventListener: ((e: CoreEvent) => void) | null = null;

  const core: NativeCore = {
    init: () => Promise.reject(new Error('unused')),
    start: () => Promise.reject(new Error('unused')),
    stop: () => Promise.reject(new Error('unused')),
    pause: () => Promise.reject(new Error('unused')),
    resume: () => Promise.reject(new Error('unused')),
    setOnline: () => Promise.reject(new Error('unused')),
    setMachines: () => Promise.reject(new Error('unused')),
    setRelays: () => Promise.reject(new Error('unused')),
    connectionStatus: () => Promise.reject(new Error('unused')),
    onConnection: () => Promise.reject(new Error('unused')),
    onActionFailed: () => Promise.reject(new Error('unused')),
    onResume: () => Promise.resolve(() => {}),

    dispatch: vi.fn(async (intent: Intent) => {
      dispatched.push(intent);
    }),
    machinesView: () => Promise.reject(new Error('unused')),
    settingsView: () => Promise.reject(new Error('unused')),
    outboxView: () => Promise.reject(new Error('unused')),
    pairingView: vi.fn(async () => view),
    dmView: () => Promise.reject(new Error('unused')),
    marmotView: () => Promise.reject(new Error('unused')),
    quickPromptsView: () => Promise.reject(new Error('unused')),
    pendingSessionsView: () => Promise.reject(new Error('unused')),
    uiView: () => Promise.reject(new Error('unused')),
    transcriptView: () => Promise.reject(new Error('unused')),
    onCoreEvent: vi.fn(async (cb: (e: CoreEvent) => void) => {
      coreEventListener = cb;
      return () => {
        coreEventListener = null;
      };
    }),
  };

  return {
    core,
    dispatched,
    setView: (next: PairingView | null) => {
      view = next;
    },
    emitStateChanged: (slice: SliceId) => {
      coreEventListener?.({ stateChanged: { slice } });
    },
  };
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const urlParts: ParsedPairingUrl = {
  npub: bridge.npub,
  pubkeyHex: bridge.pubkeyHex,
  relays: ['wss://r1.example', 'wss://r2.example'],
  machine: 'laptop one',
  token: 'tok=en',
};

describe('createNativePairingStore', () => {
  it('hydrates from pairingView() on creation', async () => {
    const { core } = fakeCore({
      phase: 'awaiting-ack',
      error: null,
      timedOut: false,
      hasStaged: false,
      candidate: { pubkeyHex: 'bb'.repeat(32), npub: 'npub1x', machine: 'laptop', relays: ['wss://r'] },
    });
    const store = createNativePairingStore({ core });
    await tick();

    expect(store.getState().phase).toBe('awaiting-ack');
    expect(store.getState().candidate).toEqual({
      pubkeyHex: 'bb'.repeat(32),
      npub: 'npub1x',
      machine: 'laptop',
      relays: ['wss://r'],
      token: '',
    });
  });

  it('beginPair reconstructs the codedeck://pair URL from the parsed parts', async () => {
    const { core, dispatched } = fakeCore();
    const store = createNativePairingStore({ core });
    await tick();

    store.getState().beginPair(urlParts, 'My Phone');

    expect(dispatched).toHaveLength(1);
    const intent = dispatched[0] as { beginPairing: { url: string; label: string } };
    expect(intent.beginPairing.label).toBe('My Phone');
    expect(intent.beginPairing.url).toBe(
      `codedeck://pair?npub=${bridge.npub}` +
        '&relays=wss%3A%2F%2Fr1.example,wss%3A%2F%2Fr2.example&machine=laptop%20one&token=tok%3Den',
    );
  });

  it('beginPair includes mesh params only when both netid and meshAdmin are present', async () => {
    const { core, dispatched } = fakeCore();
    const store = createNativePairingStore({ core });
    await tick();

    store.getState().beginPair({ ...urlParts, netid: 'net1', meshAdmin: 'npub1admin' }, 'label');
    const intent = dispatched[0] as { beginPairing: { url: string } };
    expect(intent.beginPairing.url).toContain('&netid=net1&meshadmin=npub1admin');
  });

  it('stagePair caches the parsed parts and dispatches stagePairing with the rebuilt URL', async () => {
    const { core, dispatched } = fakeCore();
    const store = createNativePairingStore({ core });
    await tick();

    store.getState().stagePair(urlParts);
    expect(store.getState().staged).toEqual(urlParts);
    expect(dispatched).toEqual([{ stagePairing: { url: expect.stringContaining('codedeck://pair') } }]);
  });

  it('the cached staged URL survives a stateChanged refresh while hasStaged stays true', async () => {
    const { core, setView, emitStateChanged } = fakeCore();
    const store = createNativePairingStore({ core });
    await tick();

    store.getState().stagePair(urlParts);
    setView({ phase: 'idle', error: null, timedOut: false, hasStaged: true, candidate: null });
    emitStateChanged('pairing');
    await tick();

    expect(store.getState().staged).toEqual(urlParts);
  });

  it('the cached staged URL is dropped once the view reports hasStaged: false', async () => {
    const { core, setView, emitStateChanged } = fakeCore();
    const store = createNativePairingStore({ core });
    await tick();

    store.getState().stagePair(urlParts);
    setView({ phase: 'idle', error: null, timedOut: false, hasStaged: false, candidate: null });
    emitStateChanged('pairing');
    await tick();

    expect(store.getState().staged).toBeNull();
  });

  it('dismissStaged clears the cache immediately and dispatches the bare intent', async () => {
    const { core, dispatched } = fakeCore();
    const store = createNativePairingStore({ core });
    await tick();

    store.getState().stagePair(urlParts);
    store.getState().dismissStaged();
    expect(store.getState().staged).toBeNull();
    expect(dispatched.at(-1)).toBe('dismissStagedPairing');
  });

  it('confirmStaged clears the cache immediately and dispatches confirmStagedPairing with the label', async () => {
    const { core, dispatched } = fakeCore();
    const store = createNativePairingStore({ core });
    await tick();

    store.getState().stagePair(urlParts);
    store.getState().confirmStaged('My Phone');
    expect(store.getState().staged).toBeNull();
    expect(dispatched.at(-1)).toEqual({ confirmStagedPairing: { label: 'My Phone' } });
  });

  it('beginManualPair rejects a malformed npub/empty token before dispatching', async () => {
    const { core, dispatched } = fakeCore();
    const store = createNativePairingStore({ core });
    await tick();

    expect(store.getState().beginManualPair('not-an-npub', 'tok', 'l')).toEqual({
      ok: false,
      error: 'invalid npub',
    });
    expect(
      store.getState().beginManualPair(urlParts.npub, '   ', 'l'),
    ).toEqual({ ok: false, error: 'missing token' });
    expect(dispatched).toEqual([]);
  });

  it('beginManualPair dispatches beginManualPairing on valid input', async () => {
    const { core, dispatched } = fakeCore();
    const store = createNativePairingStore({ core });
    await tick();

    const result = store.getState().beginManualPair(` ${urlParts.npub} `, ' tok ', 'label');
    expect(result).toEqual({ ok: true });
    expect(dispatched).toEqual([
      { beginManualPairing: { npub: urlParts.npub, token: 'tok', label: 'label' } },
    ]);
  });

  it('reset clears the staged cache immediately and dispatches resetPairing', async () => {
    const { core, dispatched } = fakeCore();
    const store = createNativePairingStore({ core });
    await tick();

    store.getState().stagePair(urlParts);
    store.getState().reset();
    expect(store.getState().staged).toBeNull();
    expect(dispatched.at(-1)).toBe('resetPairing');
  });

  it('a stateChanged for a different slice does not trigger a refresh', async () => {
    const { core, setView, emitStateChanged } = fakeCore();
    const store = createNativePairingStore({ core });
    await tick();

    setView({ phase: 'paired', error: null, timedOut: false, hasStaged: false, candidate: null });
    emitStateChanged('machines');
    await tick();

    expect(store.getState().phase).toBe('idle');
  });
});
