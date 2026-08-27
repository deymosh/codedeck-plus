// @vitest-environment jsdom
/**
 * CDX-063 — own messages must not vanish between input-ack and the SDK echo.
 *
 * The bridge acks an input BEFORE any transcript entry exists (bridge.ts
 * onInput acks straight after runner.sendInput; the user entry is only
 * authored when the SDK echoes the message, on droppable ephemeral 24515).
 * Pre-fix the TranscriptView hid the outbox row on `state === 'confirmed'`,
 * so a dropped echo made the sent message disappear.
 *
 * Coverage rule under test, through the REAL pipeline (encrypted ingest into
 * a real PhoneCore, exactly the function TranscriptView renders from):
 * - ack arrives, echo never does → the row stays;
 * - the echo arrives → the row swaps for the entry, no duplication;
 * - a sync backfill covering it → the row hides the same way;
 * - the bridge-appended emit-session-meta comment still covers (prefix+comment,
 *   never a bare prefix);
 * - two identical sends need two echoes (pairing/dedupe).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { finalizeEvent } from 'nostr-tools/pure';
import {
  LIVE_KIND,
  encodeBridgeToPhone,
  type BridgeToPhoneMessage,
  type OutputEntry,
} from '@codedeck/protocol';
import { createPhoneCore, type PhoneCore } from '../../../core/createPhoneCore';
import { encryptTo, generateKeypair, type Keypair } from '../../../core/crypto';
import { memoryKV, type PhoneTransport } from '../../../core/ports';
import type { OutboxItem } from '../../../core/stores/outbox';
import { buildDisplayEntries } from '../displayEntries';
import {
  coveredOutboxIds,
  entryCovers,
  OUTBOX_ECHO_GRACE_MS,
  visibleOutboxItems,
} from '../outboxCoverage';
import { OutboxRow } from '../rows/OutboxRow';

afterEach(cleanup);

// --- Pure coverage rules ---

const item = (id: string, text: string, createdAt: number, state: OutboxItem['state'] = 'confirmed'): OutboxItem => ({
  id,
  machine: 'm',
  sessionId: 's1',
  text,
  state,
  createdAt,
  publishedAt: null,
  confirmedAt: null,
  failedAt: null,
  error: null,
  attempts: 1,
});

describe('entryCovers — text match, meta-comment aware', () => {
  it('exact and whitespace-normalized matches cover', () => {
    expect(entryCovers('hello world', 'hello world')).toBe(true);
    expect(entryCovers('hello world\n', ' hello world ')).toBe(true);
    expect(entryCovers('a\r\nb', 'a\nb')).toBe(true);
  });

  it('the bridge-appended emit-session-meta comment covers; a bare prefix never does', () => {
    const meta =
      'fix the bug\n\n<!-- emit-session-meta: In your response, include exactly one HTML comment: <!-- session-meta: {"topic": "…"} --> -->';
    expect(entryCovers(meta, 'fix the bug')).toBe(true);
    // A LONGER different message that merely starts with the item text must
    // not cover it — otherwise an old echo could hide a newer unechoed send.
    expect(entryCovers('fix the bug please', 'fix the bug')).toBe(false);
    expect(entryCovers('', '')).toBe(false);
  });
});

describe('coveredOutboxIds — chronological pairing, one entry per item', () => {
  it('two identical sends need two echoes; the oldest item is covered first', () => {
    const items = [item('a', 'ok', 100), item('b', 'ok', 200)];
    expect([...coveredOutboxIds(items, [{ seq: 5, content: 'ok' }])]).toEqual(['a']);
    expect([
      ...coveredOutboxIds(items, [
        { seq: 5, content: 'ok' },
        { seq: 9, content: 'ok' },
      ]),
    ].sort()).toEqual(['a', 'b']);
  });

  it('coverage is proof of delivery even for a sweep-failed item (lost ack, delivered anyway)', () => {
    const failed = item('a', 'made it', 100, 'failed');
    expect(coveredOutboxIds([failed], [{ seq: 1, content: 'made it' }]).has('a')).toBe(true);
  });

  it('CRLF + padding on BOTH sides still pairs, and a bare prefix still does not — the hoisted normalization is the same rule', () => {
    // Guards the perf hoist: normalization moved out of the inner comparison
    // and into a single pass per side, so the pairing loop now compares
    // already-normalized text. Every clause of the rule must survive that —
    // whitespace/CRLF tolerance, the meta-comment tolerance, and the bare-
    // prefix refusal — when it is `coveredOutboxIds` doing the normalizing
    // rather than `entryCovers`.
    const items = [item('a', '  fix the bug \r\n', 100), item('b', 'fix the bug please', 200)];
    const entries = [
      { seq: 1, content: 'fix the bug\r\n\r\n<!-- emit-session-meta: … -->\n' },
      { seq: 2, content: 'fix the bug entirely' }, // longer, not a comment → covers nothing
    ];
    expect([...coveredOutboxIds(items, entries)]).toEqual(['a']);
  });
});

describe('visibleOutboxItems — aging out stranded "delivered" rows', () => {
  const confirmed = (id: string, createdAt: number, confirmedAt: number): OutboxItem => ({
    ...item(id, `msg ${id}`, createdAt, 'confirmed'),
    confirmedAt,
  });

  it('without opts, every uncovered item is returned (unchanged legacy behaviour)', () => {
    const items = { a: confirmed('a', 0, 0) };
    expect(visibleOutboxItems(items, 'm', 's1', []).map((i) => i.id)).toEqual(['a']);
  });

  it('an aged-out confirmed row is dropped once the transcript is contiguous', () => {
    const items = { a: confirmed('a', 0, 1_000) };
    const out = visibleOutboxItems(items, 'm', 's1', [], {
      now: 1_000 + OUTBOX_ECHO_GRACE_MS,
      transcriptContiguous: true,
    });
    expect(out).toEqual([]);
  });

  it('a recently-confirmed row is still shown (CDX-063 window not elapsed)', () => {
    const items = { a: confirmed('a', 0, 1_000) };
    const out = visibleOutboxItems(items, 'm', 's1', [], {
      now: 1_000 + OUTBOX_ECHO_GRACE_MS - 1,
      transcriptContiguous: true,
    });
    expect(out.map((i) => i.id)).toEqual(['a']);
  });

  it('an aged confirmed row is KEPT while the transcript still has a gap (sync may deliver the echo)', () => {
    const items = { a: confirmed('a', 0, 1_000) };
    const out = visibleOutboxItems(items, 'm', 's1', [], {
      now: 1_000 + OUTBOX_ECHO_GRACE_MS * 10,
      transcriptContiguous: false,
    });
    expect(out.map((i) => i.id)).toEqual(['a']);
  });

  it('pending / published / failed rows are never aged out', () => {
    const old = 1_000;
    const now = old + OUTBOX_ECHO_GRACE_MS * 100;
    for (const state of ['pending', 'published', 'failed'] as const) {
      const items = { a: { ...item('a', 'still here', 0, state), confirmedAt: null } };
      const out = visibleOutboxItems(items, 'm', 's1', [], { now, transcriptContiguous: true });
      expect(out.map((i) => i.id), state).toEqual(['a']);
    }
  });

  it('a covered row is gone regardless of age or opts', () => {
    const items = { a: confirmed('a', 0, 1_000) };
    const echo: OutputEntry = {
      entryType: 'text',
      content: 'msg a',
      timestamp: new Date(0).toISOString(),
      metadata: { role: 'user' },
    };
    const out = visibleOutboxItems(items, 'm', 's1', [{ seq: 3, entry: echo }], {
      now: 1_000 + OUTBOX_ECHO_GRACE_MS,
      transcriptContiguous: false,
    });
    expect(out).toEqual([]);
  });
});

// --- The real pipeline: PhoneCore + encrypted ingest ---

const nullTransport: PhoneTransport = {
  subscribe: () => ({ close: () => {} }),
  publish: async () => true,
};

const userEcho = (content: string): OutputEntry => ({
  entryType: 'text',
  content,
  timestamp: new Date(0).toISOString(),
  metadata: { role: 'user' },
});

function bridgeEvent(core: PhoneCore, machine: Keypair, msg: BridgeToPhoneMessage) {
  const phonePubkey = core.identity.getState().keypair.pubkeyHex;
  return finalizeEvent(
    {
      kind: LIVE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', phonePubkey]],
      content: encryptTo(machine.secretKey, phonePubkey, encodeBridgeToPhone(msg)),
    },
    machine.secretKey,
  );
}

async function makeCore() {
  const machine = generateKeypair();
  const core = await createPhoneCore({ kv: memoryKV(), transport: nullTransport });
  core.machines.getState().registerMachine({
    pubkeyHex: machine.pubkeyHex,
    name: 'test machine',
    label: 'test',
  });
  const rows = async () => {
    await core.transcript.getState().flush();
    return visibleOutboxItems(
      core.outbox.getState().items,
      machine.pubkeyHex,
      's1',
      core.transcript.getState().entriesOf(machine.pubkeyHex, 's1'),
    );
  };
  return { core, machine, rows };
}

describe('CDX-063 through the real pipeline', () => {
  it('ack arrives, echo never does → the row STAYS (the filed vanish)', async () => {
    const { core, machine, rows } = await makeCore();
    const sent = await core.outbox.getState().send(machine.pubkeyHex, 's1', 'where did I go');
    core.api.ingest(
      bridgeEvent(core, machine, { type: 'input-ack', sessionId: 's1', inputId: sent.id }),
    );
    expect(core.outbox.getState().items[sent.id]?.state).toBe('confirmed');
    // Pre-fix: `state !== 'confirmed'` filtered this row out right here.
    expect((await rows()).map((i) => i.id)).toEqual([sent.id]);
    await core.stop();
  });

  it('the echo arrives → the row swaps for the transcript entry, no duplication', async () => {
    const { core, machine, rows } = await makeCore();
    const sent = await core.outbox.getState().send(machine.pubkeyHex, 's1', 'fix the login bug');
    core.api.ingest(
      bridgeEvent(core, machine, { type: 'input-ack', sessionId: 's1', inputId: sent.id }),
    );
    // The SDK echo carries the bridge-appended one-shot meta comment.
    core.api.ingest(
      bridgeEvent(core, machine, {
        type: 'output',
        sessionId: 's1',
        seq: 1,
        entry: userEcho(
          'fix the login bug\n\n<!-- emit-session-meta: In your response, include exactly one HTML comment -->',
        ),
      }),
    );
    expect(await rows()).toEqual([]);
    const display = buildDisplayEntries(
      core.transcript.getState().entriesOf(machine.pubkeyHex, 's1'),
    );
    expect(display.filter((d) => d.kind === 'user_message')).toHaveLength(1);
    await core.stop();
  });

  it('a sync backfill covering the message hides the row the same way', async () => {
    const { core, machine, rows } = await makeCore();
    const sent = await core.outbox.getState().send(machine.pubkeyHex, 's1', 'backfilled send');
    core.api.ingest(
      bridgeEvent(core, machine, { type: 'input-ack', sessionId: 's1', inputId: sent.id }),
    );
    expect((await rows()).map((i) => i.id)).toEqual([sent.id]);
    core.api.ingest(
      bridgeEvent(core, machine, {
        type: 'sync-chunk',
        sessionId: 's1',
        syncId: 'sync1',
        range: [1, 1],
        entries: [{ seq: 1, entry: userEcho('backfilled send') }],
      }),
    );
    expect(await rows()).toEqual([]);
    await core.stop();
  });

  it('two identical sends: one echo hides ONE row; the second echo hides the other', async () => {
    const { core, machine, rows } = await makeCore();
    const first = await core.outbox.getState().send(machine.pubkeyHex, 's1', 'go');
    const second = await core.outbox.getState().send(machine.pubkeyHex, 's1', 'go');
    for (const id of [first.id, second.id]) {
      core.api.ingest(bridgeEvent(core, machine, { type: 'input-ack', sessionId: 's1', inputId: id }));
    }
    core.api.ingest(
      bridgeEvent(core, machine, { type: 'output', sessionId: 's1', seq: 1, entry: userEcho('go') }),
    );
    expect((await rows()).map((i) => i.id)).toEqual([second.id]);
    core.api.ingest(
      bridgeEvent(core, machine, { type: 'output', sessionId: 's1', seq: 2, entry: userEcho('go') }),
    );
    expect(await rows()).toEqual([]);
    await core.stop();
  });

  it('assistant/system entries never cover — only user-role entries do', async () => {
    const { core, machine, rows } = await makeCore();
    const sent = await core.outbox.getState().send(machine.pubkeyHex, 's1', 'say hi');
    core.api.ingest(
      bridgeEvent(core, machine, { type: 'input-ack', sessionId: 's1', inputId: sent.id }),
    );
    core.api.ingest(
      bridgeEvent(core, machine, {
        type: 'output',
        sessionId: 's1',
        seq: 1,
        entry: { entryType: 'text', content: 'say hi', timestamp: new Date(0).toISOString() },
      }),
    );
    expect((await rows()).map((i) => i.id)).toEqual([sent.id]);
    await core.stop();
  });
});

describe('OutboxRow — the delivered state renders honestly', () => {
  it('a confirmed-but-uncovered row shows the text with a "delivered" status', () => {
    render(<OutboxRow item={item('x', 'still here', 1)} onRetry={() => {}} />);
    expect(screen.getByText('still here')).toBeTruthy();
    expect(screen.getByText('delivered')).toBeTruthy();
  });
});
