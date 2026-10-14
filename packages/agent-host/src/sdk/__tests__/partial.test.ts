/**
 * PartialCoalescer: how streamed deltas become the few `partial` events a
 * relay sends — the interval, the offsets that chain, and the text a
 * completing entry or an ended turn drops rather than sends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PARTIAL_INTERVAL_MS, PartialCoalescer, type PartialUpdate } from '../partial';

function collector(intervalMs?: number) {
  const updates: PartialUpdate[] = [];
  const coalescer = new PartialCoalescer((u) => updates.push(u), intervalMs);
  return { updates, coalescer };
}

describe('PartialCoalescer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('holds a part and sends it once on the timer, not on the delta', () => {
    const { updates, coalescer } = collector();
    coalescer.delta({ key: 'm:0', entryType: 'text', text: 'Hel' });
    coalescer.delta({ key: 'm:0', entryType: 'text', text: 'lo' });
    expect(updates).toEqual([]);
    vi.advanceTimersByTime(PARTIAL_INTERVAL_MS);
    // One event for the whole interval's text, not one per delta.
    expect(updates).toEqual([{ key: 'm:0', entryType: 'text', offset: 0, text: 'Hello' }]);
  });

  it('carries only the text since the last event, with chaining offsets', () => {
    const { updates, coalescer } = collector();
    coalescer.delta({ key: 'm:0', entryType: 'text', text: 'abc' });
    vi.advanceTimersByTime(PARTIAL_INTERVAL_MS);
    coalescer.delta({ key: 'm:0', entryType: 'text', text: 'de' });
    vi.advanceTimersByTime(PARTIAL_INTERVAL_MS);
    expect(updates.map((u) => [u.offset, u.text])).toEqual([[0, 'abc'], [3, 'de']]);
  });

  it('counts offsets in UTF-16 code units, so a non-BMP character is two', () => {
    const { updates, coalescer } = collector();
    coalescer.delta({ key: 'm:0', entryType: 'text', text: '😀' }); // one code point, two units
    vi.advanceTimersByTime(PARTIAL_INTERVAL_MS);
    coalescer.delta({ key: 'm:0', entryType: 'text', text: 'x' });
    vi.advanceTimersByTime(PARTIAL_INTERVAL_MS);
    expect(updates.map((u) => [u.offset, u.text.length])).toEqual([[0, 2], [2, 1]]);
  });

  it('sends nothing for a part that finishes inside one interval', () => {
    const { updates, coalescer } = collector();
    coalescer.delta({ key: 'm:0', entryType: 'text', text: 'short' });
    vi.advanceTimersByTime(PARTIAL_INTERVAL_MS - 50);
    coalescer.complete('m:0');
    vi.advanceTimersByTime(1_000);
    expect(updates).toEqual([]);
  });

  it('drops unsent text when the completing entry is delivered, never flushes it', () => {
    const { updates, coalescer } = collector();
    coalescer.delta({ key: 'm:0', entryType: 'text', text: 'sent' });
    vi.advanceTimersByTime(PARTIAL_INTERVAL_MS);
    coalescer.delta({ key: 'm:0', entryType: 'text', text: ' unsent' });
    vi.advanceTimersByTime(100);
    coalescer.complete('m:0');
    vi.advanceTimersByTime(1_000);
    expect(updates).toHaveLength(1);
  });

  it('drops every part and its timer at the end of a turn', () => {
    const { updates, coalescer } = collector();
    coalescer.delta({ key: 'm:0', entryType: 'text', text: 'a' });
    coalescer.delta({ key: 'm:1', entryType: 'text', text: 'b' });
    vi.advanceTimersByTime(100);
    coalescer.reset();
    vi.advanceTimersByTime(1_000);
    expect(updates).toEqual([]);
    // A new turn starts its parts from offset zero again.
    coalescer.delta({ key: 'm:2', entryType: 'text', text: 'c' });
    vi.advanceTimersByTime(PARTIAL_INTERVAL_MS);
    expect(updates).toEqual([{ key: 'm:2', entryType: 'text', offset: 0, text: 'c' }]);
  });

  it('flushes every waiting part on one session timer', () => {
    const { updates, coalescer } = collector();
    coalescer.delta({ key: 'm:0', entryType: 'text', text: 'a' });
    coalescer.delta({ key: 'm:0', entryType: 'text', text: 'b' });
    coalescer.delta({ key: 'm:1', entryType: 'text', text: 'c' });
    vi.advanceTimersByTime(PARTIAL_INTERVAL_MS);
    expect(updates).toEqual([
      { key: 'm:0', entryType: 'text', offset: 0, text: 'ab' },
      { key: 'm:1', entryType: 'text', offset: 0, text: 'c' },
    ]);
  });

  it('carries a subagent through, when a caller streams one', () => {
    const { updates, coalescer } = collector();
    coalescer.delta({ key: 'm:0', entryType: 'text', text: 'x', subagent: { parentCallId: 'c1' } });
    vi.advanceTimersByTime(PARTIAL_INTERVAL_MS);
    expect(updates[0]!.subagent).toEqual({ parentCallId: 'c1' });
  });
});
