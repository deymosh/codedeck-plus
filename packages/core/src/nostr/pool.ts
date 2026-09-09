/**
 * BridgePool — relay connection lifecycle around nostr-tools' SimplePool.
 *
 * Ported from codedeck-bridge-vscode/src/nostrRelay.ts. Carries the CDB-036/
 * CDB-037 fix verbatim in concept: the connection-epoch generation guard (see
 * `connectionEpoch` below) plus exponential-backoff reconnect. Host-free: the
 * caller supplies the subscription filter and event/status callbacks.
 */
import { SimplePool } from 'nostr-tools/pool';
import type { Filter } from 'nostr-tools/filter';
import type { EventTemplate, NostrEvent, VerifiedEvent } from 'nostr-tools/core';

export type ConnectionStatus = 'connected' | 'disconnected' | 'error';

export interface SubscriptionHandle {
  close(): void;
}

export interface BridgePoolCallbacks {
  /**
   * Build the live subscription filter for a (re)connect (see ingest.ts's
   * buildCommandsFilter). Return null to skip subscribing — e.g. no paired
   * phones yet, so an authors filter would be empty.
   */
  buildFilter(): Filter | null;
  /** A subscription event arrived (already epoch-guarded — never fires for a
   *  superseded subscription). */
  onEvent(event: NostrEvent): void;
  onStatus?(status: ConnectionStatus, message?: string): void;
  log?(msg: string): void;
}

export interface BridgePoolOptions {
  relays: string[];
  /** Jitter source for reconnect backoff — injectable for deterministic tests. */
  random?: () => number;
  /** Custom WebSocket implementation — e.g. a Tor/SOCKS5-routed one (see
   *  nostr/transport.ts#createTorWebSocket). Falls back to the ambient
   *  `globalThis.WebSocket` (set by the CLI entrypoint) when unset. */
  websocketImplementation?: typeof WebSocket;
  /** NIP-42 AUTH signer, keyed per relay URL (null = don't auth to that
   *  relay). See @codedeck/protocol#createRelayAuthSigner — a relay that
   *  never challenges (any public relay) never calls this. */
  automaticallyAuth?: (relayUrl: string) => null | ((event: EventTemplate) => Promise<VerifiedEvent>);
  /** Reconnect backoff base/cap in ms (default 2s→30s). Tor's circuit build
   *  time routinely exceeds a 2s retry, so callers passing
   *  `websocketImplementation` for a Tor/SOCKS5 transport should widen this. */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

export class BridgePool {
  private pool: SimplePool | null = null;
  private subscription: SubscriptionHandle | null = null;
  private relayUrls: string[];
  private readonly cb: BridgePoolCallbacks;
  private readonly random: () => number;
  private readonly websocketImplementation?: typeof WebSocket;
  private readonly automaticallyAuth?: BridgePoolOptions['automaticallyAuth'];

  private reconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private disposed = false;

  // --- Subscription generation (CDB-037) ---
  // Bumped at the TOP of every disconnect(), before `pool.destroy()` — which
  // closes the live subscription *synchronously* and calls its `onclose`. So a
  // subscription we deliberately replaced (pairing a phone, changing relays)
  // still calls back on the way out. Without this guard that teardown looks
  // like a dropped connection: it reports 'disconnected' and schedules a
  // reconnect, which tears down the subscription that just came up — a
  // self-perpetuating 2s flap.
  private connectionEpoch = 0;

  private static readonly RECONNECT_BASE_MS = 2_000;
  private static readonly RECONNECT_MAX_MS = 30_000;
  /** Backoff jitter: up to +25% of the base delay, so a fleet of bridges that
   *  lost the same relay doesn't stampede it in lockstep. */
  private static readonly RECONNECT_JITTER_FRACTION = 0.25;

  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;

