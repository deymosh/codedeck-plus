/**
 * Boot wiring — builds the platform seams and mounts the React shell on the
 * phone core.
 *
 * `createPhoneCoreNative` is the only composition now (F2b's final step):
 * the in-process Rust `client_runtime::Core` owns the entire bridge protocol
 * + store layer, present whenever this APK is built with the `native-core`
 * Cargo feature (`core_available` probes for it — see `platform/nativeCore.ts`
 * and `docs/CLIENT-CORE.md`). The pre-F2b WebView-driven composition (every
 * store, the connection FSM, and the bridge protocol codec running in TS over
 * a real relay transport) is retired — see git history — along with plain-
 * browser dev (`pnpm dev` without Tauri has no Tauri commands to probe at
 * all, so it can no longer boot). Under Tauri, SQLite persistence via the
 * in-crate sql_* commands still backs identity + settings (KV; tauri-plugin-sql
 * was replaced in CDX-012 — see src-tauri/src/sqlstore.rs), Tauri resume/focus
 * events, codedeck:// deep links via tauri-plugin-deep-link.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import { createPhoneCoreNative } from './core/createPhoneCoreNative';
import type { PhoneCore } from './core/phoneCore';
import { realTimers, type KV } from './core/ports';
import { parsePairingUrl } from './core/stores/pairing';
import { attachConnectivity, tauriNativeConnectivity, type TauriListen } from './platform/connectivity';
import { createNativeCore, type NativeCore } from './platform/nativeCore';
import { App } from './ui/App';
import { PhoneCoreProvider } from './ui/coreContext';

const log = (msg: string): void => console.log(msg);

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function bootNative(nativeCore: NativeCore, kv: KV): Promise<PhoneCore> {
  const { createProfileFetcher } = await import('./platform/profileFetch');
  const profileFetcher = createProfileFetcher({ log });
  return createPhoneCoreNative({
    core: nativeCore,
    kv,
    nativeCoreProxy: '127.0.0.1:9050',
    profileFetcher,
    log,
  });
}

async function boot(): Promise<PhoneCore> {
  if (!isTauri) {
    // Plain-browser dev has no Tauri commands to probe `native-core` through
    // at all, and the local WebView composition it used to fall back to is
    // gone — UI iteration now requires a Tauri build (`./codedeck apk debug`
    // with the `native-core` feature).
    throw new Error(
      'CodeDeck requires a Tauri build with the native-core feature — plain-browser dev is no longer supported.',
    );
  }

  const [{ openTauriDatabase }, sqlite] = await Promise.all([
    import('./platform/tauriSqlite'),
    import('./platform/sqlite'),
  ]);
  const db = await openTauriDatabase();
  await sqlite.runMigrations(db);
  const kv = sqlite.sqliteKv(db);
  // Legacy transcript rows from a pre-F2b (WebView-composition) install are
  // still worth trimming on boot prune (plan §5: 5k/session, 30-day idle) —
  // client-runtime owns transcript persistence going forward and never
  // writes to this table, so this is cleanup, not a live read/write path.
  const prune = async (): Promise<void> => {
    const result = await sqlite.pruneTranscripts(db);
    if (result.removedSessions > 0 || result.trimmedRows > 0) {
      log(`[Prune] removed ${result.removedSessions} idle sessions, trimmed ${result.trimmedRows} rows`);
    }
  };
  await prune();

  const nativeCore = await createNativeCore(log);
  if (!nativeCore) {
    throw new Error(
      'This build was not compiled with the native-core Cargo feature (core_available returned false) — there is no fallback composition anymore.',
    );
  }
  // Replace protocolConstants.ts's hand-written fallback with what Rust
  // actually computed, before anything (settings hydration included) reads
  // one of those values — see that module's own doc comment for why a plain
  // reassignment here is visible to every already-imported consumer.
  try {
    const { applyProtocolDefaults } = await import('./core/protocolConstants');
    applyProtocolDefaults(await nativeCore.defaults());
  } catch (err) {
    log(`[boot] core.defaults() failed — keeping the hand-written fallback: ${err}`);
  }
  const core = await bootNative(nativeCore, kv);

  const { ensureNotificationPermission } = await import('./platform/notifier');

  // Stay-connected foreground service (5c): settings toggle → start/stop,
  // connection FSM status → notification text. Interface-only
  // (`core.settings`/`core.connection`), unchanged by which composition boots.
  const { attachStayConnectedService, tauriServiceApi } = await import('./platform/foregroundService');
  attachStayConnectedService({
    settings: core.settings,
    connection: core.connection,
    service: tauriServiceApi(log),
    requestPermission: ensureNotificationPermission,
    log,
  });
  // Rust dials its own SOCKS5 at `core.init` (`CoreConfig.proxy`/`tor`, set
  // from the persisted `torProxyEnabled` setting) — there is no WebView-side
  // proxy toggle to attach here. Toggling Tor while already running DOES
  // hot-reconfigure the transport now: `Intent::SetTorEnabled` (dispatched by
  // `nativeSettings.ts`'s `setTorProxyEnabled`) redials every relay through
  // `WsTransport::set_proxy`, using the SOCKS5 address `core.init` always
  // sends (regardless of whether Tor started on or off) — see
  // `client_runtime::core::Loop`'s `tor_proxy_address`.

  // The in-app attention chime: Rust decides WHEN to ping
  // (`client_core::notifications::decide_ping`) and emits `CoreEvent::Ping`
  // (the bare string `"ping"`, a unit variant) — this is the one platform
  // seam that decision needs, since Rust has no audio API of its own.
  const { initPingAudio, playAttentionPing } = await import('./platform/pingSound');
  initPingAudio();
  void nativeCore.onCoreEvent((event) => {
    if (event === 'ping') playAttentionPing();
  });

  // Native event sources → connection FSM + maintenance ticks.
  const { listen } = await import('@tauri-apps/api/event');
  const tauriListen: TauriListen = (event, handler) => listen(event, handler);
  attachConnectivity({
    dispatch: (event) => core.connection.getState().dispatch(event),
    windowTarget: window,
    documentTarget: document,
    visibilityState: () => document.visibilityState,
    isOnline: () => navigator.onLine,
    // CDX-027: Android WebView never fires online/offline — the plugin's
    // ConnectivityManager source feeds the FSM instead.
    native: tauriNativeConnectivity(log),
    tauriListen,
    timers: realTimers,
    onTick: () => {
      core.outbox.getState().sweep();
      void core.transcript.getState().retrySweep();
      // The runtime runs its own CDX-020 stale-subscription watchdog now —
      // nothing left to check from this side.
    },
    onDaily: () => void prune(),
  });

  // codedeck://pair deep links → STAGED pairing flow. CDX-013: a deep link
  // can be fired by any web page without user intent, so it is staged for
  // explicit confirmation (the App notices `staged` and shows the pairing
  // screen) — never auto-paired. QR scan / pasted link keep the direct path:
  // there the user action is the intent.
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
