/**
 * CDX-020 regression tests — the phone counterpart of the bridge's
 * `packages/core/src/__tests__/pool.connection.test.ts` (CDX-055).
 *
 * The historical bug (nostr-tools <= 2.24.1) hit the phone HARDER than the
 * bridge, because the phone opens more subscriptions on one pool:
 *
 * - `AbstractRelay.pingpong()` chooses its keepalive by feature-detecting the
 *   socket — `this.ws.ping && this.ws.once ? waitForPingPong() : waitForDummyReq()`.
 *   Only Node's `ws` package has those; the Android WebView's `WebSocket` is the
 *   browser API and has NEITHER, so the phone always takes the dummy-REQ path.
 *   The "no .ping()/.once()" case below pins exactly that.
 * - Each `<forced-ping>` REQ was excluded from `ongoingOperations` on the way in
 *   but decremented it on the way out, so every 29s ping silently dropped the
 *   count while the real REQs were live. At 0 the 20s `idleTimeout` armed and
 *   `relay.close()` killed every subscription with "relay connection closed by
 *   us" — inbound dead, while `publish()` kept working because `ensureRelay`
 *   rebuilds a socket that carries no REQ.
 *
 * nostr-tools FIXED the `<forced-ping>` accounting mismatch in 2.24.2
 * (nbd-wtf/nostr-tools#539); this workspace's lockfile is on 2.24.3, so a live
 * REQ now keeps `ongoingOperations > 0` and the idle close never arms for a
 * subscription we still want. The `idleTimeout: 0x7fffffff` pin in
 * `poolOptions.ts` therefore stands as regression insurance against an upstream
 * re-break (and still matters for the profile pool, which runs without
 * `enablePing` for unrelated reasons). These tests drive the REAL nostr-tools
 * against a browser-shaped socket on fake timers: the first proves the upstream
 * fix holds for our pinned version, the rest prove the pin itself works and a
 * genuine drop still surfaces. The source scan fails if a new pool site is
 * added that bypasses `poolOptions.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IDLE_CLOSE_DISABLED_MS,
  profilePoolOptions,
  transportPoolOptions,
} from '../poolOptions';

// --- A browser/WebView-shaped WebSocket: no .ping(), no .once() ---------------

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  /** Subscription ids the relay currently holds a REQ for. */
  reqs = new Set<string>();
  onopen: (() => void) | null = null;
  onclose: ((ev: { message?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    void Promise.resolve().then(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(data: string): void {
    const msg = JSON.parse(data) as [string, string, ...unknown[]];
    if (msg[0] === 'REQ') {
      this.reqs.add(msg[1]);
      void Promise.resolve().then(() => this.onmessage?.({ data: JSON.stringify(['EOSE', msg[1]]) }));
    } else if (msg[0] === 'CLOSE') {
      this.reqs.delete(msg[1]);
    }
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ message: 'closed' });
  }
}

const RELAYS = ['wss://relay.primal.net', 'wss://relay.damus.io'];

/** `AbstractSimplePool.relays` is `protected` in the .d.ts but is the only
 *  honest witness of whether nostr-tools dropped a relay on its own. */
const relayCount = (pool: unknown): number =>
  (pool as { relays: Map<string, unknown> }).relays.size;

/** The phone's three per-class command filters (core/services/nostrClient.ts). */
const COMMAND_FILTERS = [{ kinds: [30515] }, { kinds: [4516] }, { kinds: [24515] }];

/** Subscribe exactly like PhoneNostrClient.connect() and report what survives. */
async function runIdleSoak(
  options: Record<string, unknown>,
  soakMs: number,
): Promise<{ closes: number; liveSockets: number; openReqs: number; relaysInPool: number }> {
  const { SimplePool, useWebSocketImplementation } = await vi.importActual<
    typeof import('nostr-tools/pool')
  >('nostr-tools/pool');
  useWebSocketImplementation(FakeWebSocket);

  const pool = new SimplePool(options as never);
  let closes = 0;
  for (const filter of COMMAND_FILTERS) {
    pool.subscribe(RELAYS, filter, {
      onevent: () => {},
      onclose: () => { closes++; },
    });
  }
  await vi.advanceTimersByTimeAsync(1);
  await vi.advanceTimersByTimeAsync(soakMs);

  const live = FakeWebSocket.instances.filter((s) => s.readyState === FakeWebSocket.OPEN);
  return {
    closes,
    liveSockets: live.length,
    openReqs: live.reduce((n, s) => n + s.reqs.size, 0),
    relaysInPool: relayCount(pool),
  };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('phone SimplePool options (CDX-020)', () => {
  it('every pool-creation site pins idle-close to the 2^31-1 sentinel', () => {
    // The exact bound matters on BOTH sides: `idleTimeout: 0` is falsy so
    // AbstractSimplePool keeps its 20s default, and anything above 2^31-1
    // overflows setTimeout and fires the idle close IMMEDIATELY.
    expect(IDLE_CLOSE_DISABLED_MS).toBe(0x7fffffff);
    expect(transportPoolOptions().idleTimeout).toBe(0x7fffffff);
    expect(profilePoolOptions().idleTimeout).toBe(0x7fffffff);
  });

  it('the transport pool keeps pings on and pool-level reconnect off', () => {
    // enablePing: a socket that genuinely dies must be detected, not rot.
    // enableReconnect: the connection FSM owns reconnect policy, so a dying
    // subscription has to surface as ONE onClose it can back off against.
    expect(transportPoolOptions()).toEqual({
      enablePing: true,
      enableReconnect: false,
      idleTimeout: 0x7fffffff,
    });
  });

  it('no phone source file constructs a SimplePool outside poolOptions.ts', () => {
    const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== '__tests__') walk(full);
        } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
          files.push(full);
        }
      }
    };
    walk(srcDir);
    expect(files.length).toBeGreaterThan(10); // sanity: the scan sees the tree

    const sites = files.filter((f) => /new\s+SimplePool\s*\(/.test(readFileSync(f, 'utf8')));
    expect(sites.length).toBeGreaterThan(0);
    for (const file of sites) {
      // Every construction must take its options from the shared module, so a
      // new pool site cannot silently reintroduce the 20s idle close. The
      // *PoolOptions(...) call may take a simple (no-nested-parens) argument
      // — e.g. transportPoolOptions(automaticallyAuth) for NIP-42 — but must
      // still be the sole content of the SimplePool(...) call: nothing here
      // may construct options any other way.
      expect(readFileSync(file, 'utf8'), `${file} must build options via poolOptions.ts`)
        .toMatch(/new\s+SimplePool\s*\(\s*\w*[Pp]oolOptions\([^()]*\)\s*\)/);
    }
  });
});