  /**
   * CDX-055: effectively disable SimplePool's per-relay idle-close. Two
   * nostr-tools (2.24.1) defects interact into a permanent ~58s subscription
   * teardown/rebuild loop on an idle bridge:
   *
   * 1. `enablePing`'s keepalive runs `waitForDummyReq()` every 29s (Node's
   *    global WebSocket has no `.ping()`/`.once()`), whose `<forced-ping>`
   *    subscription is EXCLUDED from the relay's `ongoingOperations` count in
   *    `subscribe()` — but `Subscription.close()` decrements the count
   *    unconditionally. Every ping therefore drives `ongoingOperations` to 0
   *    and arms `scheduleIdleClose()` even though our real REQ is still live.
   * 2. The armed idle close fires `idleTimeout` (default 20s) later:
   *    `relay.close()` → every subscription closed with reason
   *    "relay connection closed by us". 29s ping + 20s idle + ~2.0-2.4s
   *    reconnect backoff = the observed ~52-58s cycle, with a no-subscription
   *    hole every lap and a stale-event replay burst on every reconnect.
   *
   * `idleTimeout: 0` cannot disable it — SimplePool's constructor treats 0 as
   * falsy and keeps the 20s default — so pass the largest delay setTimeout
   * honors (2^31-1 ms ≈ 24.8 days; anything larger fires IMMEDIATELY). Our own
   * disconnect()/dispose() still destroys the pool, so nothing leaks; a bridge
   * deliberately keeps its relay sockets warm (that is what enablePing is for).
   */
  private static readonly IDLE_CLOSE_DISABLED_MS = 0x7fffffff;

  /** SimplePool constructor options — one place, so the pairing-window pool
   *  (openSubscription) can never drift from the main one. The published .d.ts
   *  narrows the ctor to Pick<…, 'enablePing' | 'enableReconnect'>, but the
   *  runtime spreads `...options` into AbstractSimplePool, which honors
   *  `idleTimeout` (and, the same way, `websocketImplementation` /
   *  `automaticallyAuth` — added here for Tor/SOCKS5 transport and NIP-42
   *  relay auth) — hence the widened return type instead of a cast. Instance
   *  method (not static) because it now reads per-pool config. */
  private poolOptions(): ConstructorParameters<typeof SimplePool>[0] & {
    idleTimeout: number;
    websocketImplementation?: typeof WebSocket;
    automaticallyAuth?: BridgePoolOptions['automaticallyAuth'];
  } {
    return {
      // enableReconnect is deliberately OFF: BridgePool already owns 100% of
      // reconnect responsibility (the connectionEpoch guard + scheduleReconnect
      // backoff below, plus the pairing window's own resubscribe timer in
      // bridge.ts). Leaving nostr-tools' own auto-reconnect on lets its Relay
      // object independently reconnect the same underlying socket the moment
      // it closes, racing our own reconnect/resubscribe attempts, which act on
      // the same relay around the same few seconds. Observed effect:
      // nostr-tools' auto-reconnect picks the socket back up and starts a
      // fresh NIP-42 AUTH handshake, while our own reconnect tears the pool
      // down mid-handshake — producing a "send on a closed connection"
      // immediately followed by an "auth timed out" (the OK response can now
      // never arrive), repeating on every drop since the connection never
      // finishes authenticating. subscribeMany's onclose (which both our
      // reconnect paths depend on) still fires normally with this off — it
      // comes from the relay's own close handling, not from its auto-reconnect
      // timer.
      enableReconnect: false,
      // enablePing is supported by the installed nostr-tools (>=2.23): keeps
      // idle relay sockets alive so drops are detected instead of silently hung.
      enablePing: true,
      idleTimeout: BridgePool.IDLE_CLOSE_DISABLED_MS,
      ...(this.websocketImplementation ? { websocketImplementation: this.websocketImplementation } : {}),
      ...(this.automaticallyAuth ? { automaticallyAuth: this.automaticallyAuth } : {}),
    };
  }

  constructor(options: BridgePoolOptions, callbacks: BridgePoolCallbacks) {
    this.relayUrls = [...options.relays];
    this.cb = callbacks;
    this.random = options.random ?? Math.random;
    this.websocketImplementation = options.websocketImplementation;
    this.automaticallyAuth = options.automaticallyAuth;
    this.reconnectBaseMs = options.reconnectBaseMs ?? BridgePool.RECONNECT_BASE_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? BridgePool.RECONNECT_MAX_MS;
  }

