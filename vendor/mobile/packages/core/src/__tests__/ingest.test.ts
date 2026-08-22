/**
 * CommandIngest: decrypt → codec validation → typed dispatch. Invalid payloads
 * are logged and dropped — never thrown. Dedup (LRU 1000), 300s staleness
 * cutoff, paired-author gate, and the authorless pairing-window path.
 */
import { describe, it, expect } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/core';
import { COMMAND_KIND, encodePhoneToBridge, type PhoneToBridgeMessage } from '@codedeck/protocol';
import {
  buildCommandsFilter,
  buildPairingFilter,
  sinceForConnect,
  CommandIngest,
  type CommandHandlers,
} from '../nostr/ingest';
import { encryptTo } from '../nostr/crypto';

const NOW_MS = 1_754_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

const bridgeSecret = generateSecretKey();
const bridgePubkey = getPublicKey(bridgeSecret);
const phoneSecret = generateSecretKey();
const phonePubkey = getPublicKey(phoneSecret);

/** Sign+encrypt a phone→bridge event the way the phone would. */
function phoneEvent(
  plaintext: string,
  opts: { createdAt?: number; secret?: Uint8Array } = {},
): NostrEvent {
  const secret = opts.secret ?? phoneSecret;
  return finalizeEvent({
    kind: COMMAND_KIND,
    created_at: opts.createdAt ?? NOW_SEC,
    tags: [['p', bridgePubkey]],
    content: encryptTo(secret, bridgePubkey, plaintext),
  }, secret);
}

function commandEvent(msg: PhoneToBridgeMessage, opts: Parameters<typeof phoneEvent>[1] = {}): NostrEvent {
  return phoneEvent(encodePhoneToBridge(msg), opts);
}

function makeIngest(handlers: CommandHandlers, opts: {
  isPairedPhone?: (pk: string) => boolean;
  lastSeenTimestamp?: number;
  onPhoneCaps?: (phonePubkeyHex: string, caps: readonly string[]) => void;
} = {}) {
  const logs: string[] = [];
  const ingest = new CommandIngest({
    secretKey: bridgeSecret,
    handlers,
    log: (m) => logs.push(m),
    now: () => NOW_MS,
    ...opts,
  });
  return { ingest, logs };
}

describe('filter builders', () => {
  it('commands filter subscribes to COMMAND_KIND from paired authors tagged to the bridge', () => {
    const filter = buildCommandsFilter({
      bridgePubkey,
      phonePubkeys: [phonePubkey],
      since: 123,
    });
    expect(filter).toEqual({
      kinds: [COMMAND_KIND],
      '#p': [bridgePubkey],
      authors: [phonePubkey],
      since: 123,
    });
  });

  it('pairing filter has NO authors — that is the whole point of the window', () => {
    const filter = buildPairingFilter({ bridgePubkey, nowSec: NOW_SEC });
    expect(filter).toEqual({
      kinds: [COMMAND_KIND],
      '#p': [bridgePubkey],
      since: NOW_SEC - 5,
    });
    expect('authors' in filter).toBe(false);
  });

  it('sinceForConnect: last-seen minus 5s grace, else a 5-minute window', () => {
    expect(sinceForConnect(1000, NOW_SEC)).toBe(995);
    expect(sinceForConnect(0, NOW_SEC)).toBe(NOW_SEC - 300);
  });
});

