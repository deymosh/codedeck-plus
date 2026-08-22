/**
 * pairingStore — pairing URL parsing (incl. malformed input) and the
 * pair-request → pair-ack flow state machine.
 */
import { describe, it, expect } from 'vitest';
import { buildPairingUrl, generateKeypair } from '@codedeck/core';
import { ManualTimers } from '@codedeck/testkit';
import type { PhoneToBridgeMessage } from '@codedeck/protocol';
import {
  PAIR_ACK_TIMEOUT_MS,
  createPairingStore,
  parsePairingUrl,
  type PairingCandidate,
} from '../stores/pairing';

// A real bridge npub for URL fixtures (core is a devDependency, tests only).
const bridge = generateKeypair();

describe('parsePairingUrl', () => {
  it('parses the exact URL the bridge builder produces (round-trip with core)', () => {
    const { url } = buildPairingUrl({
      npub: bridge.npub,
      relays: ['wss://relay2.descendant.io', 'wss://relay.primal.net'],
      machine: 'my laptop (cli)',
      token: 'tok-123',
    });
    const result = parsePairingUrl(url);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parts).toMatchObject({
      npub: bridge.npub,
      pubkeyHex: bridge.pubkeyHex,
      relays: ['wss://relay2.descendant.io', 'wss://relay.primal.net'],
      machine: 'my laptop (cli)',
      token: 'tok-123',
    });
    expect(result.parts.meshAdmin).toBeUndefined();
    expect(result.parts.netid).toBeUndefined();
  });

  it('parses the mesh manual-join variant (netid + meshadmin, CDX-028)', () => {
    const { url } = buildPairingUrl({
      npub: bridge.npub,
      relays: ['wss://r.example'],
      machine: 'box',
      token: 't',
      meshAdmin: 'npub1admindevice',
      netid: 'a237c978',
    });
    const result = parsePairingUrl(url);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parts.netid).toBe('a237c978');
    expect(result.parts.meshAdmin).toBe('npub1admindevice');
  });

  it('tolerates surrounding whitespace', () => {
    const { url } = buildPairingUrl({
      npub: bridge.npub, relays: ['wss://r.example'], machine: 'box', token: 't',
    });
    expect(parsePairingUrl(`  ${url}\n`).ok).toBe(true);
  });

  const malformed: Array<[string, string, string]> = [
    ['wrong scheme', 'https://pair?npub=x&relays=y&machine=z&token=t', 'not a codedeck://pair URL'],
    ['wrong host', 'codedeck://unpair?npub=x', 'not a codedeck://pair URL'],
    ['no query', 'codedeck://pair', 'missing query parameters'],
    ['empty query', 'codedeck://pair?', 'missing npub'],
    ['missing npub', 'codedeck://pair?relays=wss%3A%2F%2Fr&machine=m&token=t', 'missing npub'],
    ['invalid npub', 'codedeck://pair?npub=npub1garbage&relays=wss%3A%2F%2Fr&machine=m&token=t', 'invalid npub'],
    ['npub is an nsec', 'codedeck://pair?npub=nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5&relays=wss%3A%2F%2Fr&machine=m&token=t', 'invalid npub'],
    ['missing token', '', 'missing token'],
    ['missing machine', '', 'missing machine name'],
    ['missing relays', '', 'missing relays'],
    ['non-ws relay', '', 'invalid relay URL: https://not-a-relay'],
    ['bad percent-encoding in relays', '', 'malformed relay list'],
  ];
  // Fill in the fixtures that need a real npub.
  malformed[7]![1] = `codedeck://pair?npub=${bridge.npub}&relays=wss%3A%2F%2Fr&machine=m`;
  malformed[8]![1] = `codedeck://pair?npub=${bridge.npub}&relays=wss%3A%2F%2Fr&token=t`;
  malformed[9]![1] = `codedeck://pair?npub=${bridge.npub}&machine=m&token=t`;
  malformed[10]![1] = `codedeck://pair?npub=${bridge.npub}&relays=https%3A%2F%2Fnot-a-relay&machine=m&token=t`;
  malformed[11]![1] = `codedeck://pair?npub=${bridge.npub}&relays=%ZZbroken&machine=m&token=t`;

  it.each(malformed)('rejects %s', (_name, url, error) => {
    const result = parsePairingUrl(url);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(error);
  });

  it('CDX-013: caps the relay list — a hostile link cannot flood settings', () => {
    const relays = Array.from({ length: 6 }, (_, i) => `wss://r${i}.example`);
    const { url } = buildPairingUrl({
      npub: bridge.npub, relays, machine: 'box', token: 't',
    });
    const result = parsePairingUrl(url);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('too many relays');

    // 5 is still fine (real bridge URLs carry 1-3).
    const ok = parsePairingUrl(buildPairingUrl({
      npub: bridge.npub, relays: relays.slice(0, 5), machine: 'box', token: 't',
    }).url);
    expect(ok.ok).toBe(true);
  });

  it('never throws on fuzzed garbage', () => {
    const garbage = [
      'codedeck://pair?=&&&==?', 'codedeck://pair????', '\u0000codedeck://pair?npub=x',
      'codedeck://pair?npub=%FF%FE&relays=,&machine=&token=', 'codedeck://pair/?npub',
    ];
    for (const g of garbage) {
      expect(() => parsePairingUrl(g)).not.toThrow();
      expect(parsePairingUrl(g).ok).toBe(false);
    }
  });
});