  /**
   * `automaticallyAuth` (pool-constructor option, per relay URL) only makes
   * `ensureRelay()` set `relay.onauth` — which fires REACTIVELY whenever an
   * `["AUTH", challenge]` message arrives, independent of any REQ. It does
   * NOT get `subscribeMany` to retry a REQ that a relay rejected with
   * `auth-required: ...`: that retry ("sign the challenge, await the full
   * AUTH round-trip, THEN re-send the exact same REQ on the now-authed
   * connection") is a SEPARATE code path in nostr-tools' subscribeMany,
   * gated on `params.onauth` being passed to that specific call — see
   * abstract-pool.ts's subscribeMany, the `onclose` branch that checks
   * `reason.startsWith('auth-required: ') && params.onauth`.
   *
   * Without this, a relay that requires auth (e.g. Haven) sends
   * `auth-required` on the REQ, which surfaces to us as a plain dropped
   * subscription — BridgePool's own onclose handler tears the WHOLE pool
   * down and reconnects from scratch (a brand-new, again-unauthenticated
   * WebSocket), so the client never gets past the wall: it keeps opening
   * fresh connections that each hit `auth-required` again, forever. Passing
   * `onauth` here (not just `automaticallyAuth` at construction) is what
   * actually lets a NIP-42-gated relay's subscription succeed.
   *
   * `SubscribeManyParams.onauth` is a single flat signer (no per-relay-URL
   * indirection) — fine here because @codedeck/protocol#createRelayAuthSigner's
   * returned signer ignores its relayUrl argument (same identity keypair
   * regardless of which relay is asking), so any URL can be used to derive it.
   */
  private flatAuthSigner(): ((event: EventTemplate) => Promise<VerifiedEvent>) | undefined {
    if (!this.automaticallyAuth) { return undefined; }
    return this.automaticallyAuth(this.relayUrls[0] ?? '') ?? undefined;
  }

  get relays(): readonly string[] {
    return this.relayUrls;
  }

  isConnected(): boolean {
    return this.pool !== null && this.subscription !== null;
  }

  connect(): void {
    this.reconnecting = true;
    this.disconnect(); // bumps connectionEpoch, orphaning the previous subscription's callbacks
    this.reconnecting = false;

    const epoch = this.connectionEpoch;

    this.pool = new SimplePool(this.poolOptions());

    const filter = this.cb.buildFilter();
    if (!filter) {
      this.log('[BridgePool] No subscription filter (no paired phones) — skipping subscription');
      this.cb.onStatus?.('disconnected', 'No paired phones');
      return;
    }

    try {
      this.subscription = this.pool.subscribeMany(this.relayUrls, filter, {
        ...(this.flatAuthSigner() ? { onauth: this.flatAuthSigner() } : {}),
        onevent: (event) => {
          if (epoch !== this.connectionEpoch) { return; } // superseded subscription
          this.cb.onEvent(event);
        },
        oneose: () => {
          if (epoch !== this.connectionEpoch) { return; } // superseded subscription
          this.reconnectAttempt = 0; // reset on success
          this.log('[BridgePool] Connected to relays, subscription active');
          this.cb.onStatus?.('connected');
        },
        onclose: (reasons) => {
          if (epoch !== this.connectionEpoch) {
            this.log(`[BridgePool] Ignoring close of superseded subscription (epoch ${epoch}): ${JSON.stringify(reasons)}`);
            return;
          }
          this.log(`[BridgePool] Relay subscription closed: ${JSON.stringify(reasons)}`);
          this.cb.onStatus?.('disconnected', 'Relay connection lost — reconnecting');
          this.scheduleReconnect();
        },
      });
    } catch (err) {
      this.log(`[BridgePool] Failed to connect to relays: ${err}`);
      this.cb.onStatus?.('error', String(err));
      this.scheduleReconnect();
    }
  }

