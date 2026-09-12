/**
 * A stateful fake `NativeCore` for tests that render real UI against
 * `createPhoneCoreNative`, so every UI test doesn't hand-roll its own
 * scripted mock of the full `NativeCore` interface.
 *
 * Each `*View()` method serves a value out of `views` (seeded via the
 * constructor, mutated via `setView`); `setView` also fires the matching
 * `core://event` `stateChanged` so every adapter subscribed to that slice
 * (all of them poll-on-event, never push) refetches — the same signal
 * `client_runtime::Core` sends after an `Intent` actually changes state.
 * `dispatchMock` is a `vi.fn` a test can `mockResolvedValue`/`mockRejectedValue`
 * to script a specific `Intent`'s outcome; `dispatched` is the plain call log
 * for tests that only care what was sent, not what came back.
 */
import { vi } from 'vitest';
import { createPhoneCoreNative } from '../createPhoneCoreNative';
import { memoryKV } from '../ports';
import type { PhoneCore } from '../phoneCore';
import type {
  CoreEvent,
  DmView,
  Intent,
  MachinesView,
  MarmotView,
  OutboxView,
  PairingView,
  PendingSessionsView,
  QuickPromptsView,
  SettingsView,
  SliceId,
  TranscriptRowsView,
  UiView,
} from '../nativeCoreTypes';
import type {
  NativeActionFailed,
  NativeConnectionSnapshot,
  NativeCore,
  NativeCoreConfig,
} from '../../platform/nativeCore';

export interface FakeNativeCoreViews {
  machines: MachinesView;
  settings: SettingsView | null;
  outbox: OutboxView;
  pairing: PairingView | null;
  dm: DmView | null;
  marmot: MarmotView | null;
  quickPrompts: QuickPromptsView;
  pendingSessions: PendingSessionsView;
  ui: UiView;
}

const SLICE_OF: Record<keyof FakeNativeCoreViews, SliceId> = {
  machines: 'machines',
  settings: 'settings',
  outbox: 'outbox',
  pairing: 'pairing',
  dm: 'dm',
  marmot: 'marmot',
  quickPrompts: 'quickPrompts',
  pendingSessions: 'pendingSessions',
  ui: 'ui',
};

export function defaultNativeCoreViews(): FakeNativeCoreViews {
  return {
    machines: { machines: {} },
    settings: null,
    outbox: { items: [] },
    pairing: null,
    dm: null,
    marmot: null,
    quickPrompts: { prompts: [] },
    pendingSessions: { pending: {} },
    ui: {
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
    },
  };
}

export function emptyTranscriptRowsView(): TranscriptRowsView {
  return {
    rows: [],
    haveRanges: [],
    sync: { state: 'idle', attempts: 0, nextRetryAt: null, localHigh: 0, target: 0, contiguous: true },
  };
}

export interface FakeNativeCore {
  core: NativeCore;
  views: FakeNativeCoreViews;
  dispatched: Intent[];
  dispatchMock: ReturnType<typeof vi.fn>;
  initCalls: NativeCoreConfig[];
  /** Replace one view slice and notify every subscribed adapter, same as a
   *  real `Intent` outcome would. */
  setView<K extends keyof FakeNativeCoreViews>(slice: K, value: FakeNativeCoreViews[K]): void;
  setTranscript(machine: string, sessionId: string, view: TranscriptRowsView): void;
  emitCoreEvent(event: CoreEvent): void;
  emitConnection(snapshot: NativeConnectionSnapshot): void;
  emitActionFailed(kind: NativeActionFailed): void;
  /** Fire every registered `onResume` callback — simulates an Android
   *  resume / desktop focus, the same signal `hydrateFromCore` re-pulls on. */
  emitResume(): void;
  /** Script what a dispatched `Intent` does to the fake's views — the
   *  fixture never guesses this itself (that would be re-implementing
   *  `client_runtime::Core` in TS). Runs on every `dispatch()` call, in
   *  registration order, before it resolves. Returns an unregister fn. */
  onDispatch(handler: (intent: Intent) => void | Promise<void>): () => void;
}

