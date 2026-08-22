/**
 * SimplePool constructor options for EVERY pool the phone creates — one place,
 * so the transport pool and the profile-fetch pool can never drift apart.
 *
 * CDX-020 (phone) / CDX-055 (bridge): nostr-tools 2.24.1 tears its own relay
 * down on a timer, and the phone is hit HARDER than the bridge because it opens
 * more subscriptions per relay.
 *
 * 1. With `enablePing`, `AbstractRelay.pingpong()` picks its keepalive by
 *    feature-detecting the socket:
 *      `this.ws && this.ws.ping && this.ws.once ? waitForPingPong() : waitForDummyReq()`
 *    Only Node's `ws` package exposes `.ping()`/`.once()`. The Android WebView's
 *    global `WebSocket` is the browser API — no ping frame, no emitter — so the
 *    phone ALWAYS takes `waitForDummyReq()`, exactly like the bridge.
 * 2. `waitForDummyReq()` opens a `<forced-ping>` REQ every 29s. `subscribe()`
 *    EXCLUDES that label from the relay's `ongoingOperations` counter, but
 *    `Subscription.close()` decrements it unconditionally. So every ping
 *    silently drops the count by one while our real REQs are still live.
 * 3. When the count reaches 0, `scheduleIdleClose()` arms `idleTimeout` and
 *    `relay.close()` fires: every subscription dies with "relay connection
 *    closed by us", and the relay is dropped from the pool's map.
 *
 * On the phone that lands as a HARD deadline after every (re)connect: the
 * client opens 3 command subscriptions (30515/4516/24515) plus the DM (1059)
 * and Marmot subscriptions on the SAME pool, so the relay self-destructs
 * `subscriptions × 29s + 20s` after connecting — measured at 107s for the three
 * command subs alone, ~165s with DM + Marmot. Publishing keeps working
 * throughout (`publish` → `ensureRelay` rebuilds a socket that carries NO REQ),
 * which is precisely the "outbound fine, inbound dead" shape CDX-020 reported.
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
 * `IDLE_CLOSE_DISABLED_MS` — the two are deliberately the same fix.
 */
import type { SimplePool } from 'nostr-tools/pool';

export const IDLE_CLOSE_DISABLED_MS = 0x7fffffff;

/**
 * The published .d.ts narrows SimplePool's ctor to
 * `Pick<…, 'enablePing' | 'enableReconnect'>`, but the runtime spreads
 * `...options` into `AbstractSimplePool`, which honors `idleTimeout` — hence
 * the widened return type instead of a cast.
 */
export type PhonePoolOptions = ConstructorParameters<typeof SimplePool>[0] & {
  idleTimeout: number;
};

/**
 * Options for the app transport pool: pings on (a genuinely dead socket must be
 * detected, not silently rot), pool-level auto-reconnect OFF (reconnect policy
 * belongs to the connection FSM, which needs ONE honest `onClose` to back off
 * against), idle-close neutralized.
 */
export function transportPoolOptions(): PhonePoolOptions {
  return {
    enablePing: true,
    enableReconnect: false,
    idleTimeout: IDLE_CLOSE_DISABLED_MS,
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
