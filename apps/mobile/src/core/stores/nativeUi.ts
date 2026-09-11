/**
 * A native-backed `UiStore` (migration F2b) — same family as the other
 * native adapters: exposes the SAME `UiStoreState` shape `createUiStore`
 * (`./ui.ts`) does, backed by a cached `NativeCore.uiView()` refreshed on
 * the `ui` slice's `stateChanged` event.
 *
 * `UiView` mirrors `client-core`'s `UiState` verbatim — it is NOT the plan
 * §2.1 `CardsView` (a different, larger, per-session projection of actual
 * card CONTENT that lands with the transcript-view work). `UiState` only
 * ever held the optimistic bookkeeping around cards, all of it flat and
 * already fully ported, so it gets a thin view now rather than waiting on
 * that bigger design.
 *
 * Most mutators are no-ops, for two different reasons:
 * - `selectMachine`, `markSessionUnread`, `clearSessionUnread`,
 *   `markCardResponded`, `applyCredentialsAck`, `applyDeviceConfigAck`,
 *   `applyProviderProfileAck`, and `setUndoToast` are ALREADY applied
 *   Rust-side as a side effect of some other Intent or bridge message
 *   (`Intent::RespondPermission` marks a card responded; `SessionReady`/
 *   heartbeats and the ack messages update unread/ack state via the
 *   `Router`; `Intent::DeleteSession`/`UndoDelete` own the undo toast).
 *   Every one of those paths already sets `ui_changed`, so the next refresh
 *   picks this adapter's cache up automatically — calling these directly is
 *   only ever redundant, never necessary. `selectMachine`'s own single call
 *   site (`createPhoneCore.ts`'s `removeMachine` cleanup) is itself
 *   superseded in native mode.
 * - `noteCredentialsSent`/`noteDeviceConfigSent`/`noteProviderProfileSent`
 *   have no Rust Intent to reach at all yet: sending a set-credentials /
 *   set-device-config / set-provider-profile command has not been ported
 *   (only receiving its ack has). The "saving…" optimistic state these
 *   normally show will not appear natively until that command-send surface
 *   exists — a real, currently-open gap, not an oversight to paper over
 *   with invented Rust surface here.
 *
 * `selectSession`/`selectDmPeer`/`selectMarmotGroup`/`setPlanApprovalChoice`
 * are the genuinely user-facing mutations and dispatch real Intents,
 * optimistically updating the local cache first the same way
 * `nativePairing.ts`'s `confirmStaged`/`reset` do.
 */
import { createStore } from 'zustand/vanilla';
import { sessionKeyOf } from './ui';
import type { NativeCore } from '../../platform/nativeCore';
import type { UiView as NativeUiView } from '../nativeCoreTypes';
import type { UiStore, UiStoreState } from './ui';

function toSetRecord(record: Record<string, string[]>): Record<string, ReadonlySet<string>> {
  const out: Record<string, ReadonlySet<string>> = {};
  for (const [key, values] of Object.entries(record)) out[key] = new Set(values);
  return out;
}

function applyView(view: NativeUiView): Partial<UiStoreState> {
  return {
    selectedMachine: view.selectedMachine,
    selectedSession: view.selectedSession,
    panelMode: view.panelMode,
    activeDmPeer: view.activeDmPeer,
    activeMarmotGroup: view.activeMarmotGroup,
    unreadSessions: new Set(view.unreadSessions),
    respondedCards: toSetRecord(view.respondedCards),
    planApprovalChoices: view.planApprovalChoices,
    credentialsStatus: view.credentialsStatus,
    deviceConfigStatus: view.deviceConfigStatus,
    providerProfileStatus: view.providerProfileStatus,
    undoToast: view.undoToast,
  };
}

export interface NativeUiStoreDeps {
  core: NativeCore;
  log?(msg: string): void;
}

export function createNativeUiStore(deps: NativeUiStoreDeps): UiStore {
  const store = createStore<UiStoreState>()((set, get) => {
    const refresh = async (): Promise<void> => {
      try {
        const view = await deps.core.uiView();
        set(applyView(view));
      } catch (err) {
        deps.log?.(`[nativeUi] view refresh failed: ${err}`);
      }
    };

    void deps.core
      .onCoreEvent((event) => {
        if (typeof event === 'object' && 'stateChanged' in event && event.stateChanged.slice === 'ui') {
          void refresh();
        }
      })
      .catch((err) => deps.log?.(`[nativeUi] onCoreEvent failed: ${err}`));
    void refresh();

    const dispatch = (intent: Parameters<NativeCore['dispatch']>[0]): void => {
      deps.core.dispatch(intent).catch((err) => deps.log?.(`[nativeUi] dispatch failed: ${err}`));
    };

    const noop = (): void => {};

    return {
      selectedMachine: null,
      selectedSession: null,
      panelMode: 'session',
      activeDmPeer: null,
      activeMarmotGroup: null,
      unreadSessions: new Set<string>(),
      respondedCards: {},
      planApprovalChoices: {},
      credentialsStatus: {},
      deviceConfigStatus: {},
      providerProfileStatus: {},
      undoToast: null,

      selectMachine: noop,

      selectSession: (machinePubkey, sessionId) => {
        set({ selectedMachine: machinePubkey, selectedSession: sessionId, panelMode: 'session' });
        dispatch({ selectSession: { machine: machinePubkey, sessionId } });
      },
      selectDmPeer: (peerPubkey) => {
        set({ activeDmPeer: peerPubkey, panelMode: 'dm' });
        dispatch({ selectDmPeer: { peer: peerPubkey } });
      },
      selectMarmotGroup: (groupId) => {
        set({ activeMarmotGroup: groupId, panelMode: 'marmot' });
        dispatch({ selectMarmotGroup: { groupId } });
      },

      markSessionUnread: noop,
      clearSessionUnread: noop,
      isSessionUnread: (machine, sessionId) =>
        get().unreadSessions.has(sessionKeyOf(machine, sessionId)),

      markCardResponded: noop,
      isCardResponded: (machine, sessionId, cardId) =>
        get().respondedCards[sessionKeyOf(machine, sessionId)]?.has(cardId) ?? false,
      setPlanApprovalChoice: (cardId, key) => {
        set({ planApprovalChoices: { ...get().planApprovalChoices, [cardId]: key } });
        dispatch({ setPlanApprovalChoice: { cardId, key } });
      },

      noteCredentialsSent: noop,
      applyCredentialsAck: noop,
      noteDeviceConfigSent: noop,
      applyDeviceConfigAck: noop,
      noteProviderProfileSent: noop,
      applyProviderProfileAck: noop,

      setUndoToast: noop,
    };
  });

  return store;
}
