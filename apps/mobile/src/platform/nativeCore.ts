/**
 * nativeCore — the seam to the in-process Rust `client-runtime` (migration
 * F1 transport, F2b the full plan §2 View/Intent/CoreEvent surface).
 *
 * When the APK is built with `native-core` (apps/mobile/src-tauri, the
 * `corebridge` module) and the user opts in, the Nostr sockets + NIP-44 crypto
 * + connection FSM + every store (F2b: over real SQLite persistence) run in
 * the app process (inside the stay-connected foreground service), NOT in
 * this WebView. `dispatch` + the `*View()` queries + `onCoreEvent` are the
 * full re-point surface (plan §2); the earlier `send`/`publish`/`onMessage`
 * F1 methods stay for the transport-only path until `apps/mobile` actually
 * switches over to them.
 *
 * Every command result / event payload crosses the boundary as untyped JSON —
 * `decodeBridgeToPhone` re-validates each inbound F1 message so a Rust/JS
 * drift fails loudly at the seam, not deep in a store; `Intent`/`CoreEvent`/
 * the `*View` types (`nativeCoreTypes.ts`) are hand-mirrored from the Rust
 * side (each carries its own round-trip test there) rather than re-validated
 * here — there is no phone-side zod schema for them (yet). The identity
 * secret passes through `init` exactly once per run and is never logged.
 *
 * Kept isTauri-guarded with lazy imports (house style) so plain-browser dev and
 * the node test suite never touch `@tauri-apps/api`.
 */
import {
  decodeBridgeToPhone,
  type BridgeToPhoneMessage,
  type PhoneToBridgeMessage,
} from '@codedeck/protocol';
import type { Logger } from '../core/ports';
import type {
  CoreEvent,
  DmView,
  Intent,
  MachinesView,
  MarmotView,
  OutboxView,
  PairingView,
  PendingSessionsView,
  QuickPromptsView,
  SettingsView,
  UiView,
} from '../core/nativeCoreTypes';

export type NativeConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'waiting-retry'
  | 'offline'
  | 'stopped';

export type NativeActionFailed =
  | 'decrypt-failed'
  | 'decode-failed'
  | 'publish-rejected'
  | 'publish-unreachable';

export type NativePublishVerdict = 'accepted' | 'unconfirmed' | 'rejected' | 'unreachable';

export interface NativeConnectionSnapshot {
  status: NativeConnectionStatus;
  needsPairingCheck: boolean;
}

export interface NativeCoreConfig {
  relays: string[];
  /** The phone's persisted hex secret. Passed once; never logged. */
  identitySecretHex: string;
  /** SOCKS5 `host:port` (Orbot), or null for a direct connection. */
  proxy: string | null;
  tor: boolean;
}

export interface NativeCore {
  init(config: NativeCoreConfig): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  setOnline(online: boolean): Promise<void>;
  setMachines(machines: string[]): Promise<void>;
  setRelays(relays: string[]): Promise<void>;
  send(machine: string, message: PhoneToBridgeMessage): Promise<void>;
  publish(machine: string, message: PhoneToBridgeMessage): Promise<NativePublishVerdict>;
  connectionStatus(): Promise<NativeConnectionSnapshot>;
  /** Decoded bridge→phone messages. Resolves an unlisten. */
  onMessage(
    cb: (machine: string, message: BridgeToPhoneMessage) => void,
  ): Promise<() => void>;
  onConnection(cb: (snapshot: NativeConnectionSnapshot) => void): Promise<() => void>;
  onActionFailed(cb: (kind: NativeActionFailed) => void): Promise<() => void>;

  // --- F2b: the plan §2 View/Intent/CoreEvent surface ---

  /** Dispatch one user action (plan §2.2). */
  dispatch(intent: Intent): Promise<void>;
  machinesView(): Promise<MachinesView>;
  settingsView(): Promise<SettingsView | null>;
  outboxView(): Promise<OutboxView>;
  pairingView(): Promise<PairingView | null>;
  dmView(): Promise<DmView | null>;
  marmotView(): Promise<MarmotView | null>;
  quickPromptsView(): Promise<QuickPromptsView>;
  pendingSessionsView(): Promise<PendingSessionsView>;
  uiView(): Promise<UiView>;
  /** The full semantic event stream (plan §2.3). Resolves an unlisten. */
  onCoreEvent(cb: (event: CoreEvent) => void): Promise<() => void>;
}

/** Minimal `@tauri-apps/api/core#invoke` shape (injected for tests). */
export type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
/** Minimal `@tauri-apps/api/event#listen` shape (injected for tests). */
export type TauriListen = <T>(
  event: string,
  handler: (event: { payload: T }) => void,
) => Promise<() => void>;

