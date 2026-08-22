/**
 * quickPromptsStore (CDX-049) — user-defined labeled prompt shortcuts, ported
 * from the legacy `codedeck/src/stores/quickPromptStore.ts` (which was its own
 * store there too). The list renders as a tappable bar above the session
 * input; a tap INSERTS the prompt text into the draft (never auto-sends).
 *
 * Same persistence discipline as the settings store: KV port, hydrate on
 * boot, save on every mutation, garbage-tolerant hydrate.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { KV, Logger } from '../ports';

export const QUICK_PROMPTS_STORAGE_KEY = 'quickPrompts';

export interface QuickPrompt {
  id: string;
  label: string;
  text: string;
}

export function hydrateQuickPrompts(raw: string | undefined): QuickPrompt[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is QuickPrompt =>
        typeof p === 'object' &&
        p !== null &&
        typeof (p as QuickPrompt).id === 'string' &&
        (p as QuickPrompt).id !== '' &&
        typeof (p as QuickPrompt).label === 'string' &&
        typeof (p as QuickPrompt).text === 'string',
    );
  } catch {
    return [];
  }
}

export interface QuickPromptsStoreState {
  prompts: QuickPrompt[];
  /** Append a new prompt; label/text are trimmed, both must be non-empty. */
  addPrompt(label: string, text: string): void;
  updatePrompt(id: string, label: string, text: string): void;
  removePrompt(id: string): void;
}

export type QuickPromptsStore = StoreApi<QuickPromptsStoreState>;

export interface QuickPromptsStoreDeps {
  kv: KV;
  /** Prompt id generator (createPhoneCore's newId — crypto.randomUUID). */
  newId(): string;
  storageKey?: string;
  log?: Logger;
}

export function createQuickPromptsStore(
  deps: QuickPromptsStoreDeps,
  initial: QuickPrompt[] = [],
): QuickPromptsStore {
  const storageKey = deps.storageKey ?? QUICK_PROMPTS_STORAGE_KEY;

  return createStore<QuickPromptsStoreState>()((set, get) => {
    const persist = (): void => {
      void deps.kv
        .set(storageKey, JSON.stringify(get().prompts))
        .catch((err) => deps.log?.(`[QuickPrompts] persist failed: ${err}`));
    };

    return {
      prompts: initial,

      addPrompt: (label, text) => {
        const trimmedLabel = label.trim();
        const trimmedText = text.trim();
        if (trimmedLabel === '' || trimmedText === '') return;
        set({
          prompts: [
            ...get().prompts,
            { id: deps.newId(), label: trimmedLabel, text: trimmedText },
          ],
        });
        persist();
      },

      updatePrompt: (id, label, text) => {
        const trimmedLabel = label.trim();
        const trimmedText = text.trim();
        if (trimmedLabel === '' || trimmedText === '') return;
        const prompts = get().prompts;
        if (!prompts.some((p) => p.id === id)) return;
        set({
          prompts: prompts.map((p) =>
            p.id === id ? { ...p, label: trimmedLabel, text: trimmedText } : p,
          ),
        });
        persist();
      },

      removePrompt: (id) => {
        const prompts = get().prompts;
        if (!prompts.some((p) => p.id === id)) return;
        set({ prompts: prompts.filter((p) => p.id !== id) });
        persist();
      },
    };
  });
}

export async function loadPersistedQuickPrompts(
  kv: KV,
  storageKey: string = QUICK_PROMPTS_STORAGE_KEY,
): Promise<QuickPrompt[]> {
  return hydrateQuickPrompts(await kv.get(storageKey));
}