describe('pairing flow state machine', () => {
  function harness() {
    const sent: Array<{ machine: string; msg: PhoneToBridgeMessage }> = [];
    const candidates: PairingCandidate[] = [];
    const paired: Array<{ candidate: PairingCandidate; machineName: string }> = [];
    const logs: string[] = [];
    const phone = generateKeypair();
    const timers = new ManualTimers(); // CDX-040 deadline runs on virtual time
    const store = createPairingStore({
      onCandidate: (c) => candidates.push(c),
      send: (machine, msg) => sent.push({ machine, msg }),
      onPaired: (candidate, machineName) => paired.push({ candidate, machineName }),
      identity: () => ({ npub: phone.npub, pubkeyHex: phone.pubkeyHex }),
      timers,
      log: (m) => logs.push(m),
    });
    return { sent, candidates, paired, logs, phone, timers, store, s: () => store.getState() };
  }

  const parts = () => {
    const { url } = buildPairingUrl({
      npub: bridge.npub, relays: ['wss://r.example'], machine: 'box', token: 'tok',
    });
    const parsed = parsePairingUrl(url);
    if (!parsed.ok) throw new Error('fixture parse failed');
    return parsed.parts;
  };

  it('beginPair registers the candidate BEFORE sending the token-carrying pair-request', () => {
    const h = harness();
    h.s().beginPair(parts(), 'My Phone');
    expect(h.s().phase).toBe('awaiting-ack');
    expect(h.candidates).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.machine).toBe(bridge.pubkeyHex);
    expect(h.sent[0]!.msg).toMatchObject({
      type: 'pair-request',
      npub: h.phone.npub,
      pubkeyHex: h.phone.pubkeyHex,
      label: 'My Phone',
      token: 'tok',
    });
  });

  it('pair-ack ok → paired, onPaired carries the bridge-reported machine name', () => {
    const h = harness();
    h.s().beginPair(parts(), 'P');
    h.s().handlePairAck(bridge.pubkeyHex, { type: 'pair-ack', machine: 'real-name', ok: true });
    expect(h.s().phase).toBe('paired');
    expect(h.paired[0]!.machineName).toBe('real-name');
    expect(h.paired[0]!.candidate.relays).toEqual(['wss://r.example']);
  });

  it('the bundled mesh manual-join pair (meshadmin + netid) rides the candidate into onPaired (one-QR mesh setup, CDX-028)', () => {
    const h = harness();
    const { url } = buildPairingUrl({
      npub: bridge.npub, relays: ['wss://r.example'], machine: 'box', token: 'tok',
      meshAdmin: 'npub1admindevice', netid: 'a237c978',
    });
    const parsed = parsePairingUrl(url);
    if (!parsed.ok) throw new Error('fixture parse failed');
    h.s().beginPair(parsed.parts, 'P');
    // BOTH must survive into the candidate — the pre-CDX-028 code dropped
    // netid here, so the post-pair join could never be dispatched.
    expect(h.candidates[0]!.meshAdmin).toBe('npub1admindevice');
    expect(h.candidates[0]!.netid).toBe('a237c978');
    h.s().handlePairAck(bridge.pubkeyHex, { type: 'pair-ack', machine: 'box', ok: true });
    expect(h.paired[0]!.candidate.meshAdmin).toBe('npub1admindevice');
    expect(h.paired[0]!.candidate.netid).toBe('a237c978');
  });

  it('pair-ack !ok → failed with the reason; no onPaired', () => {
    const h = harness();
    h.s().beginPair(parts(), 'P');
    h.s().handlePairAck(bridge.pubkeyHex, { type: 'pair-ack', machine: 'box', ok: false, reason: 'bad-token' });
    expect(h.s().phase).toBe('failed');
    expect(h.s().error).toBe('bad-token');
    expect(h.paired).toEqual([]);
  });

  it('a pair-ack from the wrong pubkey or outside a flow is ignored', () => {
    const h = harness();
    h.s().handlePairAck(bridge.pubkeyHex, { type: 'pair-ack', machine: 'box', ok: true });
    expect(h.s().phase).toBe('idle');
    h.s().beginPair(parts(), 'P');
    h.s().handlePairAck('someone-else', { type: 'pair-ack', machine: 'box', ok: true });
    expect(h.s().phase).toBe('awaiting-ack');
    expect(h.paired).toEqual([]);
  });

  it('manual npub fallback validates input and reuses the same flow', () => {
    const h = harness();
    expect(h.s().beginManualPair('npub1garbage', 'tok', 'P')).toMatchObject({ ok: false, error: 'invalid npub' });
    expect(h.s().beginManualPair(bridge.npub, '   ', 'P')).toMatchObject({ ok: false, error: 'missing token' });
    expect(h.s().beginManualPair(` ${bridge.npub} `, ' tok ', 'P')).toEqual({ ok: true });
    expect(h.s().phase).toBe('awaiting-ack');
    expect(h.sent[0]!.msg).toMatchObject({ type: 'pair-request', token: 'tok' });
    h.s().handlePairAck(bridge.pubkeyHex, { type: 'pair-ack', machine: 'box', ok: true });
    expect(h.paired[0]!.machineName).toBe('box');
  });

  it('reset returns to idle from any phase', () => {
    const h = harness();
    h.s().beginPair(parts(), 'P');
    h.s().reset();
    expect(h.s()).toMatchObject({ phase: 'idle', candidate: null, error: null });
  });

  it('CDX-041: the ack settles the candidate the confirmation renders — manual pairing stops saying "(manual)"', () => {
    const h = harness();
    expect(h.s().beginManualPair(bridge.npub, 'tok', 'P')).toEqual({ ok: true });
    // Before the ack the phone genuinely does not know the name.
    expect(h.s().candidate?.machine).toBe('(manual)');

    h.s().handlePairAck(bridge.pubkeyHex, { type: 'pair-ack', machine: 'laptop', ok: true });

    // The device symptom was "Paired with (manual)." — the overlay reads
    // candidate.machine, which stayed the placeholder while the sidebar (fed
    // by onPaired) already had the real name.
    expect(h.s().candidate?.machine).toBe('laptop');
    expect(h.paired[0]!.machineName).toBe('laptop');
  });

  it('CDX-041: a nameless ack leaves the placeholder rather than blanking the confirmation', () => {
    const h = harness();
    expect(h.s().beginManualPair(bridge.npub, 'tok', 'P')).toEqual({ ok: true });
    h.s().handlePairAck(bridge.pubkeyHex, { type: 'pair-ack', machine: '', ok: true });
    expect(h.s().candidate?.machine).toBe('(manual)');
    expect(h.paired[0]!.machineName).toBe('(manual)');
  });
});

