/**
 * A native-backed `MarmotStore` (migration F2b) — same family as
 * `nativeDm.ts`: exposes the SAME `MarmotStoreState` shape `createMarmotStore`
 * (`./marmot.ts`) does, backed by a cached `NativeCore.marmotView()` refreshed
 * on the marmot slice's `stateChanged` event, with every mutation going
 * through `NativeCore.dispatch`.
 *
 * `start`/`stop`/`ingestGiftWrap`/`ingestGroupMessage` are no-ops: the same
 * reasoning as `nativeDm.ts` — `client-runtime` owns the 445 subscription and
 * the MDK engine seam itself; there is no separate transport lifecycle or
 * raw-event ingest path left in TS to drive.
 *
 * `startChat`/`acceptWelcome` both mark an effect (`Intent::StartMarmotChat`/
 * `AcceptMarmotWelcome`) that the Rust core's own event loop processes
 * asynchronously — fetching a KeyPackage or running the MDK engine, not
 * something `dispatch`'s promise waits for. Neither result is read by
 * production UI beyond "did the promise settle" (both call sites use `void
 * startChat(...)`/`void accept(...).finally(...)`), so this adapter does one
 * best-effort refresh after dispatching and infers an outcome from it — the
 * authoritative state always arrives later via `stateChanged`, regardless of
 * what these return. `startChat` collapses the original's distinct
 * `'no-key-package'`/`'failed'` reasons into `'failed'`: nothing in the
 * current view or `CoreEvent::ActionFailed` surface distinguishes them.
 *
 * `retry` cannot remove the old failed row (no such Intent exists) — like
 * `nativeDm.ts`'s, it re-dispatches with the same content and leaves the
 * next refresh to reflect whatever the Rust store ends up holding.
 */
import { createStore } from 'zustand/vanilla';
import type { NativeCore } from '../../platform/nativeCore';
import type { MarmotView as NativeMarmotView } from '../nativeCoreTypes';
import type {
  MarmotConversation,
  MarmotMessage,
  MarmotStore,
  MarmotStoreState,
  StartMarmotChatResult,
} from './marmot';

function toConversations(view: NativeMarmotView): Record<string, MarmotConversation> {
  const out: Record<string, MarmotConversation> = {};
  for (const c of view.conversations) out[c.groupId] = c;
  return out;
}

export interface NativeMarmotStoreDeps {
  core: NativeCore;
  now?(): number;
  log?(msg: string): void;
}

export function createNativeMarmotStore(deps: NativeMarmotStoreDeps): MarmotStore {
  const now = deps.now ?? Date.now;

  const store = createStore<MarmotStoreState>()((set, get) => {
    const refresh = async (): Promise<void> => {
      try {
        const view = await deps.core.marmotView();
        if (!view) return;
        set({
          available: view.available,
          conversations: toConversations(view),
          messages: view.messages as Record<string, MarmotMessage[]>,
          pendingWelcomes: view.pendingWelcomes,
          activeGroup: view.activeGroup,
          diagnostics: {
            eventsReceived: view.eventsReceived,
            ignored: view.ignored,
            errors: view.errors,
          },
        });
      } catch (err) {
        deps.log?.(`[nativeMarmot] view refresh failed: ${err}`);
      }
    };

    void deps.core
      .onCoreEvent((event) => {
        if (typeof event === 'object' && 'stateChanged' in event && event.stateChanged.slice === 'marmot') {
          void refresh();
        }
      })
      .catch((err) => deps.log?.(`[nativeMarmot] onCoreEvent failed: ${err}`));
    void refresh();

    const dispatch = (intent: Parameters<NativeCore['dispatch']>[0]): Promise<void> =>
      deps.core.dispatch(intent).catch((err) => deps.log?.(`[nativeMarmot] dispatch failed: ${err}`));

    return {
      available: false,
      conversations: {},
      messages: {},
      pendingWelcomes: {},
      activeGroup: null,
      subscribed: true,
      diagnostics: { eventsReceived: 0, ignored: 0, errors: 0 },
      publishedKeyPackage: null,

      start: () => {},
      stop: () => {},
      ingestGiftWrap: () => {},
      ingestGroupMessage: () => {},

      send: async (groupId, text) => {
        await dispatch({ sendMarmotMessage: { groupId, text } });
        await refresh();
        const list = get().messages[groupId] ?? [];
        return (
          list[list.length - 1] ?? {
            id: globalThis.crypto.randomUUID(),
            groupId,
            senderPubkey: '',
            content: text,
            at: now(),
            status: 'failed',
          }
        );
      },

      retry: async (groupId, messageId) => {
        const failed = (get().messages[groupId] ?? []).find(
          (m) => m.id === messageId && m.status === 'failed',
        );
        if (!failed) return;
        await dispatch({ sendMarmotMessage: { groupId, text: failed.content } });
        await refresh();
      },

      startChat: async (peerPubkey): Promise<StartMarmotChatResult> => {
        if (!get().available) return { ok: false, reason: 'unavailable' };
        const existing = Object.values(get().conversations).find((c) => c.peerPubkey === peerPubkey);
        if (existing) return { ok: true, groupId: existing.groupId };

        await dispatch({ startMarmotChat: { peerPubkey } });
        await refresh();
        const created = Object.values(get().conversations).find((c) => c.peerPubkey === peerPubkey);
        return created ? { ok: true, groupId: created.groupId } : { ok: false, reason: 'failed' };
      },

      acceptWelcome: async (welcomeId) => {
        await dispatch({ acceptMarmotWelcome: { welcomeId } });
        await refresh();
        return get().pendingWelcomes[welcomeId] === undefined;
      },

      setActiveGroup: (groupId) => {
        set({ activeGroup: groupId });
        void dispatch({ selectMarmotGroup: { groupId } });
      },

      markRead: (groupId) => {
        void dispatch({ markMarmotRead: { groupId } });
      },
    };
  });

  return store;
}
