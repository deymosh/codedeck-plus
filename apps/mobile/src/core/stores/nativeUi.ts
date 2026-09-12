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
 * `markCardResponded` is a no-op: `Intent::RespondPermission` already marks
 * the card responded Rust-side and sets `ui_changed`, so the next refresh
 * picks this up on its own — the call site's own local mark just avoids a
 * one-frame flicker back to "unresponded" while that refresh is in flight.
 *
 * `noteCredentialsSent`/`noteDeviceConfigSent`/`noteProviderProfileSent` are
 * no-ops for a different reason: they have no Rust Intent to reach at all
 * yet — sending a set-credentials / set-device-config / set-provider-profile
 * command has not been ported (only receiving its ack has, which the next
 * view refresh already reflects). The "saving…" optimistic state these
 * normally show will not appear natively until that command-send surface
 * exists — a real, currently-open gap, not an oversight to paper over with
 * invented Rust surface here.
 *
 * `selectSession`/`selectDmPeer`/`selectMarmotGroup`/`setPlanApprovalChoice`
 * are the genuinely user-facing mutations and dispatch real Intents,
 * optimistically updating the local cache first the same way
 * `nativePairing.ts`'s `confirmStaged`/`reset` do.
 */
import { createStore } from 'zustand/vanilla';
import { hydrateFromCore } from './nativeHydration';
import { sessionKeyOf } from './ui';
import type { NativeCore } from '../../platform/nativeCore';
import type { UiView as NativeUiView } from '../nativeCoreTypes';
import type { CredentialsAckState, DeviceConfigAckState, ProviderProfileAckState, UiStore, UiStoreState } from './ui';

function toSetRecord(record: Record<string, string[]>): Record<string, ReadonlySet<string>> {
  const out: Record<string, ReadonlySet<string>> = {};
  for (const [key, values] of Object.entries(record)) out[key] = new Set(values);
  return out;
}

/** Ack-status maps carry several skip_serializing_if fields — specta types
 *  them conservatively as `T | null`, but they're only ever actually
 *  omitted on the wire; `./ui.ts`'s shapes predate that and spell "no
 *  value" as `undefined` only. The cast at the return is the one place that
 *  trusts this: the loop body genuinely never leaves a `null` in the
 *  result, it just isn't a shape TS can infer field-by-field generically. */
function nullsToUndefinedRecord<U extends object>(record: Record<string, object>): Record<string, U> {
  const out: Record<string, U> = {};
  for (const [key, value] of Object.entries(record)) {
    const clean = {} as U;
    for (const [k, v] of Object.entries(value)) (clean as Record<string, unknown>)[k] = v === null ? undefined : v;
    out[key] = clean;
  }
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
    credentialsStatus: nullsToUndefinedRecord<CredentialsAckState>(view.credentialsStatus),
    deviceConfigStatus: nullsToUndefinedRecord<DeviceConfigAckState>(view.deviceConfigStatus),
    providerProfileStatus: nullsToUndefinedRecord<ProviderProfileAckState>(view.providerProfileStatus),
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
      const view = await deps.core.uiView();
      set(applyView(view));
    };

    void hydrateFromCore(
      () =>
        deps.core.onCoreEvent((event) => {
          if (typeof event === 'object' && event.stateChanged?.slice === 'ui') {
            void refresh().catch((err) => deps.log?.(`[nativeUi] view refresh failed: ${err}`));
          }
        }),
      refresh,
      deps.core.onResume,
      'nativeUi',
      deps.log,
    );

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
      noteDeviceConfigSent: noop,
      noteProviderProfileSent: noop,
    };
  });

  return store;
}
