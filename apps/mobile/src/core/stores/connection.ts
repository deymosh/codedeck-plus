/**
 * Connection FSM — kills bug A ("relay connection keeps dropping") by design.
 *
 * ONE pure reducer consumes every connectivity signal (network online/offline,
 * page visibility, Tauri resume, socket open/close, heartbeats, decrypt
 * failures) and returns the next state plus a list of effects. The store is a
 * thin interpreter: it runs the effects against injected seams (socket client,
 * timers, refresh/reconcile), so every policy below is unit-testable on the
 * reducer alone:
 *
 * - A visibility flip is DEBOUNCED (500ms) and NEVER tears down a healthy
 *   socket — backgrounding the app briefly no longer causes a disconnect.
 * - Reconnects back off exponentially (2s → 30s cap) with +25% jitter.
 * - Every successful (re)connect triggers `refresh-and-reconcile`: send
 *   refresh-sessions (CDX-008 proved the boot 30515's seqHigh goes stale) and
 *   reconcile transcripts via the sync protocol.
 * - Decrypt failures increment a diagnostics counter and raise
 *   `needsPairingCheck` — they are NEVER treated as a lost connection (the old
 *   app faked disconnects out of them).
 * - Presence per machine is an honest 3-state f(30515 age, socket state):
 *   live / stale / offline — no since-filter staleness guessing.
 * - CDX-020: subscriptions can die WITHOUT the socket closing (no onclose is
 *   ever delivered; publishes keep working). The periodic sweep calls
 *   `checkHeartbeats()`: status `connected` while every machine heartbeat is
 *   stale → dispatch `socket-close` so the normal backoff/reconnect path runs
 *   and the UI chip tells the truth.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Logger, Timers } from '../ports';

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

export type ConnectionEffect =
  | { effect: 'open-socket' }
  | { effect: 'close-socket' }
  | { effect: 'schedule-retry'; delayMs: number }
  | { effect: 'cancel-retry' }
  | { effect: 'schedule-visibility-check'; delayMs: number }
  | { effect: 'cancel-visibility-check' }
  | { effect: 'refresh-and-reconcile' };

export const RECONNECT_BASE_MS = 2_000;
export const RECONNECT_MAX_MS = 30_000;
export const RECONNECT_JITTER_FRACTION = 0.25;
export const VISIBILITY_DEBOUNCE_MS = 500;
export const DECRYPT_FAILURE_THRESHOLD = 3;
/** 30515 older than this (2.5× the bridge's 60s heartbeat interval) = stale. */
export const HEARTBEAT_STALE_AFTER_MS = 150_000;

/**
 * Tor circuit builds (and every round-trip after) routinely add several
 * seconds over a direct connection. The direct-connection backoff/stale
 * constants above were flapping "connecting" → "waiting-retry" under Orbot
 * because attempt 0 retried after only 2s — not enough time for a circuit —
 * and heartbeats were declared stale before a slower relay round-trip could
 * land. When `settings.torProxyEnabled` is on, callers should pass this
 * config instead so the FSM gives Tor the extra time it actually needs.
 */
export interface ReconnectConfig {
  baseMs: number;
  maxMs: number;
  jitterFraction: number;
  heartbeatStaleAfterMs: number;
}

export const DEFAULT_RECONNECT_CONFIG: ReconnectConfig = {
  baseMs: RECONNECT_BASE_MS,
  maxMs: RECONNECT_MAX_MS,
  jitterFraction: RECONNECT_JITTER_FRACTION,
  heartbeatStaleAfterMs: HEARTBEAT_STALE_AFTER_MS,
};

export const TOR_RECONNECT_CONFIG: ReconnectConfig = {
  baseMs: 8_000,
  maxMs: 60_000,
  jitterFraction: RECONNECT_JITTER_FRACTION,
  heartbeatStaleAfterMs: 240_000,
};