const EV_CONNECTION = 'core://connection';
const EV_MESSAGE = 'core://message';
const EV_ACTION_FAILED = 'core://action-failed';
const EV_CORE_EVENT = 'core://event';

const CONNECTION_STATUSES: readonly NativeConnectionStatus[] = [
  'idle',
  'connecting',
  'connected',
  'waiting-retry',
  'offline',
  'stopped',
];

function asSnapshot(raw: unknown): NativeConnectionSnapshot {
  const o = (raw ?? {}) as { status?: unknown; needs_pairing_check?: unknown; needsPairingCheck?: unknown };
  const status = CONNECTION_STATUSES.includes(o.status as NativeConnectionStatus)
    ? (o.status as NativeConnectionStatus)
    : 'idle';
  return {
    status,
    needsPairingCheck: Boolean(o.needs_pairing_check ?? o.needsPairingCheck),
  };
}

/** The wrapper over a resolved `invoke` / `listen` pair — the testable core. */
export function nativeCoreOver(invoke: TauriInvoke, listen: TauriListen, log?: Logger): NativeCore {
  return {
    init: (config) =>
      invoke<void>('core_init', {
        config: {
          relays: config.relays,
          identitySecretHex: config.identitySecretHex,
          proxy: config.proxy,
          tor: config.tor,
        },
      }),
    start: () => invoke<void>('core_start'),
    stop: () => invoke<void>('core_stop'),
    pause: () => invoke<void>('core_pause'),
    resume: () => invoke<void>('core_resume'),
    setOnline: (online) => invoke<void>('core_set_online', { online }),
    setMachines: (machines) => invoke<void>('core_set_machines', { machines }),
    setRelays: (relays) => invoke<void>('core_set_relays', { relays }),
    send: (machine, message) => invoke<void>('core_send', { machine, message }),
    publish: async (machine, message) =>
      (await invoke<string>('core_publish', { machine, message })) as NativePublishVerdict,
    connectionStatus: async () => asSnapshot(await invoke<unknown>('core_connection_status')),

    onMessage: (cb) =>
      listen<{ machine: string; message: unknown }>(EV_MESSAGE, ({ payload }) => {
        const decoded = decodeBridgeToPhone(JSON.stringify(payload.message));
        if (!decoded.ok) {
          log?.(`[nativeCore] dropping undecodable core://message: ${decoded.error}`);
          return;
        }
        cb(payload.machine, decoded.msg);
      }),

    onConnection: (cb) =>
      listen<unknown>(EV_CONNECTION, ({ payload }) => cb(asSnapshot(payload))),

    onActionFailed: (cb) =>
      listen<NativeActionFailed>(EV_ACTION_FAILED, ({ payload }) => cb(payload)),

    dispatch: (intent) => invoke<void>('core_dispatch', { intent }),
    machinesView: () => invoke<MachinesView>('core_machines_view'),
    settingsView: () => invoke<SettingsView | null>('core_settings_view'),
    outboxView: () => invoke<OutboxView>('core_outbox_view'),
    pairingView: () => invoke<PairingView | null>('core_pairing_view'),
    dmView: () => invoke<DmView | null>('core_dm_view'),
    marmotView: () => invoke<MarmotView | null>('core_marmot_view'),
    quickPromptsView: () => invoke<QuickPromptsView>('core_quick_prompts_view'),
    pendingSessionsView: () => invoke<PendingSessionsView>('core_pending_sessions_view'),
    uiView: () => invoke<UiView>('core_ui_view'),
    onCoreEvent: (cb) => listen<CoreEvent>(EV_CORE_EVENT, ({ payload }) => cb(payload)),
  };
}

/**
 * The production seam. `null` when there is no Tauri runtime OR the APK was not
 * built with `native-core` (the `core_*` commands are absent → `core_init`
 * rejects). Callers fall back to the WebView transport path.
 */
export async function createNativeCore(log?: Logger): Promise<NativeCore | null> {
  const isTauri =
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
  if (!isTauri) return null;
  try {
    const [{ invoke }, { listen }] = await Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/api/event'),
    ]);
    // Probe: `core_available` needs no state and returns true — a build without
    // `native-core` has no such command, so `invoke` rejects and we fall back.
    // (`core_connection_status` would reject here too, before `core_init`.)
    if ((await (invoke as TauriInvoke)<boolean>('core_available')) !== true) return null;
    return nativeCoreOver(invoke as TauriInvoke, listen as unknown as TauriListen, log);
  } catch (err) {
    log?.(`[nativeCore] unavailable (${err}) — using the WebView transport`);
    return null;
  }
}
