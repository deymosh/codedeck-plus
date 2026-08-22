/**
 * CDX-005 remainder — the pairing-window flow: URL builder, token validation
 * (bad token / window closed / expiry), and the successful pair round-trip
 * (persist + resubscribe + pair-ack + heartbeat + host presentation lifecycle).
 *
 * Commands enter as REAL encrypted kind-4515 events through the real
 * CommandIngest's authorless pairing path — the same route an unpaired phone
 * takes in production.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import type { NostrEvent } from 'nostr-tools/core';
import { FakeSdkFacade } from '@codedeck/testkit';
import {
  COMMAND_KIND,
  RESPONSE_KIND,
  SESSION_LIST_KIND,
  encodePhoneToBridge,
  decodeBridgeToPhone,
  type BridgeToPhoneMessage,
  type PairedPhone,
} from '@codedeck/protocol';
import type { BridgeHost, PairingHandle, PairingPayload } from '../host';
import { encryptTo, decryptFrom, npubFromHex } from '../nostr/crypto';
import type { BridgePoolCallbacks, BridgePoolOptions } from '../nostr/pool';
import { buildPairingUrl } from '../pairing';
import { BridgeCore, type BridgeCorePool, type PairingCloseReason } from '../bridge';

const bridgeSecret = generateSecretKey();
const bridgePubkey = getPublicKey(bridgeSecret);
const phoneSecret = generateSecretKey();
const phonePubkey = getPublicKey(phoneSecret);

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface OpenSub {
  filter: Filter;
  params: { onevent: (event: NostrEvent) => void; oneose?: () => void; onclose?: (r: unknown) => void };
  closed: boolean;
}

class PairingFakePool implements BridgeCorePool {
  readonly relays = ['wss://fake.relay'];
  published: NostrEvent[] = [];
  resubscribes = 0;
  disposed = false;
  subs: OpenSub[] = [];

  constructor(
    readonly options: BridgePoolOptions,
    readonly cb: BridgePoolCallbacks,
  ) {}

  connect(): void {}
  dispose(): void { this.disposed = true; }
  resubscribe(): void { this.resubscribes++; }
  publish(event: NostrEvent): Promise<string>[] {
    this.published.push(event);
    return [Promise.resolve('ok')];
  }
  notePublishSuccess(): void {}

  openSubscription(filter: Filter, params: OpenSub['params']): { close(): void } {
    const sub: OpenSub = { filter, params, closed: false };
    this.subs.push(sub);
    params.oneose?.();
    return { close: () => { sub.closed = true; } };
  }

  /** The currently open (last) pairing subscription. */
  get pairingSub(): OpenSub {
    const sub = this.subs.at(-1);
    if (!sub) throw new Error('no pairing subscription opened');
    return sub;
  }
}

interface Ctx {
  dir: string;
  storage: Map<string, string>;
  pool: PairingFakePool;
  core: BridgeCore;
  pairings: PairingPayload[];
  pairingCloses: number;
  notifications: Array<{ level: string; msg: string }>;
  logs: Array<{ level: string; msg: string }>;
}

const ctxs: Ctx[] = [];

afterEach(async () => {
  while (ctxs.length > 0) {
    const ctx = ctxs.pop()!;
    await ctx.core.shutdown();
    await fs.rm(ctx.dir, { recursive: true, force: true });
  }
});