  /** Schedule a reconnection attempt with exponential backoff (2s→30s cap) + jitter. */
  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) { return; }
    const base = Math.min(
      this.reconnectBaseMs * Math.pow(2, this.reconnectAttempt),
      this.reconnectMaxMs,
    );
    const delay = base + Math.floor(this.random() * base * BridgePool.RECONNECT_JITTER_FRACTION);
    this.reconnectAttempt++;
    this.log(`[BridgePool] Scheduling reconnect attempt ${this.reconnectAttempt} in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.disposed) {
        this.connect();
      }
    }, delay);
  }

  disconnect(): void {
    // Orphan the live subscription's callbacks before tearing it down. Anything
    // they report from here on is our own teardown, not a connection we lost.
    this.connectionEpoch++;
    const wasConnected = this.isConnected();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.subscription) {
      this.subscription.close();
      this.subscription = null;
    }
    if (this.pool) {
      this.pool.destroy();
      this.pool = null;
    }
    if (wasConnected && !this.reconnecting) {
      this.cb.onStatus?.('disconnected');
    }
  }

  /** Permanently shut down — prevents reconnection attempts after host shutdown. */
  dispose(): void {
    this.disposed = true;
    this.disconnect();
  }

  // --- Runtime relay list management ---

  /**
   * Has connect() ever been called (and dispose() not)? The zero-phone connect
   * leaves `subscription === null` ("skipping subscription"), so isConnected()
   * is false there — but the pool IS live and must react to filter/relay
   * changes. CDX-061: gating on isConnected() made the zero-phone state
   * terminal — the first phone pairing into a zero-phone `run` never got a
   * subscription and the bridge was deaf until restarted.
   */
  private isStarted(): boolean {
    return this.pool !== null && !this.disposed;
  }

  /** Replace the relay list. Re-subscribes under a new epoch when started. */
  setRelays(urls: string[]): void {
    this.relayUrls = [...urls];
    if (this.isStarted()) {
      this.connect(); // reconnect with new relays
    }
  }

  addRelay(url: string): void {
    if (this.relayUrls.includes(url)) { return; }
    this.setRelays([...this.relayUrls, url]);
  }

  removeRelay(url: string): void {
    if (!this.relayUrls.includes(url)) { return; }
    this.setRelays(this.relayUrls.filter((u) => u !== url));
  }

  /**
   * Re-subscribe under a new epoch with a freshly built filter — call after
   * anything that changes buildFilter()'s output (a phone paired/unpaired).
   * The subscription being deliberately replaced never surfaces as a
   * disconnect (the epoch guard above).
   *
   * CDX-061: this must work from the zero-phone "skipping subscription" state
   * too (started pool, no live subscription) — that state is exactly what a
   * first pairing has to heal. Gated on isStarted(), NOT isConnected(): a
   * pool that skipped subscribing has `subscription === null` and the old
   * isConnected() gate made the deaf state permanent.
   */
  resubscribe(): void {
    if (this.isStarted()) {
      this.connect();
    }
  }

  // --- Publishing / extra subscriptions (used by publisher.ts and the pairing window) ---

  /**
   * Publish an event to every relay. One promise per relay, in relay-list
   * order. `onauth` matters here too, not just on subscribe: a relay that
   * requires auth to WRITE rejects the first publish with `auth-required:
   * ...`, and nostr-tools only retries that publish (after completing the
   * AUTH round-trip) when `onauth` is passed to THIS call — see the
   * `flatAuthSigner()` doc comment above for the general mechanism.
   */
  publish(event: NostrEvent): Promise<string>[] {
    if (!this.pool) { return []; }
    const auth = this.flatAuthSigner();
    return this.pool.publish(this.relayUrls, event, auth ? { onauth: auth } : undefined);
  }

  /** A publish landed on at least one relay — the link works, reset backoff. */
  notePublishSuccess(): void {
    this.reconnectAttempt = 0;
  }

  /**
   * Open an additional subscription on the current pool (e.g. the authorless
   * pairing-window filter from ingest.ts). Creates a pool if none exists yet
   * (first-ever pairing has zero phones, so connect() never made one). Not
   * epoch-guarded and not auto-reconnected — the caller owns its lifecycle,
   * and disconnect() tears it down along with the pool.
   */
  openSubscription(
    filter: Filter,
    params: {
      onevent: (event: NostrEvent) => void;
      oneose?: () => void;
      onclose?: (reasons: unknown) => void;
    },
  ): SubscriptionHandle {
    if (!this.pool) {
      this.pool = new SimplePool(this.poolOptions());
    }
    return this.pool.subscribeMany(this.relayUrls, filter, {
      ...(this.flatAuthSigner() ? { onauth: this.flatAuthSigner() } : {}),
      ...params,
    });
  }

  private log(msg: string): void {
    this.cb.log?.(msg);
  }
}