describe('pair-ack relays + host (protocol nit — manual pairing learns the bridge relays)', () => {
  function harness() {
    const paired: Array<{ candidate: PairingCandidate; machineName: string; host?: string }> = [];
    const phone = generateKeypair();
    const store = createPairingStore({
      onCandidate: () => {},
      send: () => {},
      onPaired: (candidate, machineName, host) => paired.push({ candidate, machineName, ...(host ? { host } : {}) }),
      identity: () => ({ npub: phone.npub, pubkeyHex: phone.pubkeyHex }),
      timers: new ManualTimers(),
    });
    return { paired, store, s: () => store.getState() };
  }

  it('manual-npub pairing (no relays in the URL) adopts the ack relays + host', () => {
    const h = harness();
    expect(h.s().beginManualPair(bridge.npub, 'tok', 'P')).toEqual({ ok: true });
    h.s().handlePairAck(bridge.pubkeyHex, {
      type: 'pair-ack',
      machine: 'laptop',
      ok: true,
      relays: ['wss://relay2.descendant.io', 'wss://relay.primal.net'],
      host: 'cli',
    });
    expect(h.s().phase).toBe('paired');
    expect(h.paired[0]!.candidate.relays).toEqual([
      'wss://relay2.descendant.io',
      'wss://relay.primal.net',
    ]);
    expect(h.paired[0]!.host).toBe('cli');
  });

  it('QR pairing merges ack relays into the URL relays, deduped, URL first', () => {
    const h = harness();
    const { url } = buildPairingUrl({
      npub: bridge.npub, relays: ['wss://a.example', 'wss://b.example'], machine: 'box', token: 'tok',
    });
    const parsed = parsePairingUrl(url);
    if (!parsed.ok) throw new Error('fixture parse failed');
    h.s().beginPair(parsed.parts, 'P');
    h.s().handlePairAck(bridge.pubkeyHex, {
      type: 'pair-ack',
      machine: 'box',
      ok: true,
      relays: ['wss://b.example', 'wss://c.example'],
    });
    expect(h.paired[0]!.candidate.relays).toEqual([
      'wss://a.example', 'wss://b.example', 'wss://c.example',
    ]);
  });

  it('an ack without relays/host behaves exactly as before', () => {
    const h = harness();
    h.s().beginManualPair(bridge.npub, 'tok', 'P');
    h.s().handlePairAck(bridge.pubkeyHex, { type: 'pair-ack', machine: 'box', ok: true });
    expect(h.paired[0]!.candidate.relays).toEqual([]);
    expect(h.paired[0]!.host).toBeUndefined();
  });
});