export const initialConnectionState: ConnectionState = {
  status: 'idle',
  attempt: 0,
  online: true,
  visible: true,
  hiddenPending: false,
  lastConnectedAt: null,
  decryptFailures: 0,
  needsPairingCheck: false,
  heartbeats: {},
};

export interface ReducerResult {
  state: ConnectionState;
  effects: ConnectionEffect[];
}

/** Backoff delay for the given attempt: exp(base→max cap) + jitter. */
export function backoffDelayMs(
  attempt: number,
  random = 0,
  config: ReconnectConfig = DEFAULT_RECONNECT_CONFIG,
): number {
  const base = Math.min(config.baseMs * Math.pow(2, attempt), config.maxMs);
  const jitter = Math.floor(Math.max(0, Math.min(1, random)) * base * config.jitterFraction);
  return base + jitter;
}

const connectEffects: ConnectionEffect[] = [
  { effect: 'cancel-retry' },
  { effect: 'open-socket' },
];

export function connectionReducer(
  state: ConnectionState,
  event: ConnectionEvent,
  reconnectConfig: ReconnectConfig = DEFAULT_RECONNECT_CONFIG,
): ReducerResult {
  switch (event.type) {
    case 'connect-requested': {
      if (state.status === 'connected' || state.status === 'connecting') {
        return { state, effects: [] };
      }
      if (!state.online) {
        return { state: { ...state, status: 'offline', attempt: 0 }, effects: [] };
      }
      return {
        state: { ...state, status: 'connecting', attempt: 0 },
        effects: connectEffects,
      };
    }

    case 'disconnect-requested':
      return {
        state: { ...state, status: 'stopped', hiddenPending: false },
        effects: [
          { effect: 'cancel-retry' },
          { effect: 'cancel-visibility-check' },
          { effect: 'close-socket' },
        ],
      };

    case 'online': {
      const next = { ...state, online: true };
      if (state.status === 'connected' || state.status === 'connecting' || state.status === 'stopped' || state.status === 'idle') {
        return { state: next, effects: [] };
      }
      // offline / waiting-retry: the network is back — reconnect NOW with a
      // fresh backoff (a network change is a new world, not attempt N+1).
      return {
        state: { ...next, status: 'connecting', attempt: 0 },
        effects: connectEffects,
      };
    }

    case 'offline': {
      if (state.status === 'stopped' || state.status === 'idle') {
        return { state: { ...state, online: false }, effects: [] };
      }
      return {
        state: { ...state, online: false, status: 'offline', attempt: 0 },
        effects: [{ effect: 'cancel-retry' }, { effect: 'close-socket' }],
      };
    }

    case 'visibility': {
      if (event.visible) {
        const effects: ConnectionEffect[] = state.hiddenPending
          ? [{ effect: 'cancel-visibility-check' }]
          : [];
        const next = { ...state, visible: true, hiddenPending: false };
        // Coming back to a dead connection while online → reconnect immediately.
        if (state.online && (state.status === 'waiting-retry' || state.status === 'idle')) {
          return {
            state: { ...next, status: 'connecting', attempt: 0 },
            effects: [...effects, ...connectEffects],
          };
        }
        return { state: next, effects };
      }
      // Going hidden: debounce only. A healthy socket is NEVER torn down here.
      if (state.hiddenPending) return { state, effects: [] };
      return {
        state: { ...state, hiddenPending: true },
        effects: [{ effect: 'schedule-visibility-check', delayMs: VISIBILITY_DEBOUNCE_MS }],
      };
    }

    case 'visibility-settled':
      // The app really is hidden. Record it — and still leave the socket alone
      // (the stay-connected service owns background lifetime, not visibility).
      return { state: { ...state, visible: false, hiddenPending: false }, effects: [] };

    case 'resume': {
      if (state.status === 'connected') {
        // Cheap resync-on-resume: the socket survived, but the world may have
        // moved while the OS had us frozen.
        return { state, effects: [{ effect: 'refresh-and-reconcile' }] };
      }
      if (state.status === 'stopped' || !state.online) {
        return { state, effects: [] };
      }
      return {
        state: { ...state, status: 'connecting', attempt: 0 },
        effects: connectEffects,
      };
    }

    case 'socket-open': {
      if (state.status === 'stopped') return { state, effects: [] };
      return {
        state: { ...state, status: 'connected', attempt: 0, lastConnectedAt: event.at },
        effects: [{ effect: 'cancel-retry' }, { effect: 'refresh-and-reconcile' }],
      };
    }

    case 'socket-close': {
      // Deliberate teardown (stopped) or already handled (offline): ignore.
      if (state.status === 'stopped' || state.status === 'offline' || state.status === 'idle') {
        return { state, effects: [] };
      }
      if (!state.online) {
        return { state: { ...state, status: 'offline', attempt: 0 }, effects: [{ effect: 'cancel-retry' }] };
      }
      const delayMs = backoffDelayMs(state.attempt, event.random ?? 0, reconnectConfig);
      return {
        state: { ...state, status: 'waiting-retry', attempt: state.attempt + 1 },
        effects: [{ effect: 'schedule-retry', delayMs }],
      };
    }

    case 'retry-due': {
      if (state.status !== 'waiting-retry' || !state.online) {
        return { state, effects: [] };
      }
      return {
        state: { ...state, status: 'connecting' },
        effects: [{ effect: 'open-socket' }],
      };
    }

    case 'heartbeat-received':
      return {
        state: {
          ...state,
          heartbeats: { ...state.heartbeats, [event.machine]: event.at },
        },
        effects: [],
      };

    case 'decrypt-failure': {
      const decryptFailures = state.decryptFailures + 1;
      return {
        state: {
          ...state,
          decryptFailures,
          needsPairingCheck:
            state.needsPairingCheck || decryptFailures >= DECRYPT_FAILURE_THRESHOLD,
        },
        effects: [],
      };
    }

    default: {
      const exhaustive: never = event;
      void exhaustive;
      return { state, effects: [] };
    }
  }
}

