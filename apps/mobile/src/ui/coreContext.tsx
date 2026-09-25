/**
 * React bindings for the framework-free phone core (Phase 3b).
 *
 * The core is a bundle of zustand VANILLA stores; zustand's `useStore` hook
 * (useSyncExternalStore under the hood) binds components to them. No view
 * logic leaks into the core — this file is the only bridge.
 */
import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import type { PhoneCore } from '../core/phoneCore';
import type { ConnectionStoreState } from '../core/stores/connection';
import type { DmStoreState } from '../core/stores/dm';
import type { MarmotStoreState } from '../core/stores/marmot';
import type { MachinesStoreState } from '../core/stores/machines';
import type { OutboxStoreState } from '../core/stores/outbox';
import type { PairingStoreState } from '../core/stores/pairing';
import type { PendingSessionsStoreState } from '../core/stores/pendingSessions';
import type { QuickPromptsStoreState } from '../core/stores/quickPrompts';
import type { SettingsStoreState } from '../core/stores/settings';
import type { TranscriptStoreState } from '../core/stores/transcript';
import type { UiStoreState } from '../core/stores/ui';

const PhoneCoreContext = createContext<PhoneCore | null>(null);

export const PhoneCoreProvider = PhoneCoreContext.Provider;

export function usePhoneCore(): PhoneCore {
  const core = useContext(PhoneCoreContext);
  if (!core) throw new Error('usePhoneCore outside <PhoneCoreProvider>');
  return core;
}

// Convenience typed selector hooks (narrow selectors keep re-renders sane).

export function useConnection<T>(selector: (s: ConnectionStoreState) => T): T {
  return useStore(usePhoneCore().connection, selector);
}

export function useMachines<T>(selector: (s: MachinesStoreState) => T): T {
  return useStore(usePhoneCore().machines, selector);
}

export function useTranscript<T>(selector: (s: TranscriptStoreState) => T): T {
  return useStore(usePhoneCore().transcript, selector);
}

export function useOutbox<T>(selector: (s: OutboxStoreState) => T): T {
  return useStore(usePhoneCore().outbox, selector);
}

export function usePairing<T>(selector: (s: PairingStoreState) => T): T {
  return useStore(usePhoneCore().pairing, selector);
}

export function useSettings<T>(selector: (s: SettingsStoreState) => T): T {
  return useStore(usePhoneCore().settings, selector);
}

export function useQuickPrompts<T>(selector: (s: QuickPromptsStoreState) => T): T {
  return useStore(usePhoneCore().quickPrompts, selector);
}

export function useUi<T>(selector: (s: UiStoreState) => T): T {
  return useStore(usePhoneCore().ui, selector);
}

export function usePendingSessions<T>(selector: (s: PendingSessionsStoreState) => T): T {
  return useStore(usePhoneCore().pendingSessions, selector);
}

export function useDm<T>(selector: (s: DmStoreState) => T): T {
  return useStore(usePhoneCore().dm, selector);
}

export function useMarmot<T>(selector: (s: MarmotStoreState) => T): T {
  return useStore(usePhoneCore().marmot, selector);
}