describe('nostr-tools idle-close on a WebView socket (CDX-020)', () => {
  it('the WebView socket has neither .ping() nor .once(), so pingpong takes the dummy-REQ path', () => {
    // This is the whole reason the phone shares the bridge's bug: nostr-tools
    // picks waitForDummyReq() whenever the socket lacks Node's ws extensions,
    // and the browser WebSocket API has no ping frame and no emitter.
    const socket = new FakeWebSocket('wss://relay.primal.net');
    expect((socket as unknown as { ping?: unknown }).ping).toBeUndefined();
    expect((socket as unknown as { once?: unknown }).once).toBeUndefined();
  });

  it('nostr-tools 2.24.2+ no longer idle-closes a WebView-socket pool that holds live REQs', async () => {
    // The <=2.24.1 bug: 3 command subscriptions × one silent ongoingOperations
    // decrement per 29s <forced-ping> = 87s to reach 0, + the 20s idleTimeout =
    // the relay self-destructing 107s after connecting ("inbound dead while
    // publishes still land"). nbd-wtf/nostr-tools#539 fixed the accounting in
    // 2.24.2, so with `enablePing` on but WITHOUT the idleTimeout sentinel,
    // nothing dies across that same 107s window. A downgrade below 2.24.2 flips
    // every assertion here back and fails loudly.
    const soak = await runIdleSoak({ enablePing: true, enableReconnect: false }, 107_000);
    expect(soak.closes).toBe(0);
    expect(soak.liveSockets).toBe(RELAYS.length);
    expect(soak.openReqs).toBe(RELAYS.length * COMMAND_FILTERS.length);
    expect(soak.relaysInPool).toBe(RELAYS.length);
  });

  it('POST-FIX: the same pool holds every REQ through an hour of pure idle', async () => {
    const after = await runIdleSoak(transportPoolOptions() as unknown as Record<string, unknown>, 3_600_000);
    expect(after.closes).toBe(0);
    expect(after.liveSockets).toBe(RELAYS.length);
    // Each of the 2 relays still carries all 3 command REQs.
    expect(after.openReqs).toBe(RELAYS.length * COMMAND_FILTERS.length);
    expect(after.relaysInPool).toBe(RELAYS.length);
  });

  it('POST-FIX: a socket that genuinely dies still surfaces exactly one close per subscription', async () => {
    // Neutralizing the idle close must not neutralize real drops: the FSM's
    // reconnect path depends on onClose still firing when the relay goes away.
    const { SimplePool, useWebSocketImplementation } = await vi.importActual<
      typeof import('nostr-tools/pool')
    >('nostr-tools/pool');
    useWebSocketImplementation(FakeWebSocket);

    const pool = new SimplePool(transportPoolOptions() as never);
    let closes = 0;
    for (const filter of COMMAND_FILTERS) {
      pool.subscribe(RELAYS, filter, { onevent: () => {}, onclose: () => { closes++; } });
    }
    await vi.advanceTimersByTimeAsync(1);
    expect(closes).toBe(0);

    for (const socket of FakeWebSocket.instances) socket.close();
    await vi.advanceTimersByTimeAsync(1);

    expect(closes).toBe(COMMAND_FILTERS.length);
    expect(relayCount(pool)).toBe(0);
  });
});
