/**
 * A native-backed `OutboxStore` (migration F2b) — the SAME public shape
 * `createOutboxStore` (`./outbox.ts`) exposes, but every mutation goes
 * through `NativeCore.dispatch` and every read comes from a cached
 * `OutboxView`, kept fresh by re-fetching on the `outbox` slice's
 * `stateChanged` event. `createPhoneCore` can hand either implementation to
 * the exact same UI code, since the UI only ever depends on
 * `OutboxStoreState`'s shape.
 *
 * `confirm` / `fail` / `sweep` are deliberate no-ops here: those are the
 * Rust `Router`'s own job (an `input-ack`/`input-failed` message, and the
 * confirm-timeout sweep, both already fold into the outbox store on the
 * native side without anything on this side asking). Calling one is not an
 * error — TS callers that still invoke them on a bridge-message path get
 * silently overtaken by the next `stateChanged` refresh, same net effect.
 *
 * `deps.core` is `platform/nativeCore.ts`'s `NativeCore` — this module is
 * NOT `isTauri`-guarded itself (that seam already is); it only needs `core`
 * to already exist, which is what `createNativeCore()` returning non-null
 * establishes.
 */
import { createStore } from 'zustand/vanilla';
import { hydrateFromCore } from './nativeHydration';
import type { NativeCore } from '../../platform/nativeCore';
import type { Logger } from '../ports';
import type { OutboxItem as NativeOutboxItem } from '../nativeCoreTypes';
import type { OutboxItem, OutboxStore, OutboxStoreState } from './outbox';

function toOutboxItem(item: NativeOutboxItem): OutboxItem {
  return {
    id: item.id,
    machine: item.machine,
    sessionId: item.sessionId,
    text: item.text,
    state: item.state,
    createdAt: item.createdAt,
    publishedAt: item.publishedAt,
    confirmedAt: item.confirmedAt,
    failedAt: item.failedAt,
    error: item.error,
    attempts: item.attempts,
  };
}

const UNRESOLVED_STATES = new Set<OutboxItem['state']>(['pending', 'published']);

export interface NativeOutboxStoreDeps {
  core: NativeCore;
  newId?(): string;
  log?: Logger;
}

export function createNativeOutboxStore(deps: NativeOutboxStoreDeps): OutboxStore {
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID());

  const store = createStore<OutboxStoreState>()((set, get) => {
    const refresh = async (): Promise<void> => {
      const view = await deps.core.outboxView();
      const items: Record<string, OutboxItem> = {};
      for (const raw of view.items) items[raw.id] = toOutboxItem(raw);
      set({ items });
    };

    void hydrateFromCore(
      () =>
        deps.core.onCoreEvent((event) => {
          if (typeof event === 'object' && event.stateChanged?.slice === 'outbox') {
            void refresh().catch((err) => deps.log?.(`[nativeOutbox] view refresh failed: ${err}`));
          }
        }),
      refresh,
      deps.core.onResume,
      'nativeOutbox',
      deps.log,
    );

    return {
      items: {},

      send: async (machine, sessionId, text) => {
        const inputId = newId();
        await deps.core.dispatch({ sendInput: { machine, sessionId, text, inputId } });
        await refresh();
        return (
          get().items[inputId] ?? {
            id: inputId,
            machine,
            sessionId,
            text,
            state: 'pending',
            createdAt: Date.now(),
            publishedAt: null,
            confirmedAt: null,
            failedAt: null,
            error: null,
            attempts: 1,
          }
        );
      },

      // The bridge-message → confirm/fail path is the Rust Router's job on
      // this side (see the module doc comment) — nothing to do here.
      confirm: () => {},
      fail: () => {},
      sweep: () => {},

      retry: async (id) => {
        const item = get().items[id];
        if (!item) return undefined;
        await deps.core.dispatch({ retryOutboxItem: { machine: item.machine, id } });
        await refresh();
        return get().items[id];
      },

      item: (id) => get().items[id],
      itemsFor: (machine, sessionId) =>
        Object.values(get().items).filter((i) => i.machine === machine && i.sessionId === sessionId),
      unresolved: () => Object.values(get().items).filter((i) => UNRESOLVED_STATES.has(i.state)),
    };
  });

  return store;
}