describe('CDX-040: the phone-side pairing attempt has its own deadline', () => {
  function harness() {
    const sent: Array<{ machine: string; msg: PhoneToBridgeMessage }> = [];
    const paired: Array<{ candidate: PairingCandidate; machineName: string }> = [];
    const phone = generateKeypair();
    const timers = new ManualTimers();
    const store = createPairingStore({
      onCandidate: () => {},
      send: (machine, msg) => sent.push({ machine, msg }),
      onPaired: (candidate, machineName) => paired.push({ candidate, machineName }),
      identity: () => ({ npub: phone.npub, pubkeyHex: phone.pubkeyHex }),
      timers,
    });
    return { sent, paired, timers, store, s: () => store.getState() };
  }

  it('silence past the deadline fails the attempt with an actionable message', () => {
    const h = harness();
    h.s().beginManualPair(bridge.npub, 'tok', 'P');
    expect(h.s().phase).toBe('awaiting-ack');

    // Device symptom: the overlay sat on a bare title + Cancel for ~4 minutes
    // against an already-dead bridge window. One tick short of the deadline it
    // is still legitimately waiting.
    h.timers.advance(PAIR_ACK_TIMEOUT_MS - 1);
    expect(h.s().phase).toBe('awaiting-ack');
    expect(h.s().error).toBeNull();

    h.timers.advance(1);
    expect(h.s().phase).toBe('failed');
    expect(h.s().timedOut).toBe(true);
    // The three causes silence cannot tell apart are all named.
    expect(h.s().error).toMatch(/window may have closed/i);
    expect(h.s().error).toMatch(/token may be mistyped/i);
    expect(h.s().error).toMatch(/share a relay/i);
    expect(h.paired).toEqual([]);
  });

  it('a mistyped token that the bridge cannot even nack still resolves', () => {
    // The bridge only subscribes to the pairing filter while its window is
    // open, so a request sent after it closed gets no answer at all — not even
    // a 'bad-token' rejection. This is the exact device case.
    const h = harness();
    h.s().beginManualPair(bridge.npub, 'wrong-token', 'P');
    h.timers.advance(PAIR_ACK_TIMEOUT_MS);
    expect(h.s().phase).toBe('failed');
    expect(h.s().timedOut).toBe(true);
  });

  it('an ack inside the deadline pairs normally and disarms the timer', () => {
    const h = harness();
    h.s().beginManualPair(bridge.npub, 'tok', 'P');
    h.timers.advance(PAIR_ACK_TIMEOUT_MS - 5_000); // happy path was ~22s
    h.s().handlePairAck(bridge.pubkeyHex, { type: 'pair-ack', machine: 'box', ok: true });
    expect(h.s().phase).toBe('paired');

    // The armed deadline must not fire later and knock a paired phone over.
    expect(h.timers.pendingCount()).toBe(0);
    h.timers.advance(PAIR_ACK_TIMEOUT_MS * 2);
    expect(h.s().phase).toBe('paired');
  });

  it('a LATE ack still pairs — a slow relay must not strand the bridge as paired', () => {
    const h = harness();
    h.s().beginManualPair(bridge.npub, 'tok', 'P');
    h.timers.advance(PAIR_ACK_TIMEOUT_MS);
    expect(h.s().phase).toBe('failed');

    h.s().handlePairAck(bridge.pubkeyHex, { type: 'pair-ack', machine: 'box', ok: true });
    expect(h.s().phase).toBe('paired');
    expect(h.s().timedOut).toBe(false);
    expect(h.paired[0]!.machineName).toBe('box');
  });

  it('a bridge NACK is terminal — a later ack after it is still ignored', () => {
    const h = harness();
    h.s().beginManualPair(bridge.npub, 'tok', 'P');
    h.s().handlePairAck(bridge.pubkeyHex, {
      type: 'pair-ack', machine: 'box', ok: false, reason: 'bad-token',
    });
    expect(h.s()).toMatchObject({ phase: 'failed', error: 'bad-token', timedOut: false });

    h.s().handlePairAck(bridge.pubkeyHex, { type: 'pair-ack', machine: 'box', ok: true });
    expect(h.s().phase).toBe('failed');
    expect(h.paired).toEqual([]);

    // ...and the nack disarmed the deadline, so it cannot overwrite the reason.
    h.timers.advance(PAIR_ACK_TIMEOUT_MS * 2);
    expect(h.s().error).toBe('bad-token');
  });

  it('Cancel (reset) disarms the deadline; a retry arms exactly one fresh one', () => {
    const h = harness();
    h.s().beginManualPair(bridge.npub, 'tok', 'P');
    h.s().reset();
    expect(h.timers.pendingCount()).toBe(0);
    h.timers.advance(PAIR_ACK_TIMEOUT_MS * 2);
    expect(h.s().phase).toBe('idle'); // a cancelled flow never reports a failure

    // Retrying after a timeout supersedes the old deadline rather than stacking.
    h.s().beginManualPair(bridge.npub, 'tok', 'P');
    h.timers.advance(PAIR_ACK_TIMEOUT_MS);
    expect(h.s().phase).toBe('failed');
    h.s().beginManualPair(bridge.npub, 'tok2', 'P');
    expect(h.s()).toMatchObject({ phase: 'awaiting-ack', timedOut: false, error: null });
    expect(h.timers.pendingCount()).toBe(1);
  });

  it('the deadline is configurable, and 60s is the shipped default', () => {
    expect(PAIR_ACK_TIMEOUT_MS).toBe(60_000);
    const timers = new ManualTimers();
    const phone = generateKeypair();
    const store = createPairingStore({
      onCandidate: () => {},
      send: () => {},
      onPaired: () => {},
      identity: () => ({ npub: phone.npub, pubkeyHex: phone.pubkeyHex }),
      timers,
      pairTimeoutMs: 5_000,
    });
    store.getState().beginManualPair(bridge.npub, 'tok', 'P');
    timers.advance(5_000);
    expect(store.getState().phase).toBe('failed');
    expect(store.getState().error).toContain('5s');
  });
});

