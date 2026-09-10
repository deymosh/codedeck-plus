/**
 * Phase 3b boot wiring — builds the platform seams and mounts the React shell
 * on the framework-free phone core:
 * - under Tauri: SQLite persistence via the in-crate sql_* commands (KV +
 *   transcripts, migrations + boot prune; tauri-plugin-sql was replaced in
 *   CDX-012 — see src-tauri/src/sqlstore.rs), Tauri resume/focus events,
 *   codedeck:// deep links via tauri-plugin-deep-link;
 * - plain-browser dev (`pnpm dev` without Tauri): in-memory KV/transcripts —
 *   a throwaway identity per reload, good enough for UI work.
 * Either way: real relay transport (SimplePool, enablePing) + connectivity
 * event sources feeding the connection FSM.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import { createPhoneCore, type PhoneCore } from './core/createPhoneCore';
import { memoryKV, memoryTranscriptStorage, realTimers, type KV, type TranscriptStorage } from './core/ports';
import { loadOrCreateIdentity } from './core/stores/identity';
import { parsePairingUrl } from './core/stores/pairing';
import { loadPersistedSettings } from './core/stores/settings';
import { attachConnectivity, tauriNativeConnectivity, type TauriListen } from './platform/connectivity';
import { createRelayTransport } from './platform/relayTransport';
import { createNativeCore } from './platform/nativeCore';
import type { NativeCoreControl } from './core/nativeCore';
import { App } from './ui/App';
import { PhoneCoreProvider } from './ui/coreContext';
import { PHONE_LABEL } from './ui/label';

const log = (msg: string): void => console.log(msg);

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function boot(): Promise<PhoneCore> {
  let kv: KV;
  let transcriptStorage: TranscriptStorage;
  let prune: (() => Promise<void>) | undefined;

  if (isTauri) {
    const [{ openTauriDatabase }, sqlite] = await Promise.all([
      import('./platform/tauriSqlite'),
      import('./platform/sqlite'),
    ]);
    const db = await openTauriDatabase();
    await sqlite.runMigrations(db);
    kv = sqlite.sqliteKv(db);
    transcriptStorage = sqlite.sqliteTranscriptStorage(db);
    prune = async () => {
      const result = await sqlite.pruneTranscripts(db);
      if (result.removedSessions > 0 || result.trimmedRows > 0) {
        log(`[Prune] removed ${result.removedSessions} idle sessions, trimmed ${result.trimmedRows} rows`);
      }
    };
    await prune(); // boot prune (plan §5: 5k/session, 30-day idle)
  } else {
    log('[Boot] no Tauri runtime — in-memory persistence (browser dev mode)');
    kv = memoryKV();
    transcriptStorage = memoryTranscriptStorage();
  }

  // The transport needs the persisted relay list before the core exists;
  // later changes flow settings → nostrClient.setRelays → transport.
  const settings = await loadPersistedSettings(kv);
  // Loaded here (createPhoneCore below loads it again from the same kv — a
  // second deterministic read of the same persisted key, not a new one) so
  // the transport's NIP-42 AUTH signer (for relays that challenge, e.g.
  // Haven) is wired in from the start: the pool's automaticallyAuth is baked
  // in at construction and can't be added after the fact.
  const identity = await loadOrCreateIdentity(kv, log);

  // Orbot SOCKS5 routing (if the user has it on): must be applied BEFORE the
  // transport opens its first WebSocket — ProxyController only affects
  // connections made after it resolves (see platform/torProxy.ts). Desktop's
  // plugin command is a no-op, so this is safe to call unconditionally under
  // Tauri; plain-browser dev has no plugin to call at all.
  if (isTauri && settings.torProxyEnabled) {
    log('[TorProxy] enabled in settings — calling plugin:tor-proxy|enable before opening any relay socket');
    const { tauriTorProxyApi, ORBOT_DEFAULT_HOST, ORBOT_DEFAULT_PORT } = await import(
      './platform/torProxy'
    );
    const supported = await tauriTorProxyApi(log).enable(ORBOT_DEFAULT_HOST, ORBOT_DEFAULT_PORT);
    log(
      supported
        ? '[TorProxy] setProxyOverride applied — relay sockets should now route through Orbot'
        : '[TorProxy] enabled in settings, but this WebView does not support PROXY_OVERRIDE',
    );
  } else if (isTauri) {
    log('[TorProxy] disabled in settings — relay sockets will connect directly');
  }

  const transport = createRelayTransport({ relays: settings.relays, log, secretKey: identity.secretKey });

  // F1: the in-process Rust runtime. `null` unless this APK was built with the
  // `native-core` feature (the probe command is absent otherwise). When
  // present, createPhoneCore routes the BRIDGE protocol through it; `transport`
  // above still serves DM (1059) + Marmot (445). Inbound is wired after the
  // core exists (below).
  const nativeSeam = await createNativeCore(log);
  const nativeCore: NativeCoreControl | undefined = nativeSeam
    ? {
        init: (c) => nativeSeam.init(c),
        start: () => nativeSeam.start(),
        stop: () => nativeSeam.stop(),
        setMachines: (m) => nativeSeam.setMachines(m),
        setRelays: (r) => nativeSeam.setRelays(r),
        send: async (machine, msg) => {
          await nativeSeam.send(machine, msg);
          return true;
        },
        publish: async (machine, msg) => ({ verdict: await nativeSeam.publish(machine, msg) }),
      }
    : undefined;
  if (nativeCore) log('[Boot] native-core present — bridge protocol runs in-process (Rust)');

  // DM peer profiles (kind 0) resolve over their own one-shot pool (lazy —
  // no sockets until the first conversation needs a name).
  const { createProfileFetcher } = await import('./platform/profileFetch');
  const profileFetcher = createProfileFetcher({ log });

  // OS notifications (5c): delivery seam only — the core decides when
  // (store-driven events × app visibility, core/notifications.ts).
  const { createPlatformNotifier, ensureNotificationPermission } = await import(
    './platform/notifier'
  );
  const notifier = createPlatformNotifier(log);

  // Attention chime (Phase 4): pure Web Audio, independent of the OS
  // notification permission. The one-shot gesture unlock must be registered
  // before the user's first tap resumes the suspended WebView AudioContext.
  const { initPingAudio, playAttentionPing } = await import('./platform/pingSound');
  initPingAudio();

  // Marmot/MLS DMs (Phase 6, CDX-012): the MDK engine lives in Rust behind
  // the marmot_* commands — real under Tauri (Android AND desktop), null in
  // plain-browser dev (the store stays unavailable; NIP-17 only).
  const { createMarmotPlatform } = await import('./platform/marmot');
  const marmot = await createMarmotPlatform(log);

  const core = await createPhoneCore({
    kv,
    transport,
    ...(nativeCore ? { nativeCore, nativeCoreProxy: '127.0.0.1:9050' } : {}),
    transcriptStorage,
    profileFetcher,
    notifier,
    // decidePing's hidden-or-not-viewing rule + the shared cooldown live in
    // the core's coordinator; the seam only makes the sound (Phase 4).
    ping: playAttentionPing,
    marmot,
    // One-QR mesh setup (5d, CDX-028): a pairing QR that bundled mesh
    // manual-join info (admin device id + network id) gets it dispatched to
    // the mesh engine automatically (Android; no-op elsewhere).
    onMeshJoin: (adminNpub, networkId) => {
      if (!isTauri) return;
      void import('./platform/mesh').then(({ tauriMeshApi, manualAddNetwork }) =>
        manualAddNetwork(tauriMeshApi(log), adminNpub, networkId).then((ok) =>
          log(`[Mesh] pairing manual-join (${networkId}) ${ok ? 'succeeded' : 'failed'}`),
        ),
      );
    },
    log,
  });

  // F1 inbound: the runtime's decoded bridge→phone messages and connection
  // snapshots feed the SAME handlers / FSM the WebView transport would have.
  if (nativeSeam) {
    void nativeSeam.onMessage((machine, msg) => core.api.dispatchDecoded(msg, machine));
    void nativeSeam.onConnection(({ status }) => {
      // The runtime owns the socket + reconnect; mirror its status onto the
      // WebView FSM so the connection chip and resync-on-reconnect stay honest.
      if (status === 'connected') {
        core.connection.getState().dispatch({ type: 'socket-open', at: Date.now() });
      } else if (status === 'waiting-retry' || status === 'offline') {
        core.connection.getState().dispatch({ type: 'socket-close' });
      }
    });
    void nativeSeam.onActionFailed((kind) => {
      if (kind === 'decrypt-failed') {
        core.connection.getState().dispatch({ type: 'decrypt-failure' });
      }
    });
  }

  // Stay-connected foreground service (5c): settings toggle → start/stop,
  // connection FSM status → notification text. Android does the real work;
  // desktop's plugin commands are no-ops, so attaching under Tauri is safe.
  if (isTauri) {
    const { attachStayConnectedService, tauriServiceApi } = await import(
      './platform/foregroundService'
    );
    attachStayConnectedService({
      settings: core.settings,
      connection: core.connection,
      service: tauriServiceApi(log),
      requestPermission: ensureNotificationPermission,
      log,
    });

    // Reacts to the toggle changing WHILE the app is running (the boot-time
    // application above only covers app start). Reconfigures future
    // connections only — see torProxy.ts for why an in-session toggle isn't
    // fully retroactive.
    const { attachTorProxy, tauriTorProxyApi: tauriTorProxyApiLive } = await import(
      './platform/torProxy'
    );
    attachTorProxy({ settings: core.settings, proxy: tauriTorProxyApiLive(log), log });
  }

  // Native event sources → connection FSM + maintenance ticks.
  let tauriListen: TauriListen | undefined;
  if (isTauri) {
    const { listen } = await import('@tauri-apps/api/event');
    tauriListen = (event, handler) => listen(event, handler);
  }
  attachConnectivity({
    dispatch: (event) => core.connection.getState().dispatch(event),
    windowTarget: window,
    documentTarget: document,
    visibilityState: () => document.visibilityState,
    isOnline: () => navigator.onLine,
    // CDX-027: Android WebView never fires online/offline — the plugin's
    // ConnectivityManager source feeds the FSM instead (desktop/browser
    // degrade to navigator.onLine automatically).
    ...(isTauri ? { native: tauriNativeConnectivity(log) } : {}),
    ...(tauriListen ? { tauriListen } : {}),
    timers: realTimers,
    onTick: () => {
      core.outbox.getState().sweep();
      void core.transcript.getState().retrySweep();
      // CDX-020: a subscription can die without the socket ever closing — the
      // sweep notices "connected but every heartbeat stale" and forces the
      // FSM's normal socket-close → backoff → reconnect path. In native mode
      // the runtime runs its own CDX-020 watchdog — don't double it.
      if (!nativeCore) core.connection.getState().checkHeartbeats();
    },
    ...(prune ? { onDaily: () => void prune?.() } : {}),
  });

  // codedeck://pair deep links → STAGED pairing flow (Tauri only; the browser
  // has no scheme handler). CDX-013: a deep link can be fired by any web page
  // without user intent, so it is staged for explicit confirmation (the App
  // notices `staged` and shows the pairing screen) — never auto-paired. QR
  // scan / pasted link keep the direct path: there the user action is the
  // intent.
  if (isTauri) {
    try {
      const { getCurrent, onOpenUrl } = await import('@tauri-apps/plugin-deep-link');
      const handleUrls = (urls: string[]): void => {
        for (const url of urls) {
          const parsed = parsePairingUrl(url);
          if (parsed.ok) {
            core.pairing.getState().stagePair(parsed.parts);
            return;
          }
          log(`[DeepLink] ignoring non-pairing URL: ${parsed.error}`);
        }
      };
      const current = await getCurrent();
      if (current && current.length > 0) handleUrls(current);
      await onOpenUrl(handleUrls);
    } catch (err) {
      log(`[DeepLink] registration failed: ${err}`);
    }
  }

  core.start();

  // CDX-026: ask for POST_NOTIFICATIONS eagerly at boot. Android reads the
  // grant state once at startup and Settings promises "asks on first start" —
  // without this, no notification (stay-connected service, DMs, permission
  // prompts, turn-finish) can ever show on a clean install.
  void ensureNotificationPermission()
    .then((granted) => log(`[Notifier] permission ${granted ? 'granted' : 'not granted'}`))
    .catch((err: unknown) => log(`[Notifier] permission request failed: ${err}`));

  return core;
}

const root = createRoot(document.getElementById('root')!);

boot()
  .then((core) => {
    root.render(
      <StrictMode>
        <PhoneCoreProvider value={core}>
          <App />
        </PhoneCoreProvider>
      </StrictMode>,
    );
  })
  .catch((err: unknown) => {
    console.error('[Boot] failed', err);
    root.render(
      <div style={{ padding: '2rem', color: 'var(--danger, #ef4444)' }}>
        <h1>CodeDeck failed to start</h1>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{String(err)}</pre>
      </div>,
    );
  });
