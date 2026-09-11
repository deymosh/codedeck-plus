/**
 * A native-backed `MachinesStore` (migration F2b) — same pattern as the other
 * native adapters: exposes the SAME `MachinesStoreState` read shape
 * `createMachinesStore` (`./machines.ts`) does, backed by a cached
 * `NativeCore.machinesView()`, refreshed on the machines slice's
 * `stateChanged` event.
 *
 * Every WRITE method here is a no-op. Unlike the outbox/settings/pairing
 * adapters, nothing in native mode ever calls one of these:
 * - `registerMachine`/`applySessionList`/`applySessionUpsert`/
 *   `applySessionReplaced`/`updateSessionInfo`/`noteFirstUserMessage`/
 *   `removeMachine`/`applyUsage`/`applyGsd`/`applyModels`/
 *   `applyProviderProfiles` are called ONLY from `createPhoneCore.ts`'s
 *   ingest path today — the Rust `Router` folds every bridge message into
 *   `MachinesView`'s state directly, so that whole ingest path is superseded,
 *   not reused, once the phone re-points at the native core.
 * - `dismissSession`/`userRemoveSession`/`restoreSession` are called ONLY
 *   from `deleteController.ts` — superseded the same way by dispatching
 *   `Intent::DeleteSession`/`UndoDelete` directly, which the Rust core's own
 *   optimistic-delete + undo timer owns end to end (plan `core::` §1.2).
 *
 * These methods exist only so this adapter satisfies `MachinesStoreState`
 * for any code still typed against it — same reasoning as `nativePairing.ts`'s
 * `handlePairAck` no-op.
 */
import { createStore } from 'zustand/vanilla';
import type { NativeCore } from '../../platform/nativeCore';
import type { MachineView as NativeMachineView, MachinesView as NativeMachinesView } from '../nativeCoreTypes';
import type { MachineView, MachinesStore, MachinesStoreState, SessionView } from './machines';

function toMachineView(view: NativeMachineView): MachineView {
  const sessions: Record<string, SessionView> = {};
  for (const [id, s] of Object.entries(view.sessions)) {
    sessions[id] = {
      info: s.info,
      presence: s.presence,
      lastListedAt: s.lastListedAt,
      ...(s.usage !== undefined ? { usage: s.usage } : {}),
      ...(s.gsd !== undefined ? { gsd: s.gsd } : {}),
    };
  }
  return {
    pubkeyHex: view.pubkeyHex,
    name: view.name,
    ...(view.host !== undefined ? { host: view.host } : {}),
    ...(view.label !== undefined ? { label: view.label } : {}),
    capabilities: view.capabilities,
    folders: view.folders,
    roots: view.roots,
    // The Rust view uses `Option<T>` (absent field); the TS store's own
    // shape predates that and spells "no value yet" as `null` — same cast
    // as `nativeSettings.ts`'s documented "no phone-side re-validation at
    // this seam" policy.
    protocolVersion: view.protocolVersion ?? null,
    machineOffline: view.machineOffline,
    lastHeartbeatAt: view.lastHeartbeatAt ?? null,
    sessions,
    ...(view.models !== undefined ? { models: view.models } : {}),
    ...(view.defaultModel !== undefined ? { defaultModel: view.defaultModel } : {}),
    ...(view.modelsError !== undefined ? { modelsError: view.modelsError } : {}),
    ...(view.providerProfiles !== undefined ? { providerProfiles: view.providerProfiles } : {}),
  };
}

function toMachines(view: NativeMachinesView): Record<string, MachineView> {
  const out: Record<string, MachineView> = {};
  for (const [pubkeyHex, m] of Object.entries(view.machines)) out[pubkeyHex] = toMachineView(m);
  return out;
}

export interface NativeMachinesStoreDeps {
  core: NativeCore;
  log?(msg: string): void;
}

export function createNativeMachinesStore(deps: NativeMachinesStoreDeps): MachinesStore {
  const store = createStore<MachinesStoreState>()((set, get) => {
    const refresh = async (): Promise<void> => {
      try {
        const view = await deps.core.machinesView();
        set({ machines: toMachines(view) });
      } catch (err) {
        deps.log?.(`[nativeMachines] view refresh failed: ${err}`);
      }
    };

    void deps.core
      .onCoreEvent((event) => {
        if (typeof event === 'object' && 'stateChanged' in event && event.stateChanged.slice === 'machines') {
          void refresh();
        }
      })
      .catch((err) => deps.log?.(`[nativeMachines] onCoreEvent failed: ${err}`));
    void refresh();

    const noop = (): void => {};

    return {
      machines: {},
      dismissedSessions: {},

      registerMachine: noop,
      removeMachine: noop,
      applySessionList: noop,
      applySessionUpsert: noop,
      applySessionReplaced: noop,
      updateSessionInfo: noop,
      noteFirstUserMessage: noop,
      userRemoveSession: noop,
      dismissSession: noop,
      restoreSession: noop,
      applyUsage: noop,
      applyGsd: noop,
      applyModels: noop,
      applyProviderProfiles: noop,

      machine: (pubkeyHex) => get().machines[pubkeyHex],
      session: (machinePubkey, sessionId) => get().machines[machinePubkey]?.sessions[sessionId],
      machinePubkeys: () => Object.keys(get().machines),
    };
  });

  return store;
}