/**
 * `connectionStatus()`/`onConnection` are seeded separately from the
 * `stateChanged`-driven views above: the connection adapter is the one
 * store that never listens for `core://event` at all (see
 * `stores/nativeConnection.ts`'s module doc) — it polls `connectionStatus()`
 * once at construction and otherwise only reacts to `onConnection` pushes.
 */
export function fakeNativeCore(
  overrides: Partial<FakeNativeCoreViews> = {},
  initialConnection: NativeConnectionSnapshot = { status: 'idle', needsPairingCheck: false, connectedRelays: [] },
): FakeNativeCore {
  const views: FakeNativeCoreViews = { ...defaultNativeCoreViews(), ...overrides };
  const dispatched: Intent[] = [];
  const initCalls: NativeCoreConfig[] = [];
  const transcripts = new Map<string, TranscriptRowsView>();

  const coreEventHandlers = new Set<(event: CoreEvent) => void>();
  const connectionHandlers = new Set<(snapshot: NativeConnectionSnapshot) => void>();
  const actionFailedHandlers = new Set<(kind: NativeActionFailed) => void>();
  const resumeHandlers = new Set<() => void>();
  const dispatchHandlers = new Set<(intent: Intent) => void | Promise<void>>();

  const setViewInternal = <K extends keyof FakeNativeCoreViews>(
    slice: K,
    value: FakeNativeCoreViews[K],
  ): void => {
    views[slice] = value;
    for (const cb of coreEventHandlers) cb({ stateChanged: { slice: SLICE_OF[slice] } });
  };

  // Every `select*` Intent has a LOCAL optimistic `set()` on the real native
  // adapter (`nativeUi.ts`/`nativeDm.ts`/`nativeMarmot.ts`) that runs before
  // the dispatch — echoed here into the views themselves so the NEXT refresh
  // (this dispatch's own, or any other) doesn't clobber that optimistic write
  // back to whatever the views said before selection happened. Without this,
  // a test's own `onDispatch` handler touching an unrelated field on the same
  // view (e.g. clearing an unread mark) re-fetches a view that never learned
  // about the selection and stomps it back to its old value.
  const echoSelection = (intent: Intent): void => {
    if (typeof intent !== 'object') return;
    if (intent.selectSession) {
      setViewInternal('ui', {
        ...views.ui,
        selectedMachine: intent.selectSession.machine,
        selectedSession: intent.selectSession.sessionId,
        panelMode: 'session',
      });
    } else if (intent.selectDmPeer) {
      setViewInternal('ui', { ...views.ui, activeDmPeer: intent.selectDmPeer.peer, panelMode: 'dm' });
      if (views.dm) setViewInternal('dm', { ...views.dm, activePeer: intent.selectDmPeer.peer });
    } else if (intent.selectMarmotGroup) {
      setViewInternal('ui', {
        ...views.ui,
        activeMarmotGroup: intent.selectMarmotGroup.groupId,
        panelMode: 'marmot',
      });
      if (views.marmot) setViewInternal('marmot', { ...views.marmot, activeGroup: intent.selectMarmotGroup.groupId });
    }
  };

  // The default implementation just records; a test that needs a dispatched
  // Intent to actually change a view beyond the selection echo above (e.g.
  // deleteSession removing a session and setting the undo toast, the way
  // `client_runtime::Core` really does) registers an `onDispatch` handler
  // rather than this fixture hard-coding any more Rust behaviour.
  // `mockImplementation`/`mockRejectedValue` etc. still work as an escape
  // hatch for a test that wants dispatch itself to fail.
  const dispatchMock = vi.fn(async (intent: Intent) => {
    dispatched.push(intent);
    echoSelection(intent);
    for (const handler of dispatchHandlers) await handler(intent);
  });

  const core: NativeCore = {
    defaults: () =>
      Promise.resolve({
        effortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'],
        permissionModes: ['default', 'acceptEdits', 'plan'],
        defaultRelays: ['wss://relay2.descendant.io', 'wss://relay.primal.net', 'wss://nostr.oxtr.dev'],
        marmotRelays: ['wss://relay.us.whitenoise.chat', 'wss://relay.eu.whitenoise.chat'],
        customProvidersCapability: 'custom-providers',
        providerBaseUrlError:
          'Base URL must be https:// (http:// is allowed only for localhost, 127.0.0.1 or [::1])',
      }),
    init: (config) => {
      initCalls.push(config);
      return Promise.resolve();
    },
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    pause: () => Promise.resolve(),
    resume: () => Promise.resolve(),
    setOnline: () => Promise.resolve(),
    setMachines: () => Promise.resolve(),
    setRelays: () => Promise.resolve(),
    connectionStatus: () => Promise.resolve(initialConnection),
    onConnection: (cb) => {
      connectionHandlers.add(cb);
      return Promise.resolve(() => connectionHandlers.delete(cb));
    },
    onActionFailed: (cb) => {
      actionFailedHandlers.add(cb);
      return Promise.resolve(() => actionFailedHandlers.delete(cb));
    },
    onResume: (cb) => {
      resumeHandlers.add(cb);
      return Promise.resolve(() => resumeHandlers.delete(cb));
    },
    dispatch: (intent) => dispatchMock(intent) as Promise<void>,
    machinesView: () => Promise.resolve(views.machines),
    settingsView: () => Promise.resolve(views.settings),
    outboxView: () => Promise.resolve(views.outbox),
    pairingView: () => Promise.resolve(views.pairing),
    dmView: () => Promise.resolve(views.dm),
    marmotView: () => Promise.resolve(views.marmot),
    quickPromptsView: () => Promise.resolve(views.quickPrompts),
    pendingSessionsView: () => Promise.resolve(views.pendingSessions),
    uiView: () => Promise.resolve(views.ui),
    transcriptView: (machine, sessionId) =>
      Promise.resolve(transcripts.get(`${machine}:${sessionId}`) ?? emptyTranscriptRowsView()),
    onCoreEvent: (cb) => {
      coreEventHandlers.add(cb);
      return Promise.resolve(() => coreEventHandlers.delete(cb));
    },
  };

  return {
    core,
    views,
    dispatched,
    dispatchMock,
    initCalls,
    setView: setViewInternal,
    setTranscript: (machine, sessionId, view) => transcripts.set(`${machine}:${sessionId}`, view),
    emitCoreEvent: (event) => {
      for (const cb of coreEventHandlers) cb(event);
    },
    emitConnection: (snapshot) => {
      for (const cb of connectionHandlers) cb(snapshot);
    },
    emitActionFailed: (kind) => {
      for (const cb of actionFailedHandlers) cb(kind);
    },
    emitResume: () => {
      for (const cb of resumeHandlers) cb();
    },
    onDispatch: (handler) => {
      dispatchHandlers.add(handler);
      return () => dispatchHandlers.delete(handler);
    },
  };
}

/** A handful of microtask turns — enough for every adapter's fire-and-forget
 *  boot refresh (`void refresh()`) and event-driven refetch to settle, even
 *  through an `onDispatch` handler's own chain of awaited promises. */
export async function tick(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

/**
 * Builds a full `PhoneCore` over a fresh `fakeNativeCore()` and waits for
 * boot-time hydration, so a component rendered against the result sees the
 * seeded views immediately instead of an empty first frame.
 */
export async function buildFakePhoneCore(
  overrides: Partial<FakeNativeCoreViews> = {},
  initialConnection?: NativeConnectionSnapshot,
): Promise<{ phone: PhoneCore; fake: FakeNativeCore }> {
  const fake = fakeNativeCore(overrides, initialConnection);
  const phone = await createPhoneCoreNative({ core: fake.core, kv: memoryKV() });
  await tick();
  return { phone, fake };
}
