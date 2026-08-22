/**
 * CDB-036/CDB-037 regression tests, ported from
 * codedeck-bridge-vscode/src/__tests__/nostrRelay.connection.test.ts.
 *
 * The old bug: the status bar flapped between "N phones" and "offline" every
 * 2 seconds after a second phone was paired. Pairing widens the `authors`
 * filter, so the bridge re-subscribes. `connect()` tears the live subscription
 * down, and nostr-tools fires that subscription's `onclose` SYNCHRONOUSLY from
 * `pool.destroy()`. Without the connection-epoch guard the handler reads its
 * own teardown as a dropped connection: it reports 'disconnected' AND schedules
 * a reconnect, which 2s later tears down the subscription that had just come
 * up — a self-sustaining loop (`oneose` reset `reconnectAttempt`, so the
 * backoff never grew past the 2s floor).
 *
 * These tests pin both halves: a deliberate re-subscribe is silent, a genuine
 * drop still reports and recovers. They fail if the epoch guard is removed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { buildCommandsFilter } from '../nostr/ingest';

const hoisted = vi.hoisted(() => ({
  /** Every subscription handed out by the mock pool, oldest first. */
  subs: [] as Array<{ params: any; closed: boolean }>,
  /** Constructor options of every SimplePool the BridgePool created (CDX-055). */
  ctorOpts: [] as Array<Record<string, unknown> | undefined>,
}));

vi.mock('nostr-tools/pool', () => {
  class SimplePool {
    private open: Array<{ params: any; closed: boolean }> = [];

    constructor(opts?: Record<string, unknown>) {
      hoisted.ctorOpts.push(opts);
    }

    subscribeMany(_relays: string[], _filter: unknown, params: any) {
      const rec = { params, closed: false };
      this.open.push(rec);
      hoisted.subs.push(rec);
      return {
        // Mirrors nostr-tools: awaits `allOpened` before closing, so this lands
        // on a later microtask — after destroy() has already run.
        close: async (reason = 'closed by caller') => {
          await Promise.resolve();
          if (rec.closed) { return; }
          rec.closed = true;
          rec.params.onclose?.([reason]);
        },
      };
    }

    /** relay.close() -> closeAllSubscriptions() -> sub.onclose() — all synchronous. */
    destroy() {
      for (const rec of this.open) {
        if (rec.closed) { continue; }
        rec.closed = true;
        rec.params.onclose?.(['relay connection closed by us']);
      }
      this.open = [];
    }

    publish() { return [Promise.resolve('ok')]; }
    close() { /* no-op */ }
  }
  return { SimplePool };
});

const { BridgePool } = await import('../nostr/pool');

const phonePubkey = () => getPublicKey(generateSecretKey());

const RELAYS = ['wss://relay.primal.net', 'wss://nos.lol', 'wss://relay2.descendant.io'];

let pool: InstanceType<typeof BridgePool>;
let statuses: string[];
let phones: string[];

const makePool = (initialPhones: string[]) => {
  const bridgePubkey = getPublicKey(generateSecretKey());
  phones = initialPhones;
  statuses = [];
  pool = new BridgePool(
    { relays: RELAYS, random: () => 0 }, // no jitter — deterministic timers
    {
      buildFilter: () =>
        phones.length === 0
          ? null
          : buildCommandsFilter({ bridgePubkey, phonePubkeys: phones, since: 0 }),
      onEvent: () => { /* not under test */ },
      onStatus: (status) => statuses.push(status),
      log: () => { /* silence */ },
    },
  );
  return pool;
};

const latestSub = () => hoisted.subs[hoisted.subs.length - 1]!;

beforeEach(() => {
  vi.useFakeTimers();
  hoisted.subs.length = 0;
  hoisted.ctorOpts.length = 0;
});

afterEach(() => {
  pool?.dispose();
  vi.useRealTimers();
});

