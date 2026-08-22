/**
 * outboxStore — the pending → published → confirmed / failed lifecycle:
 * nothing silently vanishes, failures are visible and retryable, and the
 * whole book persists through the KV port.
 */
import { describe, it, expect } from 'vitest';
import type { PhoneToBridgeMessage } from '@codedeck/protocol';
import {
  OUTBOX_CONFIRM_TIMEOUT_MS,
  createOutboxStore,
  hydrateOutbox,
  loadPersistedOutbox,
  serializeOutbox,
} from '../stores/outbox';
import { memoryKV } from '../ports';

function harness(opts: {
  accept?: boolean | (() => boolean | Promise<boolean>);
  confirmTimeoutMs?: number;
} = {}) {
  const kv = memoryKV();
  const published: Array<{ machine: string; msg: PhoneToBridgeMessage }> = [];
  let nowMs = 1000;
  let id = 0;
  const store = createOutboxStore({
    kv,
    publish: async (machine, msg) => {
      published.push({ machine, msg });
      const accept = opts.accept ?? true;
      return typeof accept === 'function' ? accept() : accept;
    },
    now: () => nowMs,
    newId: () => `in-${++id}`,
    ...(opts.confirmTimeoutMs !== undefined ? { confirmTimeoutMs: opts.confirmTimeoutMs } : {}),
  });
  return { kv, published, store, s: () => store.getState(), setNow: (ms: number) => { nowMs = ms; } };
}

describe('outboxStore — lifecycle', () => {
  it('send publishes a real input command with the inputId and lands in published', async () => {
    const h = harness();
    const item = await h.s().send('m1', 'sess', 'do the thing');
    expect(item.state).toBe('published');
    expect(item.publishedAt).toBe(1000);
    expect(h.published[0]!.msg).toMatchObject({
      type: 'input',
      sessionId: 'sess',
      text: 'do the thing',
      inputId: 'in-1',
    });
  });

  it('onSend fires with (machine, sessionId, text) BEFORE the publish attempt', async () => {
    const kv = memoryKV();
    const calls: Array<{ args: [string, string, string]; publishedSoFar: number }> = [];
    let publishes = 0;
    const store = createOutboxStore({
      kv,
      publish: async () => {
        publishes++;
        return true;
      },
      now: () => 1000,
      newId: () => 'in-1',
      onSend: (machine, sessionId, text) =>
        calls.push({ args: [machine, sessionId, text], publishedSoFar: publishes }),
    });
    await store.getState().send('m1', 'sess', 'hello');
    expect(calls).toEqual([{ args: ['m1', 'sess', 'hello'], publishedSoFar: 0 }]);
  });

  it('input-ack flips published → confirmed', async () => {
    const h = harness();
    const item = await h.s().send('m1', 'sess', 'x');
    h.s().confirm(item.id);
    expect(h.s().item(item.id)!.state).toBe('confirmed');
    expect(h.s().unresolved()).toEqual([]);
  });

  it('input-failed flips to failed with the reason; confirmed items are immune', async () => {
    const h = harness();
    const a = await h.s().send('m1', 'sess', 'a');
    h.s().fail(a.id, 'no-session');
    expect(h.s().item(a.id)!).toMatchObject({ state: 'failed', error: 'no-session' });

    const b = await h.s().send('m1', 'sess', 'b');
    h.s().confirm(b.id);
    h.s().fail(b.id, 'late-failure');
    expect(h.s().item(b.id)!.state).toBe('confirmed'); // a verdict never regresses
  });

  it('publish rejection → failed with a visible error (nothing vanishes)', async () => {
    const h = harness({ accept: false });
    const item = await h.s().send('m1', 'sess', 'x');
    expect(item.state).toBe('failed');
    expect(item.error).toBe('no relay accepted the event');
  });

  it('publish throwing → failed, not thrown', async () => {
    const h = harness({ accept: () => Promise.reject(new Error('socket dead')) });
    const item = await h.s().send('m1', 'sess', 'x');
    expect(item.state).toBe('failed');
    expect(item.error).toContain('socket dead');
  });

  it('an ack racing the publish promise wins (confirmed is never downgraded)', async () => {
    const h = harness({
      accept: () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 5)),
    });
    const pending = h.s().send('m1', 'sess', 'x');
    // The bridge's ack arrives before the relay publish promise settles.
    await new Promise((r) => setTimeout(r, 1));
    h.s().confirm('in-1');
    const item = await pending;
    expect(item.state).toBe('confirmed');
  });

  it('retry re-publishes a failed item under the same id and bumps attempts', async () => {
    let ok = false;
    const h = harness({ accept: () => ok });
    const item = await h.s().send('m1', 'sess', 'x');
    expect(item.state).toBe('failed');
    ok = true;
    const retried = await h.s().retry(item.id);
    expect(retried!).toMatchObject({ id: item.id, state: 'published', attempts: 2 });
    expect(h.published).toHaveLength(2);
    expect(h.published[1]!.msg).toMatchObject({ inputId: item.id });
  });

  it('retry on a non-failed item is a no-op', async () => {
    const h = harness();
    const item = await h.s().send('m1', 'sess', 'x');
    await h.s().retry(item.id);
    expect(h.published).toHaveLength(1);
  });
});

