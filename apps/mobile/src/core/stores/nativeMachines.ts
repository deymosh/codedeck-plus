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
import { hydrateFromCore } from './nativeHydration';
import type { NativeCore } from '../../platform/nativeCore';
import type { MachineView as NativeMachineView, MachinesView as NativeMachinesView } from '../nativeCoreTypes';
import type { MachineView, MachinesStore, MachinesStoreState, SessionView } from './machines';

/** `protocol`'s `skip_serializing_if` fields specta types conservatively as
 *  `T | null | undefined` (both "may be omitted" and "may be Option::None"),
 *  even though this app's own skip-if fields only ever take the omitted
 *  form. `./machines.ts`'s pre-migration shape spells "no value" as
 *  `undefined` only — this normalizes at the one seam that matters, rather
 *  than widening every domain-store field to also accept `null`. The cast at
 *  the return is the one place that trusts this: the loop body genuinely
 *  never leaves a `null` in the result, it just isn't a shape TS can infer
 *  field-by-field generically. */
function nullsToUndefined<U extends object>(obj: object): U {
  const out = {} as U;
  for (const [k, v] of Object.entries(obj)) (out as Record<string, unknown>)[k] = v === null ? undefined : v;
  return out;
}

function toMachineView(view: NativeMachineView): MachineView {
  const sessions: Record<string, SessionView> = {};
  for (const [id, s] of Object.entries(view.sessions)) {
    sessions[id] = {
      info: nullsToUndefined<SessionView['info']>(s.info),
      presence: s.presence,
      lastListedAt: s.lastListedAt,
      ...(s.usage != null ? { usage: nullsToUndefined<NonNullable<SessionView['usage']>>(s.usage) } : {}),
      ...(s.gsd != null ? { gsd: nullsToUndefined<NonNullable<SessionView['gsd']>>(s.gsd) } : {}),
    };
  }
  return {
    pubkeyHex: view.pubkeyHex,
    name: view.name,
    ...(view.host != null ? { host: view.host } : {}),
    ...(view.label != null ? { label: view.label } : {}),
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
    ...(view.models != null
      ? { models: view.models.map((m) => nullsToUndefined<NonNullable<MachineView['models']>[number]>(m)) }
      : {}),
    ...(view.defaultModel != null ? { defaultModel: view.defaultModel } : {}),
    ...(view.modelsError != null ? { modelsError: view.modelsError } : {}),
    ...(view.providerProfiles != null
      ? {
          providerProfiles: view.providerProfiles.map((p) =>
            nullsToUndefined<NonNullable<MachineView['providerProfiles']>[number]>(p),
          ),
        }
      : {}),
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
      const view = await deps.core.machinesView();
      set({ machines: toMachines(view) });
    };

    void hydrateFromCore(
      () =>
        deps.core.onCoreEvent((event) => {
          if (typeof event === 'object' && event.stateChanged?.slice === 'machines') {
            void refresh().catch((err) => deps.log?.(`[nativeMachines] view refresh failed: ${err}`));
          }
        }),
      refresh,
      deps.core.onResume,
      'nativeMachines',
      deps.log,
    );

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