async function startCore(opts: {
  paired?: boolean;
  withoutOpenSubscription?: boolean;
  /** Configure relayRegisterEndpoint/token + capture register calls. */
  relayRegister?: { fetchFn: typeof fetch };
} = {}): Promise<Ctx> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codedeck-pairing-'));
  const stateDir = path.join(dir, 'state');
  const wsRoot = path.join(dir, 'workspace');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(wsRoot, { recursive: true });

  const storage = new Map<string, string>();
  if (opts.paired) {
    storage.set('pairedPhones', JSON.stringify([
      { npub: npubFromHex(phonePubkey), pubkeyHex: phonePubkey, label: 'phone', pairedAt: 'now' },
    ]));
  }

  const ctx = {
    dir, storage, pairings: [] as PairingPayload[], pairingCloses: 0,
    notifications: [] as Array<{ level: string; msg: string }>,
    logs: [] as Array<{ level: string; msg: string }>,
  } as Ctx;

  const host: BridgeHost = {
    config: {
      machineName: 'pairing-machine',
      host: 'cli',
      relays: ['wss://fake.relay', 'wss://backup.relay'],
      workspaceRoots: [wsRoot],
      ...(opts.relayRegister
        ? {
            relayRegisterEndpoint: 'https://relay2.example/api/register-agent',
            relayRegisterToken: 'admin-secret',
          }
        : {}),
    },
    storage: {
      get: async (k) => storage.get(k),
      set: async (k, v) => { storage.set(k, v); },
      delete: async (k) => { storage.delete(k); },
    },
    sessionStateDir: () => stateDir,
    log: (level, msg) => { ctx.logs.push({ level, msg }); },
    notify: (level, msg) => { ctx.notifications.push({ level, msg }); },
    presentPairing: (payload: PairingPayload): PairingHandle => {
      ctx.pairings.push(payload);
      return { close: () => { ctx.pairingCloses++; } };
    },
    onShutdown: () => {},
  };

  let pool: PairingFakePool | null = null;
  const core = await BridgeCore.start({
    host,
    secretKey: bridgeSecret,
    facade: new FakeSdkFacade(),
    poolFactory: (options, cb) => {
      pool = new PairingFakePool(options, cb);
      if (opts.withoutOpenSubscription) {
        (pool as unknown as { openSubscription?: unknown }).openSubscription = undefined;
      }
      return pool;
    },
    heartbeatIntervalMs: 0,
    gitPollIntervalMs: 0,
    ...(opts.relayRegister ? { fetchFn: opts.relayRegister.fetchFn } : {}),
  });

  ctx.pool = pool!;
  ctx.core = core;
  ctxs.push(ctx);
  return ctx;
}

/** A real encrypted pair-request event, as the phone app would publish it. */
function pairRequestEvent(token: string, opts: { label?: string; secret?: Uint8Array } = {}): NostrEvent {
  const secret = opts.secret ?? phoneSecret;
  const pubkey = getPublicKey(secret);
  return finalizeEvent(
    {
      kind: COMMAND_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', bridgePubkey]],
      content: encryptTo(
        secret,
        bridgePubkey,
        encodePhoneToBridge({
          type: 'pair-request',
          npub: npubFromHex(pubkey),
          pubkeyHex: pubkey,
          label: opts.label ?? 'Test Phone',
          token,
        }),
      ),
    },
    secret,
  );
}

/** Decode everything the bridge published to `secret`'s owner. */
function publishedTo(ctx: Ctx, secret: Uint8Array): Array<{ kind: number; msg: BridgeToPhoneMessage }> {
  const pubkey = getPublicKey(secret);
  return ctx.pool.published
    .filter((e) => e.tags.some(([n, v]) => n === 'p' && v === pubkey))
    .map((event) => {
      const decoded = decodeBridgeToPhone(decryptFrom(secret, bridgePubkey, event.content));
      if (!decoded.ok) throw new Error(`published event failed codec validation: ${decoded.error}`);
      return { kind: event.kind, msg: decoded.msg };
    });
}

function acksTo(ctx: Ctx, secret: Uint8Array) {
  return publishedTo(ctx, secret)
    .map((p) => p.msg)
    .filter((m): m is Extract<BridgeToPhoneMessage, { type: 'pair-ack' }> => m.type === 'pair-ack');
}

describe('buildPairingUrl', () => {
  it('builds the codedeck://pair URL with encoded relays, machine, and token', () => {
    const { url, displayUrl } = buildPairingUrl({
      npub: 'npub1abc',
      relays: ['wss://a.example', 'wss://b.example/path?x=1'],
      machine: 'my laptop',
      token: 'tok/en',
    });
    expect(url).toBe(
      'codedeck://pair?npub=npub1abc&relays=wss%3A%2F%2Fa.example,wss%3A%2F%2Fb.example%2Fpath%3Fx%3D1&machine=my%20laptop&token=tok%2Fen',
    );
    expect(displayUrl).toBe(url); // no mesh → nothing to redact
  });

  it('bundles the mesh manual-join pair (netid + meshadmin) in the QR url (CDX-028)', () => {
    const { url, displayUrl } = buildPairingUrl({
      npub: 'npub1abc',
      relays: ['wss://a.example'],
      machine: 'm',
      token: 't',
      meshAdmin: 'npub1admin',
      netid: 'a237c978',
    });
    expect(url).toContain('&netid=a237c978&meshadmin=npub1admin');
    // Both mesh params are PUBLIC (no bearer secret since nvpn 4.1.x) —
    // nothing to redact anymore.
    expect(displayUrl).toBe(url);
  });

  it('omits the mesh params unless BOTH netid and meshAdmin are set', () => {
    const partial = buildPairingUrl({
      npub: 'npub1abc', relays: ['wss://a.example'], machine: 'm', token: 't',
      netid: 'a237c978',
    });
    expect(partial.url).not.toContain('netid=');
    expect(partial.url).not.toContain('meshadmin=');
  });
});

