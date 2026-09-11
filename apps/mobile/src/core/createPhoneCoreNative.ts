/**
 * createPhoneCoreNative — the F2b composition root: assembles the eleven
 * native-backed store adapters (`apps/mobile/src/core/stores/native*.ts`)
 * plus `createNativeBridgeApi` into the SAME `PhoneCore` shape
 * `createPhoneCore.ts` builds over the WebView transport, so `usePhoneCore()`
 * and every screen that already consumes `PhoneCore` need no changes to run
 * against the Rust core instead.
 *
 * Deliberately much smaller than `createPhoneCore.ts`: almost everything
 * that file's composition root does by hand — the connection FSM, the
 * message router, the notification coordinator, the delete controller with
 * its undo timer, cross-store cleanup on pairing/removal — is now owned
 * entirely by `client_runtime::Core` (proven this session by the F2b
 * `Intent`/`CoreEvent`/`*View` surface and the Layer 2 contract-harness
 * gate). This function's job is just: load the identity secret + seed
 * relays (still a TS responsibility — see the module doc on
 * `stores/identity.ts`), call `core.init`, construct the eleven adapters
 * against the SAME `NativeCore` handle, and hydrate transcripts for the
 * sessions already known at boot.
 *
 * Two `PhoneCore` methods have no Rust equivalent yet and are honest,
 * logged no-ops rather than invented behavior:
 * - `removeMachine`: unpairing has no `Intent` at all yet (a real gap, not
 *   an oversight — `apps/mobile/src/ui/Sidebar.tsx`'s "forget this machine"
 *   action would need one designed and added before this can work
 *   natively).
 * - `client` is omitted from the returned `PhoneCore` (now optional):
 *   nothing in production UI reads it directly (confirmed by search), and
 *   there is no `PhoneNostrClient` in native mode — Rust owns the socket.
 *
 * NOT wired here (deliberately out of scope for this composition — a UI/
 * bootstrap decision, not a backend one): which `main.tsx` capability check
 * decides whether to call this function instead of `createPhoneCore`, and
 * updating `apps/mobile/src/ui/screens/SessionScreen.tsx`'s image-send path
 * to `dispatch({ sendSessionImage })` directly instead of going through
 * `sendSessionImage()`/`BridgeApi.uploadImageBlossom`/`uploadImageChunk`
 * (see `createNativeBridgeApi`'s module doc for why those two cannot be
 * shimmed like-for-like).
 */
import { bytesToHex } from './crypto';
import { createNativeBridgeApi } from './services/nativeBridgeApi';
import { createIdentityStore, loadOrCreateIdentity, type IdentityStore } from './stores/identity';
import { loadPersistedSettings } from './stores/settings';
import { createNativeConnectionStore } from './stores/nativeConnection';
import { createNativeMachinesStore } from './stores/nativeMachines';
import { createNativeTranscriptStore } from './stores/nativeTranscript';
import { createNativeOutboxStore } from './stores/nativeOutbox';
import { createNativePendingSessionsStore } from './stores/nativePendingSessions';
import { createNativePairingStore } from './stores/nativePairing';
import { createNativeDmStore } from './stores/nativeDm';
import { createNativeMarmotStore } from './stores/nativeMarmot';
import { createNativeSettingsStore } from './stores/nativeSettings';
import { createNativeQuickPromptsStore } from './stores/nativeQuickPrompts';
import { createNativeUiStore } from './stores/nativeUi';
import type { NativeCore } from '../platform/nativeCore';
import type { KV, Logger } from './ports';
import type { ProfileFetcher } from './stores/dm';
import type { PhoneCore } from './createPhoneCore';

export interface PhoneCoreNativeDeps {
  core: NativeCore;
  kv: KV;
  /** SOCKS5 `host:port` handed to `core.init` when Tor is on (the Orbot
   *  address; a platform-layer concern this function does not resolve
   *  itself) — same contract as `PhoneCoreDeps.nativeCoreProxy`. */
  nativeCoreProxy?: string;
  /** One-shot kind-0 profile resolution for DM peers — same seam
   *  `PhoneCoreDeps.profileFetcher` is. Absent → DM peers show truncated
   *  npubs only. */
  profileFetcher?: ProfileFetcher;
  log?: Logger;
}

