/**
 * createPhoneCoreNative — the sole `PhoneCore` composition root: assembles
 * the eleven native-backed store adapters (`apps/mobile/src/core/stores/
 * native*.ts`) plus `createNativeBridgeApi` into the `PhoneCore` shape
 * `phoneCore.ts` declares, so `usePhoneCore()` and every screen just consume
 * it without knowing a Rust core sits behind it.
 *
 * Deliberately small: the connection FSM, the message router, the
 * notification coordinator, the delete controller with its undo timer, and
 * cross-store cleanup on pairing/removal all live in `client_runtime::Core`
 * (the F2b `Intent`/`CoreEvent`/`*View` surface, proven by the Layer 2
 * contract-harness gate). This function's job is just: load the identity
 * secret + seed relays (still a TS responsibility — see the module doc on
 * `stores/identity.ts`), call `core.init`, construct the eleven adapters
 * against the SAME `NativeCore` handle, and hydrate transcripts for the
 * sessions already known at boot.
 *
 * `main.tsx` reaches this via a single capability probe (`createNativeCore()`
 * — non-null only when this APK was built with the `native-core` Cargo
 * feature); see that module's doc.
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
import type { PhoneCore } from './phoneCore';

export interface PhoneCoreNativeDeps {
  core: NativeCore;
  kv: KV;
  /** SOCKS5 `host:port` handed to `core.init` when Tor is on (the Orbot
   *  address; a platform-layer concern this function does not resolve
   *  itself). */
  nativeCoreProxy?: string;
  /** One-shot kind-0 profile resolution for DM peers. Absent → DM peers show
   *  truncated npubs only. */
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
  // `proxy` is the SOCKS5 address Rust dials through WHEN Tor is on — sent
  // unconditionally (not nulled out when starting with Tor off) so a later
  // live toggle has an address to switch back to; `tor` is the separate
  // on/off flag deciding whether it's actually used, at boot and hereafter.
  await core.init({
    relays: settingsData.relays,
    identitySecretHex: bytesToHex(keypair.secretKey),
    proxy: deps.nativeCoreProxy ?? null,
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
    connection,
    ...(deps.profileFetcher ? { profileFetcher: deps.profileFetcher } : {}),
    ...(log ? { log } : {}),
  });
  const marmot = createNativeMarmotStore({ core, connection, ...(log ? { log } : {}) });
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

    // Forgetting a machine is now a single `Intent` — the store cleanup
    // `createPhoneCore.ts` does by hand (drop the machine, clear its
    // sessions' unread dots, remove their transcripts, deselect, resubscribe)
    // is `client_runtime::Core`'s job on the other side of this dispatch.
    removeMachine: async (pubkeyHex: string) => {
      try {
        await core.dispatch({ removeMachine: { pubkeyHex } });
      } catch (err) {
        log?.(`[PhoneCoreNative] removeMachine dispatch failed: ${err}`);
      }
    },

    deleteSession: (machine, sessionId, label) => {
      void core
        .dispatch({ deleteSession: { machine, sessionId, label: label ?? null } })
        .catch((err) => log?.(`[PhoneCoreNative] deleteSession dispatch failed: ${err}`));
    },
    undoDelete: () => {
      void core.dispatch('undoDelete').catch((err) => log?.(`[PhoneCoreNative] undoDelete dispatch failed: ${err}`));
    },

    // See the `PhoneCore` interface doc: `Intent::SendSessionImage` does the
    // whole Blossom-upload-then-chunk-fallback as one step in Rust, so this
    // is a plain dispatch, not the multi-callback orchestration the local
    // composition's `sendSessionImage()` does.
    sendSessionImageNative: (params) =>
      core.dispatch({
        sendSessionImage: {
          machine: params.machine,
          sessionId: params.sessionId,
          text: params.text,
          image: Array.from(params.image),
          filename: params.filename,
          mimeType: params.mimeType,
        },
      }),
  };
}
