/**
 * A native-backed `QuickPromptsStore` (migration F2b) — same family as the
 * other native adapters: exposes the SAME `QuickPromptsStoreState` shape
 * `createQuickPromptsStore` (`./quickPrompts.ts`) does, backed by a cached
 * `NativeCore.quickPromptsView()`, refreshed on the `quickPrompts` slice's
 * `stateChanged` event, with every mutation going through
 * `NativeCore.dispatch`.
 *
 * There is no client-side id generation here (unlike the TS store's own
 * `deps.newId()`): `Intent::AddQuickPrompt` already carries an `id` field
 * because the Rust store, like the outbox's, needs the id decided before the
 * mutation lands so a retry or a concurrent dispatch can't double-add. This
 * adapter generates it the same way `createPhoneCore.ts` does today
 * (`crypto.randomUUID()`) rather than taking a `newId` dependency, since
 * nothing else about this adapter needs to be pluggable for tests — the
 * dispatched `Intent` is what a test asserts on, not the id's shape.
 */
import { createStore } from 'zustand/vanilla';
import { hydrateFromCore } from './nativeHydration';
import type { NativeCore } from '../../platform/nativeCore';
import type { QuickPromptsStore, QuickPromptsStoreState } from './quickPrompts';

export interface NativeQuickPromptsStoreDeps {
  core: NativeCore;
  log?(msg: string): void;
}

export function createNativeQuickPromptsStore(deps: NativeQuickPromptsStoreDeps): QuickPromptsStore {
  const store = createStore<QuickPromptsStoreState>()((set) => {
    const refresh = async (): Promise<void> => {
      const view = await deps.core.quickPromptsView();
      set({ prompts: view.prompts });
    };

    void hydrateFromCore(
      () =>
        deps.core.onCoreEvent((event) => {
          if (typeof event === 'object' && event.stateChanged?.slice === 'quickPrompts') {
            void refresh().catch((err) => deps.log?.(`[nativeQuickPrompts] view refresh failed: ${err}`));
          }
        }),
      refresh,
      deps.core.onResume,
      'nativeQuickPrompts',
      deps.log,
    );

    const dispatch = (intent: Parameters<NativeCore['dispatch']>[0]): void => {
      deps.core.dispatch(intent).catch((err) => deps.log?.(`[nativeQuickPrompts] dispatch failed: ${err}`));
    };

    return {
      prompts: [],

      addPrompt: (label, text) => {
        dispatch({ addQuickPrompt: { id: globalThis.crypto.randomUUID(), label, text } });
      },

      updatePrompt: (id, label, text) => {
        dispatch({ updateQuickPrompt: { id, label, text } });
      },

      removePrompt: (id) => {
        dispatch({ removeQuickPrompt: { id } });
      },
    };
  });

  return store;
}