describe('CommandIngest', () => {
  it('a valid command decrypts, validates, and dispatches with the sender pubkey', () => {
    const seen: Array<[string, string]> = [];
    const { ingest } = makeIngest({
      onInput: (msg, pk) => { seen.push([msg.text, pk]); },
    });

    const event = commandEvent({ type: 'input', sessionId: 's1', text: 'hello', inputId: 'i1' });
    ingest.handleEvent(event);

    expect(seen).toEqual([['hello', phonePubkey]]);
    expect(ingest.lastSeenTimestamp).toBe(event.created_at);
  });

  it('dispatch narrows per type (different handlers for different messages)', () => {
    const calls: string[] = [];
    const { ingest } = makeIngest({
      onModeChange: (msg) => { calls.push(`mode:${msg.mode}`); },
      onInterrupt: (msg) => { calls.push(`interrupt:${msg.sessionId}`); },
    });

    ingest.handleEvent(commandEvent({ type: 'mode', sessionId: 's1', mode: 'plan' }));
    ingest.handleEvent(commandEvent({ type: 'interrupt', sessionId: 's2' }));
    // No handler registered for this one — silently fine.
    ingest.handleEvent(commandEvent({ type: 'refresh-sessions' }));

    expect(calls).toEqual(['mode:plan', 'interrupt:s2']);
  });

  it('malformed JSON is logged and dropped, never thrown', () => {
    let dispatched = 0;
    const { ingest, logs } = makeIngest({ onInput: () => { dispatched++; } });

    expect(() => ingest.handleEvent(phoneEvent('{not json'))).not.toThrow();

    expect(dispatched).toBe(0);
    expect(logs.some((l) => l.includes('invalid payload'))).toBe(true);
  });

  it('an unknown message type fails validation and is dropped', () => {
    let dispatched = 0;
    const { ingest, logs } = makeIngest({ onInput: () => { dispatched++; } });

    ingest.handleEvent(phoneEvent(JSON.stringify({ type: 'self-destruct', sessionId: 's1' })));

    expect(dispatched).toBe(0);
    expect(logs.some((l) => l.includes('invalid payload'))).toBe(true);
  });

  it('undecryptable content is dropped without dispatch', () => {
    let dispatched = 0;
    const { ingest } = makeIngest({ onInput: () => { dispatched++; } });

    const garbage = finalizeEvent({
      kind: COMMAND_KIND,
      created_at: NOW_SEC,
      tags: [['p', bridgePubkey]],
      content: 'bm90LWEtY2lwaGVydGV4dA', // not a NIP-44 payload
    }, phoneSecret);
    expect(() => ingest.handleEvent(garbage)).not.toThrow();
    expect(dispatched).toBe(0);
  });

  it('events older than 300s are dropped', () => {
    let dispatched = 0;
    const { ingest, logs } = makeIngest({ onInput: () => { dispatched++; } });

    ingest.handleEvent(commandEvent(
      { type: 'input', sessionId: 's1', text: 'old' },
      { createdAt: NOW_SEC - 301 },
    ));

    expect(dispatched).toBe(0);
    expect(logs.some((l) => l.includes('stale'))).toBe(true);
    expect(ingest.lastSeenTimestamp).toBe(0);
  });

  it('duplicate event ids are dropped (relay replay with overlapping since windows)', () => {
    let dispatched = 0;
    const { ingest } = makeIngest({ onInput: () => { dispatched++; } });

    const event = commandEvent({ type: 'input', sessionId: 's1', text: 'once' });
    ingest.handleEvent(event);
    ingest.handleEvent(event);
    ingest.handleEvent({ ...event }); // same id via a different object

    expect(dispatched).toBe(1);
  });

  // 1000+ NIP-44 decrypt attempts: comfortable alone, but worker contention in
  // the full parallel run starves it past vitest's 5s default (same flake, same
  // fix as mergeSessionList's property test). Give it explicit headroom.
  it('the dedup set is an LRU capped at 1000 — old ids age out', { timeout: 60_000 }, () => {
    let dispatched = 0;
    const { ingest } = makeIngest({ onKeypress: () => { dispatched++; } });

    const first = commandEvent({ type: 'keypress', sessionId: 's1', key: '1' });
    ingest.handleEvent(first);
    expect(dispatched).toBe(1);

    // 1000 distinct ids. Cloning one signed event keeps this fast — ingest
    // dedups by id and does not re-verify signatures (the relay/pool layer does).
    const template = commandEvent({ type: 'keypress', sessionId: 's1', key: 'k' });
    for (let i = 0; i < 1000; i++) {
      ingest.handleEvent({ ...template, id: `fake-id-${i}` });
    }
    expect(dispatched).toBe(1001);

    // `first` was evicted after 1000 fresh ids, so its replay dispatches again.
    ingest.handleEvent(first);
    expect(dispatched).toBe(1002);
  });

  it('events from unpaired authors are dropped when a paired check is provided', () => {
    let dispatched = 0;
    const { ingest, logs } = makeIngest(
      { onInput: () => { dispatched++; } },
      { isPairedPhone: () => false },
    );

    ingest.handleEvent(commandEvent({ type: 'input', sessionId: 's1', text: 'hi' }));

    expect(dispatched).toBe(0);
    expect(logs.some((l) => l.includes('unknown pubkey'))).toBe(true);
  });

  it('a throwing handler is contained and logged', () => {
    const { ingest, logs } = makeIngest({
      onInput: () => { throw new Error('handler exploded'); },
    });

    expect(() => ingest.handleEvent(commandEvent({ type: 'input', sessionId: 's1', text: 'x' }))).not.toThrow();
    expect(logs.some((l) => l.includes('handler error'))).toBe(true);
  });

  it('a rejecting async handler is contained and logged', async () => {
    const { ingest, logs } = makeIngest({
      onInput: async () => { throw new Error('async boom'); },
    });

    ingest.handleEvent(commandEvent({ type: 'input', sessionId: 's1', text: 'x' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(logs.some((l) => l.includes('handler error'))).toBe(true);
  });

  describe('pairing window path', () => {
    const pairRequest: PhoneToBridgeMessage = {
      type: 'pair-request',
      npub: 'npub1phone',
      pubkeyHex: phonePubkey,
      label: 'Pixel 9',
      token: 'tok-1',
    };

    it('dispatches pair-request from a not-yet-paired phone', () => {
      const seen: Array<[string, string]> = [];
      const { ingest } = makeIngest(
        { onPairRequest: (msg, pk) => { seen.push([msg.token, pk]); } },
        // Paired check must NOT apply here — unpaired phones are the point.
        { isPairedPhone: () => false },
      );

      ingest.handlePairingEvent(commandEvent(pairRequest));
      expect(seen).toEqual([['tok-1', phonePubkey]]);
    });

    it('silently drops junk the open filter attracts (undecryptable / non-pair-request)', () => {
      let paired = 0;
      let input = 0;
      const { ingest } = makeIngest({
        onPairRequest: () => { paired++; },
        onInput: () => { input++; },
      });

      // Encrypted to someone else entirely.
      const strangerSecret = generateSecretKey();
      const stranger = finalizeEvent({
        kind: COMMAND_KIND,
        created_at: NOW_SEC,
        tags: [['p', bridgePubkey]],
        content: encryptTo(strangerSecret, getPublicKey(generateSecretKey()), 'psst'),
      }, strangerSecret);
      expect(() => ingest.handlePairingEvent(stranger)).not.toThrow();

      // A valid but non-pair-request command must not dispatch from this path.
      ingest.handlePairingEvent(commandEvent({ type: 'input', sessionId: 's1', text: 'nope' }));

      expect(paired).toBe(0);
      expect(input).toBe(0);
    });

    it('dedups pairing events too', () => {
      let paired = 0;
      const { ingest } = makeIngest({ onPairRequest: () => { paired++; } });

      const event = commandEvent(pairRequest);
      ingest.handlePairingEvent(event);
      ingest.handlePairingEvent(event);
      expect(paired).toBe(1);
    });

    // --- CDX-013 hardening ---

    it('drops stale pairing events (same 300s cutoff as the main path)', () => {
      let paired = 0;
      const { ingest } = makeIngest({ onPairRequest: () => { paired++; } });

      ingest.handlePairingEvent(commandEvent(pairRequest, { createdAt: NOW_SEC - 301 }));
      expect(paired).toBe(0);

      ingest.handlePairingEvent(commandEvent(pairRequest, { createdAt: NOW_SEC - 299 }));
      expect(paired).toBe(1);
    });

    // Same 1000-event crypto loop, same contention headroom as above.
    it('junk on the pairing window does NOT consume dedup LRU slots', { timeout: 60_000 }, () => {
      let dispatched = 0;
      const { ingest } = makeIngest({
        onInput: () => { dispatched++; },
        onPairRequest: () => {},
      });

      // Undecryptable junk needs no valid signature to reach the decrypt
      // attempt (the transport owns sig checks), so fabricate it cheaply —
      // 1200 unique ids would fill the whole LRU if the ordering were wrong.
      const junkEvent = (i: number): NostrEvent => ({
        id: i.toString(16).padStart(64, '0'),
        pubkey: 'ab'.repeat(32),
        created_at: NOW_SEC,
        kind: COMMAND_KIND,
        tags: [['p', bridgePubkey]],
        content: 'not-even-ciphertext',
        sig: '00'.repeat(64),
      });

      const legit = commandEvent({ type: 'input', sessionId: 's1', text: 'once' });
      ingest.handleEvent(legit);
      for (let i = 0; i < 1200; i++) {
        ingest.handlePairingEvent(junkEvent(i));
      }
      ingest.handleEvent(legit); // replay — must still be a duplicate
      expect(dispatched).toBe(1);
    });

    it('events from UNPAIRED authors do not consume dedup LRU slots either', () => {
      let dispatched = 0;
      let paired = false;
      const { ingest } = makeIngest(
        { onInput: () => { dispatched++; } },
        { isPairedPhone: () => paired },
      );

      const event = commandEvent({ type: 'input', sessionId: 's1', text: 'hi' });
      ingest.handleEvent(event); // dropped: unpaired — must NOT mark the id
      expect(dispatched).toBe(0);

      paired = true;
      ingest.handleEvent(event); // now paired: the same event must dispatch
      expect(dispatched).toBe(1);
    });
  });
});

describe('phone capability recording (CDX-050)', () => {
  it('reports advertised caps on every valid command, and [] when caps is absent', () => {
    const seen: Array<[string, readonly string[]]> = [];
    const { ingest } = makeIngest(
      { onInput: () => {} },
      { onPhoneCaps: (pk, caps) => { seen.push([pk, caps]); } },
    );

    ingest.handleEvent(commandEvent({
      type: 'input', sessionId: 's1', text: 'hi', v: 10, caps: ['diff'],
    }));
    ingest.handleEvent(commandEvent({ type: 'refresh-sessions' }));

    expect(seen).toEqual([
      [phonePubkey, ['diff']],
      [phonePubkey, []],
    ]);
  });

  it('is not called for invalid or undecryptable payloads', () => {
    const seen: string[] = [];
    const { ingest } = makeIngest({}, { onPhoneCaps: (pk) => { seen.push(pk); } });
    ingest.handleEvent(phoneEvent('{nope'));
    ingest.handleEvent(phoneEvent(JSON.stringify({ type: 'launch-missiles' })));
    expect(seen).toEqual([]);
  });

  it('an onPhoneCaps throw never blocks dispatch', () => {
    const inputs: string[] = [];
    const { ingest } = makeIngest(
      { onInput: (msg) => { inputs.push(msg.text); } },
      { onPhoneCaps: () => { throw new Error('registry busted'); } },
    );
    ingest.handleEvent(commandEvent({ type: 'input', sessionId: 's1', text: 'still works' }));
    expect(inputs).toEqual(['still works']);
  });
});
