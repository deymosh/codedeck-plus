/**
 * SimplePool constructor options for EVERY pool the phone creates — one place,
 * so the transport pool and the profile-fetch pool can never drift apart.
 *
 * CDX-020 (phone) / CDX-055 (bridge). The historical defect (nostr-tools
 * <= 2.24.1): the pool tore its own relay down on a timer, and the phone was
 * hit HARDER than the bridge because it opens more subscriptions per relay.
 *
 * 1. With `enablePing`, `AbstractRelay.pingpong()` picks its keepalive by
 *    feature-detecting the socket:
 *      `this.ws && this.ws.ping && this.ws.once ? waitForPingPong() : waitForDummyReq()`
 *    Only Node's `ws` package exposes `.ping()`/`.once()`. The Android WebView's
 *    global `WebSocket` is the browser API — no ping frame, no emitter — so the
 *    phone ALWAYS takes `waitForDummyReq()`, exactly like the bridge.
 * 2. `waitForDummyReq()` opens a `<forced-ping>` REQ every 29s. `subscribe()`
 *    EXCLUDED that label from the relay's `ongoingOperations` counter, but
 *    `Subscription.close()` decremented it unconditionally — so every ping
 *    silently dropped the count by one while the real REQs were still live.
 * 3. When the count reached 0, `scheduleIdleClose()` armed `idleTimeout` and
 *    `relay.close()` fired: every subscription died with "relay connection
 *    closed by us", and the relay left the pool's map. On the phone that was a
 *    HARD deadline after every (re)connect — measured at 107s for the three
 *    command subs (30515/4516/24515) alone — while `publish()` kept working
 *    (`ensureRelay` rebuilds a socket that carries NO REQ): the "outbound fine,
 *    inbound dead" shape CDX-020 reported.
 *
 * nostr-tools FIXED the `<forced-ping>` accounting in 2.24.2
 * (nbd-wtf/nostr-tools#539); this workspace is pinned to 2.24.3, so step 2 no
 * longer decrements and the idle close no longer arms for a live subscription.
 * The `idleTimeout` pin below is kept as regression insurance against an
 * upstream re-break AND because `profilePoolOptions()` runs without
 * `enablePing` and wants the same guarantee regardless (see its own note).
 * `pool.connection.test.ts` runs the real nostr-tools and fails loudly if a
 * downgrade below 2.24.2 brings the bug back.
 *
 * `idleTimeout: 0` cannot disable it — `AbstractSimplePool`'s constructor does
 * `if (opts.idleTimeout) this.idleTimeout = opts.idleTimeout`, so 0 is falsy and
 * the 20s default survives. Pass the largest delay `setTimeout` honors instead
 * (2^31-1 ms ≈ 24.8 days; anything larger overflows and fires IMMEDIATELY, so
 * the exact bound matters on both sides). Nothing leaks: `transport.close()`
 * still destroys the pool, and a socket that genuinely dies is still detected
 * by `enablePing`'s 20s pong timeout → `ws.close()` → the FSM's reconnect.
 *
 * Identical constant and reasoning as `packages/core/src/nostr/pool.ts`'s
 * `IDLE_CLOSE_DISABLED_MS` — the two are deliberately the same pin.
 */
import type { SimplePool } from 'nostr-tools/pool';
import type { EventTemplate, VerifiedEvent } from 'nostr-tools/core';

export const IDLE_CLOSE_DISABLED_MS = 0x7fffffff;

/** Matches @codedeck/protocol#createRelayAuthSigner's return shape. */
export type RelayAuthProvider = (relayUrl: string) => null | ((event: EventTemplate) => Promise<VerifiedEvent>);

/**
 * The published .d.ts narrows SimplePool's ctor to
 * `Pick<…, 'enablePing' | 'enableReconnect'>`, but the runtime spreads
 * `...options` into `AbstractSimplePool`, which honors `idleTimeout` (and,
 * the same way, `automaticallyAuth` — NIP-42 relay auth, e.g. for a Haven
 * relay) — hence the widened return type instead of a cast.
 */
export type PhonePoolOptions = ConstructorParameters<typeof SimplePool>[0] & {
  idleTimeout: number;
  automaticallyAuth?: RelayAuthProvider;
};

/**
 * Options for the app transport pool: pings on (a genuinely dead socket must be
 * detected, not silently rot), pool-level auto-reconnect OFF (reconnect policy
 * belongs to the connection FSM, which needs ONE honest `onClose` to back off
 * against), idle-close neutralized.
 */
export function transportPoolOptions(automaticallyAuth?: RelayAuthProvider): PhonePoolOptions {
  return {
    enablePing: true,
    enableReconnect: false,
    idleTimeout: IDLE_CLOSE_DISABLED_MS,
    ...(automaticallyAuth ? { automaticallyAuth } : {}),
  };
}

/**
 * Options for the kind-0 profile-fetch pool. It runs WITHOUT `enablePing`, so
 * the defect above cannot bite it today — the pin is here so the two phone
 * pools can never drift, and so nobody can reintroduce the bug by switching
 * pings on. Trade-off, recorded deliberately: the 20s idle close also acted as
 * a socket GC for that pool, so a profile-relay socket now stays warm between
 * fetches (cheaper: no re-handshake per DM name lookup) and a socket that hangs
 * WITHOUT a close frame is no longer swept — the fetcher's own per-round
 * timeouts (8s/10s × 3 rounds) are what keep that honest.
 */
export function profilePoolOptions(): PhonePoolOptions {
  return {
    enableReconnect: false,
    idleTimeout: IDLE_CLOSE_DISABLED_MS,
  };
}