export async function createPhoneCoreNative(deps: PhoneCoreNativeDeps): Promise<PhoneCore> {
  const log = deps.log;
  const core = deps.core;

  // The identity secret and the initial relay list still come from TS's own
  // persisted KV (the SAME codedeck.db `settings`/`identity.secretKey` keys
  // the WebView path reads) — `core.init` is the one place the secret is
  // ever handed to Rust, and it happens exactly once per run.
  const keypair = await loadOrCreateIdentity(deps.kv, log);
  const settingsData = await loadPersistedSettings(deps.kv);
  await core.init({
    relays: settingsData.relays,
    identitySecretHex: bytesToHex(keypair.secretKey),
    proxy: settingsData.torProxyEnabled ? (deps.nativeCoreProxy ?? null) : null,
    tor: settingsData.torProxyEnabled,
  });

  const identity: IdentityStore = createIdentityStore(keypair);
  const machines = createNativeMachinesStore({ core, ...(log ? { log } : {}) });
  const connection = createNativeConnectionStore({ core, machines, ...(log ? { log } : {}) });
  const transcript = createNativeTranscriptStore({ core, ...(log ? { log } : {}) });
  const outbox = createNativeOutboxStore({ core, ...(log ? { log } : {}) });
  const pendingSessions = createNativePendingSessionsStore({ core, ...(log ? { log } : {}) });
  const pairing = createNativePairingStore({ core, ...(log ? { log } : {}) });
  const dm = createNativeDmStore({
    core,
    ...(deps.profileFetcher ? { profileFetcher: deps.profileFetcher } : {}),
    ...(log ? { log } : {}),
  });
  const marmot = createNativeMarmotStore({ core, ...(log ? { log } : {}) });
  const settings = createNativeSettingsStore({ core, ...(log ? { log } : {}) });
  const quickPrompts = createNativeQuickPromptsStore({ core, ...(log ? { log } : {}) });
  const ui = createNativeUiStore({ core, ...(log ? { log } : {}) });
  const api = createNativeBridgeApi({ core, ...(log ? { log } : {}) });

  // Same boot-time eager hydration `createPhoneCore.ts` does, sourced from a
  // direct machinesView() fetch rather than the machines adapter's own
  // (separately in-flight) first refresh — this loop needs the list NOW,
  // not whenever that promise happens to settle.
  const initialMachines = await core.machinesView();
  for (const machine of Object.values(initialMachines.machines)) {
    for (const sessionId of Object.keys(machine.sessions)) {
      void transcript.getState().hydrateSession(machine.pubkeyHex, sessionId);
    }
  }

  return {
    identity,
    connection,
    machines,
    transcript,
    outbox,
    pendingSessions,
    pairing,
    dm,
    marmot,
    settings,
    quickPrompts,
    ui,
    api,
    // `client` intentionally omitted (optional on `PhoneCore`) — see module doc.

    // Routed through the connection store's own dispatch, same as
    // createPhoneCore.ts's start/stop — connection.ts's FSM (or, here, its
    // native adapter) is the one place that owns what "start"/"stop" mean.
    start: () => connection.getState().dispatch({ type: 'connect-requested' }),
    stop: async () => {
      connection.getState().dispatch({ type: 'disconnect-requested' });
      await transcript.getState().flush();
    },
    flush: () => transcript.getState().flush(),

    removeMachine: async (pubkeyHex: string) => {
      log?.(
        `[PhoneCoreNative] removeMachine(${pubkeyHex.slice(0, 8)}…) is not supported yet — ` +
          'no Intent exists for unpairing a machine natively.',
      );
    },

    deleteSession: (machine, sessionId, label) => {
      void core
        .dispatch({ deleteSession: { machine, sessionId, label: label ?? null } })
        .catch((err) => log?.(`[PhoneCoreNative] deleteSession dispatch failed: ${err}`));
    },
    undoDelete: () => {
      void core.dispatch('undoDelete').catch((err) => log?.(`[PhoneCoreNative] undoDelete dispatch failed: ${err}`));
    },
  };
}