describe('CDX-013: staged deep-link pairing (explicit confirmation)', () => {
  function harness() {
    const sent: Array<{ machine: string; msg: PhoneToBridgeMessage }> = [];
    const candidates: PairingCandidate[] = [];
    const phone = generateKeypair();
    const store = createPairingStore({
      onCandidate: (c) => candidates.push(c),
      send: (machine, msg) => sent.push({ machine, msg }),
      onPaired: () => {},
      identity: () => ({ npub: phone.npub, pubkeyHex: phone.pubkeyHex }),
      timers: new ManualTimers(),
    });
    return { sent, candidates, store, s: () => store.getState() };
  }

  const parts = () => {
    const { url } = buildPairingUrl({
      npub: bridge.npub, relays: ['wss://r.example'], machine: 'box', token: 'tok',
    });
    const parsed = parsePairingUrl(url);
    if (!parsed.ok) throw new Error('fixture parse failed');
    return parsed.parts;
  };

  it('stagePair records the URL but sends NOTHING and registers NO candidate', () => {
    const h = harness();
    h.s().stagePair(parts());
    expect(h.s().staged).toMatchObject({ machine: 'box' });
    expect(h.s().phase).toBe('idle');
    expect(h.sent).toHaveLength(0);
    expect(h.candidates).toHaveLength(0);
  });

  it('confirmStaged runs the normal beginPair flow and clears the staged link', () => {
    const h = harness();
    h.s().stagePair(parts());
    h.s().confirmStaged('My Phone');
    expect(h.s().staged).toBeNull();
    expect(h.s().phase).toBe('awaiting-ack');
    expect(h.candidates).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.msg).toMatchObject({ type: 'pair-request', token: 'tok', label: 'My Phone' });
  });

  it('dismissStaged clears without any side effect; confirm after dismiss is a no-op', () => {
    const h = harness();
    h.s().stagePair(parts());
    h.s().dismissStaged();
    expect(h.s().staged).toBeNull();
    h.s().confirmStaged('P');
    expect(h.sent).toHaveLength(0);
    expect(h.s().phase).toBe('idle');
  });

  it('reset clears a staged link too', () => {
    const h = harness();
    h.s().stagePair(parts());
    h.s().reset();
    expect(h.s().staged).toBeNull();
  });
});