/**
 * Presence per machine — the 3 honest states. Pure:
 * - socket down (any non-connected status) → 'offline'
 * - heartbeat within HEARTBEAT_STALE_AFTER_MS → 'live'
 * - heartbeat older (or never seen) → 'stale' / 'offline'
 */
export function presenceOf(
  state: ConnectionState,
  machinePubkey: string,
  now: number,
  staleAfterMs: number = HEARTBEAT_STALE_AFTER_MS,
): Presence {
  if (state.status !== 'connected') return 'offline';
  const heartbeatAt = state.heartbeats[machinePubkey];
  if (heartbeatAt === undefined) return 'offline';
  return now - heartbeatAt <= staleAfterMs ? 'live' : 'stale';
}

/**
 * CDX-020: dead-subscription detection, pure. True when the socket claims
 * `connected` but every machine heartbeat seen this run is older than the
 * stale threshold — the bridge publishes 30515 every 60s, so all-stale means
 * inbound delivery is gone even though the socket never closed.
 *
 * Loop guard: also requires `lastConnectedAt` to be older than the threshold,
 * so every (re)connect gets a full stale window to hear its first heartbeats.
 * Without it, a genuinely offline machine (old heartbeats survive a reconnect
 * unchanged) would re-trigger a reconnect on every sweep tick.
 */
export function heartbeatsAllStale(
  state: ConnectionState,
  now: number,
  staleAfterMs: number = HEARTBEAT_STALE_AFTER_MS,
): boolean {
  if (state.status !== 'connected') return false;
  if (state.lastConnectedAt === null || now - state.lastConnectedAt <= staleAfterMs) return false;
  const beats = Object.values(state.heartbeats);
  if (beats.length === 0) return false;
  return beats.every((at) => now - at > staleAfterMs);
}