describe('BridgePool connection status (CDB-036/CDB-037)', () => {
  it('pairing a second phone does not report a disconnect or start a reconnect loop', () => {
    makePool([phonePubkey()]).connect();
    latestSub().params.oneose();
    expect(statuses).toEqual(['connected']);

    // The second phone pairs: the authors filter widens, so the bridge re-subscribes.
    phones = [...phones, phonePubkey()];
    pool.resubscribe();

    // The subscription we tore down on purpose must not surface as a lost connection.
    expect(statuses).toEqual(['connected']);
    expect(hoisted.subs).toHaveLength(2);

    latestSub().params.oneose();
    expect(statuses).toEqual(['connected', 'connected']);

    // No reconnect was scheduled — the flap loop is what created extra subscriptions.
    vi.advanceTimersByTime(60_000);
    expect(hoisted.subs).toHaveLength(2);
    expect(statuses).toEqual(['connected', 'connected']);
  });

  it('a genuine relay drop still reports disconnected and reconnects', () => {
    makePool([phonePubkey()]).connect();
    latestSub().params.oneose();
    statuses.length = 0;

    // The live subscription dies on its own — not a teardown we asked for.
    latestSub().params.onclose(['relay connection closed']);
    expect(statuses).toEqual(['disconnected']);

    vi.advanceTimersByTime(2_000);
    expect(hoisted.subs).toHaveLength(2);

    latestSub().params.oneose();
    expect(statuses).toEqual(['disconnected', 'connected']);
  });

  it('changing the relay list re-subscribes silently', () => {
    makePool([phonePubkey()]).connect();
    latestSub().params.oneose();
    statuses.length = 0;

    pool.setRelays(['wss://relay.damus.io']);

    expect(statuses).toEqual([]);
    expect(hoisted.subs).toHaveLength(2);
  });

  it('addRelay/removeRelay re-subscribe under a new epoch without a status flap', () => {
    makePool([phonePubkey()]).connect();
    latestSub().params.oneose();
    statuses.length = 0;

    pool.addRelay('wss://relay.damus.io');
    expect(pool.relays).toContain('wss://relay.damus.io');
    expect(hoisted.subs).toHaveLength(2);

    pool.removeRelay('wss://relay.damus.io');
    expect(pool.relays).not.toContain('wss://relay.damus.io');
    expect(hoisted.subs).toHaveLength(3);

    // No-ops when the url is already present/absent.
    pool.addRelay(RELAYS[0]!);
    pool.removeRelay('wss://never-added.example');
    expect(hoisted.subs).toHaveLength(3);

    expect(statuses).toEqual([]);
  });

  it('CDX-061: pairing the FIRST phone into a zero-phone pool opens the subscription', () => {
    // `codedeck-bridge run` with no pairings: connect() finds no filter and
    // skips subscribing — the process stays alive serving the pairing window.
    makePool([]).connect();
    expect(hoisted.subs).toHaveLength(0);
    expect(statuses).toEqual(['disconnected']); // "No paired phones"

    // The first phone pairs into that same process (the CDX-038 pairing
    // window). Pre-fix, resubscribe() was gated on isConnected() — false with
    // no subscription — so the bridge stayed deaf until restarted.
    phones.push(phonePubkey());
    pool.resubscribe();

    expect(hoisted.subs).toHaveLength(1);
    latestSub().params.oneose();
    expect(statuses).toEqual(['disconnected', 'connected']);

    // The healed subscription is a first-class one: a genuine drop reconnects.
    latestSub().params.onclose(['relay connection closed']);
    vi.advanceTimersByTime(2_000);
    expect(hoisted.subs).toHaveLength(2);
  });

  it('CDX-061: unpairing the last phone returns to no-subscription without a reconnect loop', () => {
    makePool([phonePubkey()]).connect();
    latestSub().params.oneose();
    expect(statuses).toEqual(['connected']);

    phones.length = 0;
    pool.resubscribe();
    expect(statuses).toEqual(['connected', 'disconnected']); // zero-phone state again

    // Terminal but healthy: nothing schedules reconnects against a null filter.
    vi.advanceTimersByTime(120_000);
    expect(hoisted.subs).toHaveLength(1);
  });

  it('CDX-061: resubscribe before connect() and after dispose() stays a no-op', () => {
    makePool([phonePubkey()]);
    pool.resubscribe(); // never started — nothing to rebuild
    expect(hoisted.subs).toHaveLength(0);

    pool.connect();
    latestSub().params.oneose();
    pool.dispose();
    pool.resubscribe(); // disposed — must not resurrect the pool
    expect(hoisted.subs).toHaveLength(1);
  });

  it('CDX-055: every SimplePool is built with idle-close neutralized (the ~58s teardown loop)', () => {
    // nostr-tools 2.24.1: the <forced-ping> keepalive decrements the relay's
    // ongoingOperations without ever incrementing it, so every 29s ping arms
    // the 20s idleTimeout close of a relay that still holds our live REQ —
    // "relay connection closed by us" every ~52-58s, forever. idleTimeout: 0
    // cannot disable it (falsy check keeps the 20s default); the fix pins the
    // maximum delay setTimeout honors. Anything above 2^31-1 would fire the
    // idle close IMMEDIATELY, so the exact bound matters on both sides.
    makePool([phonePubkey()]).connect();
    latestSub().params.oneose();

    // Re-subscribes must carry it too…
    pool.resubscribe();
    // …and so must the pool that openSubscription creates for the first-ever
    // pairing window (zero phones — connect() never built one).
    pool.dispose();
    makePool([]).openSubscription!(
      { kinds: [30500] },
      { onevent: () => { /* not under test */ } },
    );
    expect(hoisted.ctorOpts.length).toBeGreaterThanOrEqual(3);
    for (const opts of hoisted.ctorOpts) {
      expect(opts?.enablePing).toBe(true);
      expect(opts?.enableReconnect).toBe(true);
      expect(opts?.idleTimeout).toBe(0x7fffffff);
    }
  });

  it('reconnect backoff grows exponentially and caps at 30s', () => {
    makePool([phonePubkey()]).connect();
    latestSub().params.oneose();
    statuses.length = 0;

    // Drop repeatedly WITHOUT an eose in between — attempt counter never resets.
    const dropAndWait = (expectedDelay: number) => {
      const before = hoisted.subs.length;
      latestSub().params.onclose(['relay connection closed']);
      vi.advanceTimersByTime(expectedDelay - 1);
      expect(hoisted.subs).toHaveLength(before); // not yet
      vi.advanceTimersByTime(1);
      expect(hoisted.subs).toHaveLength(before + 1); // reconnected
    };

    dropAndWait(2_000);
    dropAndWait(4_000);
    dropAndWait(8_000);
    dropAndWait(16_000);
    dropAndWait(30_000); // capped
    dropAndWait(30_000); // stays capped

    // EOSE resets the attempt counter back to the 2s floor.
    latestSub().params.oneose();
    dropAndWait(2_000);
  });
});