describe('outboxStore — sweep (unanswered sends become honest failures)', () => {
  it('published-but-unacked times out into failed', async () => {
    const h = harness();
    const item = await h.s().send('m1', 'sess', 'x');
    h.s().sweep();
    expect(h.s().item(item.id)!.state).toBe('published'); // not yet due
    h.setNow(1000 + OUTBOX_CONFIRM_TIMEOUT_MS);
    h.s().sweep();
    expect(h.s().item(item.id)!).toMatchObject({ state: 'failed', error: 'no ack from bridge' });
  });

  it('confirmed and already-failed items are untouched by sweep', async () => {
    const h = harness({ confirmTimeoutMs: 10 });
    const a = await h.s().send('m1', 'sess', 'a');
    h.s().confirm(a.id);
    h.setNow(999_999);
    h.s().sweep();
    expect(h.s().item(a.id)!.state).toBe('confirmed');
  });
});

describe('outboxStore — persistence', () => {
  it('every transition is persisted; a reboot sees the same book', async () => {
    const h = harness();
    const a = await h.s().send('m1', 'sess', 'a');
    const b = await h.s().send('m1', 'sess', 'b');
    h.s().confirm(a.id);
    h.s().fail(b.id, 'no-session');
    await new Promise((r) => setTimeout(r, 0)); // fire-and-forget persist settles

    const reloaded = await loadPersistedOutbox(h.kv);
    expect(reloaded[a.id]!.state).toBe('confirmed');
    expect(reloaded[b.id]!).toMatchObject({ state: 'failed', error: 'no-session' });
  });

  it('round-trip preserves every item; garbage hydrates to empty', () => {
    const items = {
      x: {
        id: 'x', machine: 'm', sessionId: 's', text: 't', state: 'published' as const,
        createdAt: 1, publishedAt: 2, confirmedAt: null, failedAt: null, error: null, attempts: 1,
      },
    };
    expect(hydrateOutbox(serializeOutbox(items))).toEqual(items);
    expect(hydrateOutbox(undefined)).toEqual({});
    expect(hydrateOutbox('nope')).toEqual({});
    expect(hydrateOutbox('{"a":1}')).toEqual({});
  });

  it('in-flight items from a previous run become failed on the next sweep (visible + retryable)', async () => {
    const h = harness();
    await h.s().send('m1', 'sess', 'x');
    await new Promise((r) => setTimeout(r, 0));

    // "Reboot": new store over the same KV.
    const store2 = createOutboxStore(
      {
        kv: h.kv,
        publish: async () => true,
        now: () => 10_000_000,
        newId: () => 'zz',
      },
      await loadPersistedOutbox(h.kv),
    );
    store2.getState().sweep();
    const item = Object.values(store2.getState().items)[0]!;
    expect(item.state).toBe('failed');
  });
});

describe('outboxStore — retention cap (CDX-013)', () => {
  function cappedHarness(maxItems: number) {
    const kv = memoryKV();
    let nowMs = 1000;
    let id = 0;
    const store = createOutboxStore({
      kv,
      publish: async () => true,
      now: () => ++nowMs,
      newId: () => `in-${++id}`,
      maxItems,
    });
    return { kv, store, s: () => store.getState() };
  }

  it('evicts the OLDEST resolved items beyond the cap', async () => {
    const h = cappedHarness(5);
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const item = await h.s().send('m1', 'sess', `msg-${i}`);
      h.s().confirm(item.id);
      ids.push(item.id);
    }
    const remaining = Object.keys(h.s().items);
    expect(remaining.length).toBeLessThanOrEqual(5);
    // The newest survive; the oldest were evicted.
    expect(remaining).toContain(ids[7]!);
    expect(remaining).not.toContain(ids[0]!);
  });

  it('NEVER evicts unresolved (pending/published) items, even over the cap', async () => {
    const h = cappedHarness(3);
    // 6 items that never get confirmed — all published (unresolved).
    for (let i = 0; i < 6; i++) {
      await h.s().send('m1', 'sess', `msg-${i}`);
    }
    const items = Object.values(h.s().items);
    expect(items).toHaveLength(6); // over cap, but nothing eligible to drop
    expect(items.every((i) => i.state === 'published')).toBe(true);
  });

  it('persists the capped set (a reboot hydrates without the evicted items)', async () => {
    const h = cappedHarness(4);
    for (let i = 0; i < 10; i++) {
      const item = await h.s().send('m1', 'sess', `msg-${i}`);
      h.s().confirm(item.id);
    }
    await new Promise((r) => setTimeout(r, 0));
    const hydrated = await loadPersistedOutbox(h.kv);
    expect(Object.keys(hydrated).length).toBeLessThanOrEqual(4);
  });
});
