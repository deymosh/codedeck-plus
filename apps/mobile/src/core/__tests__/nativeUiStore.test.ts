/**
 * nativeUiStore — proves the adapter presents the SAME `UiStoreState` shape
 * `createUiStore` does: hydration from `uiView()` (including the array→Set
 * conversions), refresh on the `ui` slice's `stateChanged`, the four
 * genuinely user-facing mutators' dispatched `Intent`s + optimistic local
 * update, and every other mutator being an inert no-op.
 */
import { describe, it, expect, vi } from 'vitest';
import { createNativeUiStore } from '../stores/nativeUi';
import type { CoreEvent, Intent, SliceId, UiView } from '../nativeCoreTypes';
import type { NativeCore } from '../../platform/nativeCore';

const emptyView = (): UiView => ({
  selectedMachine: null,
  selectedSession: null,
  panelMode: 'session',
  activeDmPeer: null,
  activeMarmotGroup: null,
  unreadSessions: [],
  respondedCards: {},
  planApprovalChoices: {},
  credentialsStatus: {},
  deviceConfigStatus: {},
  providerProfileStatus: {},
  undoToast: null,
});

function fakeCore(initialView: UiView = emptyView()) {
  let view: UiView = initialView;
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
    send: () => Promise.reject(new Error('unused')),
    publish: () => Promise.reject(new Error('unused')),
    connectionStatus: () => Promise.reject(new Error('unused')),
    onMessage: () => Promise.reject(new Error('unused')),
    onConnection: () => Promise.reject(new Error('unused')),
    onActionFailed: () => Promise.reject(new Error('unused')),
    onResume: () => Promise.resolve(() => {}),

    dispatch: vi.fn(async (intent: Intent) => {
      dispatched.push(intent);
    }),
    machinesView: () => Promise.reject(new Error('unused')),
    settingsView: () => Promise.reject(new Error('unused')),
    outboxView: () => Promise.reject(new Error('unused')),
    pairingView: () => Promise.reject(new Error('unused')),
    dmView: () => Promise.reject(new Error('unused')),
    marmotView: () => Promise.reject(new Error('unused')),
    quickPromptsView: () => Promise.reject(new Error('unused')),
    pendingSessionsView: () => Promise.reject(new Error('unused')),
    uiView: vi.fn(async () => view),
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
    setView: (next: UiView) => {
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

describe('createNativeUiStore', () => {
  it('hydrates from uiView() on creation, converting arrays to Sets', async () => {
    const { core } = fakeCore({
      ...emptyView(),
      selectedMachine: 'm1',
      selectedSession: 's1',
      unreadSessions: ['m1 s1', 'm2 s2'],
      respondedCards: { 'm1 s1': ['card1', 'card2'] },
      planApprovalChoices: { card3: '2' },
      undoToast: { machine: 'm1', sessionId: 's1', label: 'Session' },
    });
    const store = createNativeUiStore({ core });
    await tick();

    const state = store.getState();
    expect(state.selectedMachine).toBe('m1');
    expect(state.unreadSessions).toEqual(new Set(['m1 s1', 'm2 s2']));
    expect(state.respondedCards['m1 s1']).toEqual(new Set(['card1', 'card2']));
    expect(state.planApprovalChoices.card3).toBe('2');
    expect(state.undoToast).toEqual({ machine: 'm1', sessionId: 's1', label: 'Session' });
    expect(state.isSessionUnread('m1', 's1')).toBe(true);
    expect(state.isSessionUnread('m3', 's3')).toBe(false);
    expect(state.isCardResponded('m1', 's1', 'card1')).toBe(true);
    expect(state.isCardResponded('m1', 's1', 'card-other')).toBe(false);
  });

  it('selectSession sets state optimistically and dispatches selectSession', async () => {
    const { core, dispatched } = fakeCore();
    const store = createNativeUiStore({ core });
    await tick();

    store.getState().selectSession('m1', 's1');
    expect(store.getState().selectedMachine).toBe('m1');
    expect(store.getState().selectedSession).toBe('s1');
    expect(store.getState().panelMode).toBe('session');
    expect(dispatched).toEqual([{ selectSession: { machine: 'm1', sessionId: 's1' } }]);
  });

  it('selectDmPeer sets state optimistically and dispatches selectDmPeer', async () => {
    const { core, dispatched } = fakeCore();
    const store = createNativeUiStore({ core });
    await tick();

    store.getState().selectDmPeer('peer1');
    expect(store.getState().activeDmPeer).toBe('peer1');
    expect(store.getState().panelMode).toBe('dm');
    expect(dispatched).toEqual([{ selectDmPeer: { peer: 'peer1' } }]);
  });

  it('selectMarmotGroup sets state optimistically and dispatches selectMarmotGroup', async () => {
    const { core, dispatched } = fakeCore();
    const store = createNativeUiStore({ core });
    await tick();

    store.getState().selectMarmotGroup('g1');
    expect(store.getState().activeMarmotGroup).toBe('g1');
    expect(store.getState().panelMode).toBe('marmot');
    expect(dispatched).toEqual([{ selectMarmotGroup: { groupId: 'g1' } }]);
  });

  it('setPlanApprovalChoice sets state optimistically and dispatches setPlanApprovalChoice', async () => {
    const { core, dispatched } = fakeCore();
    const store = createNativeUiStore({ core });
    await tick();

    store.getState().setPlanApprovalChoice('card1', '2');
    expect(store.getState().planApprovalChoices.card1).toBe('2');
    expect(dispatched).toEqual([{ setPlanApprovalChoice: { cardId: 'card1', key: '2' } }]);
  });

  it('every other mutator is an inert no-op', async () => {
    const { core, dispatched } = fakeCore();
    const store = createNativeUiStore({ core });
    await tick();

    const s = store.getState();
    s.selectMachine('m1');
    s.markSessionUnread('m1', 's1');
    s.clearSessionUnread('m1', 's1');
    s.markCardResponded('m1', 's1', 'card1');
    s.noteCredentialsSent('m1');
    s.applyCredentialsAck('m1', { success: true, hasAnthropicKey: true, hasGithubPat: false });
    s.noteDeviceConfigSent('m1');
    s.applyDeviceConfigAck('m1', { success: true });
    s.noteProviderProfileSent('m1', 'p1');
    s.applyProviderProfileAck('m1', { profileId: 'p1', success: true });
    s.setUndoToast({ machine: 'm1', sessionId: 's1', label: 'x' });

    expect(dispatched).toEqual([]);
    expect(store.getState().selectedMachine).toBeNull();
    expect(store.getState().undoToast).toBeNull();
  });

  it('a stateChanged("ui") core event re-fetches the view', async () => {
    const { core, setView, emitStateChanged } = fakeCore();
    const store = createNativeUiStore({ core });
    await tick();

    setView({ ...emptyView(), selectedMachine: 'm2' });
    emitStateChanged('ui');
    await tick();

    expect(store.getState().selectedMachine).toBe('m2');
  });

  it('a stateChanged for a different slice does not trigger a refresh', async () => {
    const { core, setView, emitStateChanged } = fakeCore();
    const store = createNativeUiStore({ core });
    await tick();

    setView({ ...emptyView(), selectedMachine: 'm2' });
    emitStateChanged('machines');
    await tick();

    expect(store.getState().selectedMachine).toBeNull();
  });
});
