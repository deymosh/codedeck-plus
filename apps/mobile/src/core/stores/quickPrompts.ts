/**
 * Quick-prompt types (CDX-049) shared by the native adapter
 * (`nativeQuickPrompts.ts`) and the UI (`coreContext.tsx`).
 *
 * Persistence and the CRUD mutations are Rust's job now
 * (`client_core::stores::quick_prompts`) — only the shared TYPES survive
 * here.
 */
import type { StoreApi } from 'zustand/vanilla';

export interface QuickPrompt {
  id: string;
  label: string;
  text: string;
}

export interface QuickPromptsStoreState {
  prompts: QuickPrompt[];
  /** Append a new prompt; label/text are trimmed, both must be non-empty. */
  addPrompt(label: string, text: string): void;
  updatePrompt(id: string, label: string, text: string): void;
  removePrompt(id: string): void;
}

export type QuickPromptsStore = StoreApi<QuickPromptsStoreState>;
