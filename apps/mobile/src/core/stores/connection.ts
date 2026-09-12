/**
 * Connection types shared by the native adapter (`nativeConnection.ts`) and
 * the UI (`coreContext.tsx`, `platform/connectivity.ts`,
 * `platform/foregroundService.ts`).
 *
 * The FSM itself — the pure reducer that decided backoff, visibility
 * debounce, and presence — is ported to Rust
 * (`client_core::connection::connection_reducer`, `client_runtime`'s own
 * `presence_of`/`heartbeats_all_stale`) and driven by `client_runtime::Core`.
 * `createNativeConnectionStore` only translates high-level `ConnectionEvent`s
 * into `core.start()`/`stop()`/`setOnline()`/`pause()`/`resume()` calls; it
 * does not re-implement the FSM. Only the shared TYPES survive here.
 */
import type { StoreApi } from 'zustand/vanilla';

export type ConnectionStatus =
  | 'idle'           // created, connect() not requested yet
  | 'connecting'     // socket requested, waiting for open (EOSE)
  | 'connected'      // live subscriptions
  | 'waiting-retry'  // socket lost while online — backoff timer running
  | 'offline'        // OS says no network — no socket, no retry timer
  | 'stopped';       // deliberate shutdown — inert until connect-requested

export type Presence = 'live' | 'stale' | 'offline';

export interface ConnectionState {
  status: ConnectionStatus;
  /** Consecutive failed/lost connection attempts (drives backoff). */
  attempt: number;
  online: boolean;
  visible: boolean;
  /** A hide event is being debounced. */
  hiddenPending: boolean;
  /** ms timestamp of the last successful socket-open, null before the first. */
  lastConnectedAt: number | null;
  /** Diagnostics: NIP-44 decrypt failures since app start. Never a disconnect. */
  decryptFailures: number;
  /** Raised at DECRYPT_FAILURE_THRESHOLD — the UI shows a "check pairing"
   *  banner instead of lying about connectivity. */
  needsPairingCheck: boolean;
  /** machine pubkeyHex → ms timestamp of its last 30515 heartbeat. */
  heartbeats: Record<string, number>;
}

export type ConnectionEvent =
  | { type: 'connect-requested' }
  | { type: 'disconnect-requested' }
  | { type: 'online' }
  | { type: 'offline' }
  | { type: 'visibility'; visible: boolean }
  | { type: 'visibility-settled' }
  | { type: 'resume' }
  | { type: 'socket-open'; at: number }
  | { type: 'socket-close'; random?: number }
  | { type: 'retry-due' }
  | { type: 'heartbeat-received'; machine: string; at: number }
  | { type: 'decrypt-failure' };

/** 30515 older than this (2.5× the bridge's 60s heartbeat interval) = stale.
 *  Read by `createNativeConnectionStore`'s own `presence()` (it has no FSM
 *  to consult, so it computes presence itself from the machines store's
 *  `lastHeartbeatAt` using this same threshold). */
export const HEARTBEAT_STALE_AFTER_MS = 150_000;

export interface ConnectionStoreState extends ConnectionState {
  dispatch(event: ConnectionEvent): void;
  presence(machinePubkey: string): Presence;
  /** Configured relays with a live socket right now — Settings' per-relay
   *  status dot. Not a subscription/publish-readiness signal, just "the
   *  socket is up." Empty on the pre-migration store (it had no per-relay
   *  concept); the native adapter is the only one that ever populates it. */
  connectedRelays: string[];
}

export type ConnectionStore = StoreApi<ConnectionStoreState>;