describe('BridgeCore pairing window', () => {
  it('openPairingWindow presents the URL, opens an authorless subscription, and reports expiry', async () => {
    const ctx = await startCore();
    const before = Date.now();
    const info = ctx.core.openPairingWindow({ durationMs: 60_000 });

    expect(ctx.core.pairingWindowOpen).toBe(true);
    expect(info.url).toContain(`token=${info.token}`);
    expect(info.url).toContain(ctx.core.keypair.npub);
    expect(info.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);

    // Host got exactly the QR payload.
    expect(ctx.pairings).toHaveLength(1);
    expect(ctx.pairings[0]!.url).toBe(info.url);
    expect(ctx.pairings[0]!.expiresAt).toEqual(info.expiresAt);

    // The pairing filter is authorless (the whole point) and addressed to us.
    const filter = ctx.pool.pairingSub.filter;
    expect(filter.authors).toBeUndefined();
    expect(filter.kinds).toEqual([COMMAND_KIND]);
    expect(filter['#p']).toEqual([bridgePubkey]);
  });

  it('pairs a phone end-to-end: token accepted → persisted + resubscribed + acked + heartbeat', async () => {
    const ctx = await startCore();
    const pairedCb: PairedPhone[] = [];
    const closedCb: PairingCloseReason[] = [];
    const info = ctx.core.openPairingWindow({
      durationMs: 60_000,
      onPaired: (p) => pairedCb.push(p),
      onClosed: (r) => closedCb.push(r),
    });
    const resubsBefore = ctx.pool.resubscribes;

    ctx.pool.pairingSub.params.onevent(pairRequestEvent(info.token, { label: 'My Pixel' }));
    await waitFor(() => acksTo(ctx, phoneSecret).length > 0);

    // Ack is ok=true, rides the stored response kind, and carries the bridge's
    // relays + host so a manual-npub pairing learns where this bridge lives.
    const acks = acksTo(ctx, phoneSecret);
    expect(acks).toEqual([{
      type: 'pair-ack',
      machine: 'pairing-machine',
      ok: true,
      relays: ['wss://fake.relay', 'wss://backup.relay'],
      host: 'cli',
    }]);
    expect(publishedTo(ctx, phoneSecret).find((p) => p.msg.type === 'pair-ack')!.kind).toBe(RESPONSE_KIND);

    // Paired set: in-memory + persisted; identity from the EVENT author.
    expect(ctx.core.pairedPhones()).toHaveLength(1);
    const phone = ctx.core.pairedPhones()[0]!;
    expect(phone.pubkeyHex).toBe(phonePubkey);
    expect(phone.npub).toBe(npubFromHex(phonePubkey));
    expect(phone.label).toBe('My Pixel');
    const persisted = JSON.parse(ctx.storage.get('pairedPhones')!) as PairedPhone[];
    expect(persisted.map((p) => p.pubkeyHex)).toEqual([phonePubkey]);

    // Main filter resubscribed; greeting heartbeat published; window closed.
    expect(ctx.pool.resubscribes).toBeGreaterThan(resubsBefore);
    expect(publishedTo(ctx, phoneSecret).some((p) => p.kind === SESSION_LIST_KIND)).toBe(true);
    expect(ctx.core.pairingWindowOpen).toBe(false);
    expect(ctx.pool.pairingSub.closed).toBe(true);
    expect(ctx.pairingCloses).toBe(1);
    expect(pairedCb.map((p) => p.pubkeyHex)).toEqual([phonePubkey]);
    expect(closedCb).toEqual(['paired']);
    expect(ctx.notifications.some((n) => n.msg.includes('My Pixel'))).toBe(true);
  });

  it('rejects a bad token: pair-ack ok=false bad-token, nothing paired, window stays open', async () => {
    const ctx = await startCore();
    ctx.core.openPairingWindow({ durationMs: 60_000, token: 'right-token' });

    ctx.pool.pairingSub.params.onevent(pairRequestEvent('wrong-token'));
    await waitFor(() => acksTo(ctx, phoneSecret).length > 0);

    expect(acksTo(ctx, phoneSecret)).toEqual([
      { type: 'pair-ack', machine: 'pairing-machine', ok: false, reason: 'bad-token' },
    ]);
    expect(ctx.core.pairedPhones()).toHaveLength(0);
    expect(ctx.storage.get('pairedPhones')).toBeUndefined();
    expect(ctx.core.pairingWindowOpen).toBe(true); // one bad guess doesn't burn the window
  });

  it('CDX-013: negative pair-acks are budgeted — a bad-token flood stops being amplified', async () => {
    const ctx = await startCore();
    ctx.core.openPairingWindow({ durationMs: 60_000, token: 'right-token' });

    // 8 distinct bad requests from distinct phones (unique event ids).
    for (let i = 0; i < 8; i++) {
      ctx.pool.pairingSub.params.onevent(
        pairRequestEvent(`wrong-${i}`, { secret: generateSecretKey() }),
      );
    }
    // Give the async publishes a tick.
    await new Promise((r) => setTimeout(r, 50));

    const nacks = ctx.pool.published.length;
    expect(nacks).toBeLessThanOrEqual(5);
    expect(ctx.core.pairingWindowOpen).toBe(true);

    // The RIGHT token still pairs — the budget only silences rejections.
    ctx.pool.pairingSub.params.onevent(pairRequestEvent('right-token'));
    await waitFor(() => ctx.core.pairedPhones().length === 1);
  });

  it('CDX-028: openPairingWindow({mesh}) folds netid + meshadmin into the QR url', async () => {
    const ctx = await startCore();
    const info = ctx.core.openPairingWindow({
      durationMs: 60_000,
      mesh: { adminDeviceId: 'npub1adminadmin', netid: 'a237c978' },
    });
    expect(info.url).toContain('&netid=a237c978&meshadmin=npub1adminadmin');
    expect(ctx.pairings).toHaveLength(1);
    const payload = ctx.pairings[0]!;
    expect(payload.url).toBe(info.url); // QR content stays complete
    // Both params are public (no bearer secret since nvpn 4.1.x) — displayUrl
    // is the full url.
    expect(payload.displayUrl).toBe(info.url);
  });

  it('rejects an in-flight pair-request after the window closed: window-closed ack', async () => {
    const ctx = await startCore();
    const info = ctx.core.openPairingWindow({ durationMs: 60_000 });
    const sub = ctx.pool.pairingSub;
    ctx.core.closePairingWindow();
    expect(ctx.pairingCloses).toBe(1);

    // The event was already in flight when we tore the subscription down.
    sub.params.onevent(pairRequestEvent(info.token));
    await waitFor(() => acksTo(ctx, phoneSecret).length > 0);

    expect(acksTo(ctx, phoneSecret)).toEqual([
      { type: 'pair-ack', machine: 'pairing-machine', ok: false, reason: 'window-closed' },
    ]);
    expect(ctx.core.pairedPhones()).toHaveLength(0);
  });

  it('expires the window after durationMs: closed + host presentation revoked', async () => {
    const ctx = await startCore();
    const closedCb: PairingCloseReason[] = [];
    ctx.core.openPairingWindow({ durationMs: 30, onClosed: (r) => closedCb.push(r) });
    expect(ctx.core.pairingWindowOpen).toBe(true);

    await waitFor(() => !ctx.core.pairingWindowOpen);
    expect(closedCb).toEqual(['expired']);
    expect(ctx.pool.pairingSub.closed).toBe(true);
    expect(ctx.pairingCloses).toBe(1);
  });

  it('re-opening replaces the prior window (old token dies with it)', async () => {
    const ctx = await startCore();
    const first = ctx.core.openPairingWindow({ durationMs: 60_000 });
    const firstSub = ctx.pool.pairingSub;
    const second = ctx.core.openPairingWindow({ durationMs: 60_000 });

    expect(second.token).not.toBe(first.token);
    expect(firstSub.closed).toBe(true);
    expect(ctx.pairingCloses).toBe(1); // first presentation revoked
    expect(ctx.pool.subs).toHaveLength(2);

    // The FIRST window's token is no longer accepted.
    ctx.pool.pairingSub.params.onevent(pairRequestEvent(first.token));
    await waitFor(() => acksTo(ctx, phoneSecret).length > 0);
    expect(acksTo(ctx, phoneSecret)[0]!).toMatchObject({ ok: false, reason: 'bad-token' });
  });

  it('a replayed pair-request event id is deduped (single pair, single ack)', async () => {
    const ctx = await startCore();
    const info = ctx.core.openPairingWindow({ durationMs: 60_000 });
    const event = pairRequestEvent(info.token);
    const sub = ctx.pool.pairingSub;
    sub.params.onevent(event);
    sub.params.onevent(event); // relay replay
    await waitFor(() => acksTo(ctx, phoneSecret).length > 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(acksTo(ctx, phoneSecret).filter((a) => a.ok)).toHaveLength(1);
    expect(ctx.core.pairedPhones()).toHaveLength(1);
  });

  it('shutdown closes an open pairing window', async () => {
    const ctx = await startCore();
    const closedCb: PairingCloseReason[] = [];
    ctx.core.openPairingWindow({ durationMs: 60_000, onClosed: (r) => closedCb.push(r) });
    await ctx.core.shutdown();
    expect(ctx.core.pairingWindowOpen).toBe(false);
    expect(closedCb).toEqual(['closed']);
    expect(ctx.pairingCloses).toBe(1);
  });

  it('throws an actionable error when the pool cannot open extra subscriptions', async () => {
    const ctx = await startCore({ withoutOpenSubscription: true });
    expect(() => ctx.core.openPairingWindow()).toThrow(/openSubscription/);
  });
});

/**
 * CDX-039: the device log showed `Pairing window opened for 600s`, then 49s
 * later a bare `[BridgeCore] Pairing subscription closed: [...]` debug line and
 * nothing else — the window was still nominally open but could no longer hear
 * anything, which from the operator's seat looks exactly like "the phone can't
 * reach the relay". openSubscription() is deliberately not auto-reconnected, so
 * the window has to repair itself and say so.
 */
describe('BridgeCore pairing window — surviving a dropped subscription (CDX-039)', () => {
  const dropReasons = [{ relay: 'wss://fake.relay', reason: 'relay connection closed by us' }];

  it('warns at operator level and re-subscribes for the rest of the window', async () => {
    const ctx = await startCore();
    ctx.core.openPairingWindow({ durationMs: 600_000 });
    expect(ctx.pool.subs).toHaveLength(1);

    vi.useFakeTimers();
    try {
      ctx.pool.pairingSub.params.onclose?.(dropReasons);

      // Not a debug line any more: warn level, and it names the consequence.
      const warning = ctx.logs.find((l) => l.level === 'warn' && /Pairing subscription dropped/.test(l.msg));
      expect(warning).toBeDefined();
      expect(warning!.msg).toMatch(/UNREACHABLE/);
      expect(warning!.msg).toMatch(/will not be heard/);
      expect(warning!.msg).toContain('relay connection closed by us');

      // The window stays open, and the subscription comes back on its own.
      expect(ctx.core.pairingWindowOpen).toBe(true);
      expect(ctx.pool.subs).toHaveLength(1);
      vi.advanceTimersByTime(2_000);
      expect(ctx.pool.subs).toHaveLength(2);
      expect(ctx.logs.some((l) => /Pairing subscription re-established/.test(l.msg))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a phone that pairs through the RESTORED subscription is still accepted', async () => {
    const ctx = await startCore();
    const info = ctx.core.openPairingWindow({ durationMs: 600_000 });

    vi.useFakeTimers();
    try {
      ctx.pool.pairingSub.params.onclose?.(dropReasons);
      vi.advanceTimersByTime(2_000);
    } finally {
      vi.useRealTimers();
    }
    expect(ctx.pool.subs).toHaveLength(2);

    // The replacement carries the SAME token and the SAME `since`, so a request
    // sent during the outage is not lost to a moved window.
    expect(ctx.pool.pairingSub.filter).toEqual(ctx.pool.subs[0]!.filter);
    ctx.pool.pairingSub.params.onevent(pairRequestEvent(info.token));
    await waitFor(() => acksTo(ctx, phoneSecret).length > 0);
    expect(acksTo(ctx, phoneSecret).some((a) => a.ok)).toBe(true);
    expect(ctx.core.pairedPhones()).toHaveLength(1);
  });

  it('repeated drops coalesce into ONE pending re-subscribe, not a storm', async () => {
    const ctx = await startCore();
    ctx.core.openPairingWindow({ durationMs: 600_000 });

    vi.useFakeTimers();
    try {
      ctx.pool.pairingSub.params.onclose?.(dropReasons);
      ctx.pool.pairingSub.params.onclose?.(dropReasons);
      ctx.pool.pairingSub.params.onclose?.(dropReasons);
      vi.advanceTimersByTime(2_000);
      expect(ctx.pool.subs).toHaveLength(2); // one replacement, not three
    } finally {
      vi.useRealTimers();
    }
  });

  it('our own teardown is not mistaken for a drop: no warning, no resurrection', async () => {
    const ctx = await startCore();
    ctx.core.openPairingWindow({ durationMs: 600_000 });
    const superseded = ctx.pool.pairingSub;

    ctx.core.closePairingWindow();
    vi.useFakeTimers();
    try {
      // The pool closes the subscription on the way out, and nostr-tools calls
      // onclose for it — that is us, not the relays.
      superseded.params.onclose?.(dropReasons);
      vi.advanceTimersByTime(5_000);
      expect(ctx.pool.subs).toHaveLength(1);
      expect(ctx.logs.some((l) => l.level === 'warn' && /Pairing subscription dropped/.test(l.msg))).toBe(false);
      expect(ctx.core.pairingWindowOpen).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a SUPERSEDED window cannot re-subscribe over the current one (epoch guard)', async () => {
    const ctx = await startCore();
    ctx.core.openPairingWindow({ durationMs: 600_000 });
    const first = ctx.pool.pairingSub;

    ctx.core.openPairingWindow({ durationMs: 600_000 }); // replaces window #1
    expect(ctx.pool.subs).toHaveLength(2);

    vi.useFakeTimers();
    try {
      first.params.onclose?.(dropReasons); // window #1's late callback
      vi.advanceTimersByTime(5_000);
      expect(ctx.pool.subs).toHaveLength(2); // window #2 untouched
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('BridgeCore pairing — relay auto-register (CDX-005 remainder)', () => {
  it('POSTs the freshly paired pubkey to relayRegisterEndpoint with the Bearer token', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const ctx = await startCore({
      relayRegister: {
        fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
          calls.push({ url: String(url), init });
          return new Response('{}', { status: 201 });
        }) as typeof fetch,
      },
    });

    const info = ctx.core.openPairingWindow({ durationMs: 60_000 });
    ctx.pool.pairingSub.params.onevent(pairRequestEvent(info.token));
    await waitFor(() => calls.length === 1);

    expect(calls[0]!.url).toBe('https://relay2.example/api/register-agent');
    expect((calls[0]!.init?.headers as Record<string, string>)['Authorization']).toBe('Bearer admin-secret');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ pubkey: phonePubkey });
    // Pairing itself succeeded independently.
    expect(ctx.core.pairedPhones()).toHaveLength(1);
    expect(acksTo(ctx, phoneSecret)[0]!.ok).toBe(true);
    // Success is silent (log only) — no warn notification.
    expect(ctx.notifications.filter((n) => n.level === 'warn')).toHaveLength(0);
  });

  it('registration failure logs + notifies but NEVER blocks or fails the pairing', async () => {
    const ctx = await startCore({
      relayRegister: {
        fetchFn: (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch,
      },
    });

    const info = ctx.core.openPairingWindow({ durationMs: 60_000 });
    ctx.pool.pairingSub.params.onevent(pairRequestEvent(info.token, { label: 'My Pixel' }));
    await waitFor(() => ctx.notifications.some((n) => n.level === 'warn'));

    // Pairing fully succeeded despite the failed registration.
    expect(ctx.core.pairedPhones()).toHaveLength(1);
    expect(acksTo(ctx, phoneSecret)[0]!.ok).toBe(true);
    const warn = ctx.notifications.find((n) => n.level === 'warn')!;
    expect(warn.msg).toContain('My Pixel');
    expect(warn.msg).toContain('ECONNREFUSED');
    // The admin token is a secret — never notified.
    expect(warn.msg).not.toContain('admin-secret');
  });

  it('no endpoint configured → no fetch at all', async () => {
    const ctx = await startCore();
    const info = ctx.core.openPairingWindow({ durationMs: 60_000 });
    ctx.pool.pairingSub.params.onevent(pairRequestEvent(info.token));
    await waitFor(() => ctx.core.pairedPhones().length === 1);
    expect(ctx.notifications.filter((n) => n.level === 'warn')).toHaveLength(0);
  });
});