// --- Store: reducer + effect interpreter ---

export interface ConnectionEffectHandlers {
  openSocket(): void;
  closeSocket(): void;
  refreshAndReconcile(): void;
}

export interface ConnectionStoreDeps {
  timers: Timers;
  now(): number;
  /** Jitter source, 0..1. */
  random(): number;
  handlers: ConnectionEffectHandlers;
  log?: Logger;
  /** Reconnect backoff + heartbeat-stale timing. Defaults to direct-connection
   *  timing; pass TOR_RECONNECT_CONFIG when settings.torProxyEnabled is on. */
  reconnectConfig?: ReconnectConfig;
}

export interface ConnectionStoreState extends ConnectionState {
  dispatch(event: ConnectionEvent): void;
  presence(machinePubkey: string): Presence;
  /** CDX-020: periodic dead-subscription check (the 30s sweep). Dispatches one
   *  `socket-close` when connected but every machine heartbeat has gone stale,
   *  so the FSM reconnects instead of the chip lying `connected` forever. */
  checkHeartbeats(): void;
}

export type ConnectionStore = StoreApi<ConnectionStoreState>;

export function createConnectionStore(deps: ConnectionStoreDeps): ConnectionStore {
  let retryTimer: unknown = null;
  let visibilityTimer: unknown = null;
  const reconnectConfig = deps.reconnectConfig ?? DEFAULT_RECONNECT_CONFIG;

  const store = createStore<ConnectionStoreState>()((set, get) => ({
    ...initialConnectionState,

    dispatch: (event: ConnectionEvent): void => {
      // socket-close carries jitter entropy so the reducer stays pure.
      const enriched: ConnectionEvent =
        event.type === 'socket-close' && event.random === undefined
          ? { ...event, random: deps.random() }
          : event;
      const { state, effects } = connectionReducer(get(), enriched, reconnectConfig);
      set(state);
      for (const effect of effects) run(effect);
    },

    presence: (machinePubkey: string): Presence =>
      presenceOf(get(), machinePubkey, deps.now(), reconnectConfig.heartbeatStaleAfterMs),

    checkHeartbeats: (): void => {
      if (!heartbeatsAllStale(get(), deps.now(), reconnectConfig.heartbeatStaleAfterMs)) return;
      deps.log?.('[Connection] every machine heartbeat is stale while connected — treating the subscription as dead');
      get().dispatch({ type: 'socket-close' });
    },
  }));

  const dispatch = (event: ConnectionEvent): void => store.getState().dispatch(event);

  function run(effect: ConnectionEffect): void {
    switch (effect.effect) {
      case 'open-socket':
        deps.handlers.openSocket();
        return;
      case 'close-socket':
        deps.handlers.closeSocket();
        return;
      case 'refresh-and-reconcile':
        deps.handlers.refreshAndReconcile();
        return;
      case 'schedule-retry':
        if (retryTimer !== null) deps.timers.clear(retryTimer);
        deps.log?.(`[Connection] reconnect in ${effect.delayMs}ms`);
        retryTimer = deps.timers.set(() => {
          retryTimer = null;
          dispatch({ type: 'retry-due' });
        }, effect.delayMs);
        return;
      case 'cancel-retry':
        if (retryTimer !== null) {
          deps.timers.clear(retryTimer);
          retryTimer = null;
        }
        return;
      case 'schedule-visibility-check':
        if (visibilityTimer !== null) deps.timers.clear(visibilityTimer);
        visibilityTimer = deps.timers.set(() => {
          visibilityTimer = null;
          dispatch({ type: 'visibility-settled' });
        }, effect.delayMs);
        return;
      case 'cancel-visibility-check':
        if (visibilityTimer !== null) {
          deps.timers.clear(visibilityTimer);
          visibilityTimer = null;
        }
        return;
      default: {
        const exhaustive: never = effect;
        void exhaustive;
      }
    }
  }

  return store;
}
