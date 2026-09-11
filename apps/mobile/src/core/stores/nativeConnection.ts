/**
 * A native-backed `ConnectionStore` (migration F2b) — the thinnest adapter of
 * the set, because most of `ConnectionState` was never a UI-facing contract
 * to begin with. Production UI reads exactly two fields (`status` and
 * `needsPairingCheck` — confirmed by search: `Sidebar.tsx`, `SessionScreen.tsx`),
 * which is precisely what the F1 `NativeCore.connectionStatus()`/
 * `onConnection()` surface already provides — the connection FSM itself has
 * been fully ported to `client_core::connection` since F1, so there is
 * nothing left to read back beyond that.
 *
 * The remaining `ConnectionState` fields (`attempt`, `online`, `visible`,
 * `hiddenPending`, `lastConnectedAt`, `decryptFailures`, `heartbeats`) are
 * internal FSM bookkeeping the Rust reducer owns entirely now; they stay at
 * inert placeholder values here purely so this adapter satisfies
 * `ConnectionStoreState`'s type for any code still typed against it.
 *
 * `dispatch` forwards exactly the platform signals TS still originates
 * (network connectivity, app visibility, an OS resume) to the matching F1
 * `NativeCore` lifecycle method — the same one-to-one mapping
 * `Core::pause`/`resume`/`set_online` already document Rust-side:
 * `{ type: 'visibility', visible: false }` → `pause()`, `visible: true` →
 * `resume()` (which itself dispatches BOTH `Visibility{true}` and `Resume`
 * Rust-side, so a bare `{ type: 'resume' }` maps to the same call).
 * `socket-open`/`socket-close`/`retry-due`/`heartbeat-received`/
 * `decrypt-failure`/`visibility-settled` are all FSM-internal now — the
 * transport driver and the Router raise them directly inside Rust, so
 * dispatching them here would be redundant at best.
 */
import { createStore } from 'zustand/vanilla';
import { HEARTBEAT_STALE_AFTER_MS } from './connection';
import type { NativeCore } from '../../platform/nativeCore';
import type { ConnectionEvent, ConnectionStore, ConnectionStoreState, Presence } from './connection';
import type { MachinesStore } from './machines';

export interface NativeConnectionStoreDeps {
  core: NativeCore;
  /** The already-constructed native machines adapter — `presence()` answers
   *  from its cached `lastHeartbeatAt` rather than this store maintaining a
   *  second, duplicate heartbeat cache of its own. */
  machines: MachinesStore;
  now?(): number;
  log?(msg: string): void;
}

export function createNativeConnectionStore(deps: NativeConnectionStoreDeps): ConnectionStore {
  const now = deps.now ?? Date.now;

  const store = createStore<ConnectionStoreState>()((set, get) => {
    void deps.core
      .connectionStatus()
      .then((snapshot) => set({ status: snapshot.status, needsPairingCheck: snapshot.needsPairingCheck }))
      .catch((err) => deps.log?.(`[nativeConnection] status fetch failed: ${err}`));

    void deps.core
      .onConnection((snapshot) => {
        set({ status: snapshot.status, needsPairingCheck: snapshot.needsPairingCheck });
      })
      .catch((err) => deps.log?.(`[nativeConnection] onConnection failed: ${err}`));

    const dispatch = (event: ConnectionEvent): void => {
      const run = (): Promise<void> => {
        switch (event.type) {
          case 'connect-requested':
            return deps.core.start();
          case 'disconnect-requested':
            return deps.core.stop();
          case 'online':
            return deps.core.setOnline(true);
          case 'offline':
            return deps.core.setOnline(false);
          case 'visibility':
            return event.visible ? deps.core.resume() : deps.core.pause();
          case 'resume':
            return deps.core.resume();
          default:
            // socket-open/close, retry-due, heartbeat-received,
            // decrypt-failure, visibility-settled: Rust's own FSM and Router
            // raise these directly — nothing to forward.
            return Promise.resolve();
        }
      };
      run().catch((err) => deps.log?.(`[nativeConnection] dispatch(${event.type}) failed: ${err}`));
    };

    return {
      status: 'idle',
      attempt: 0,
      online: true,
      visible: true,
      hiddenPending: false,
      lastConnectedAt: null,
      decryptFailures: 0,
      needsPairingCheck: false,
      heartbeats: {},

      dispatch,

      // The same 3-state logic Rust's own presence check runs, sourced from
      // the machines adapter's cached lastHeartbeatAt instead of a
      // heartbeats map this store would otherwise have to duplicate.
      presence: (machinePubkey): Presence => {
        if (get().status !== 'connected') return 'offline';
        const heartbeatAt = deps.machines.getState().machine(machinePubkey)?.lastHeartbeatAt;
        if (heartbeatAt === null || heartbeatAt === undefined) return 'offline';
        return now() - heartbeatAt <= HEARTBEAT_STALE_AFTER_MS ? 'live' : 'stale';
      },
      // CDX-020's dead-subscription sweep is Rust's own StaleWatchdog now
      // (client_runtime::core's Msg::StaleWatchdog) — main.tsx already only
      // calls this when there is no native core at all.
      checkHeartbeats: () => {},
    };
  });

  return store;
}
