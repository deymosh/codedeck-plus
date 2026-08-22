import { describe, expect, it } from 'vitest';
import {
  CODEDECK_KINDS,
  COMMAND_KIND,
  LIVE_KIND,
  RESPONSE_KIND,
  SESSION_LIST_KIND,
} from '../kinds';
import { PROTOCOL_VERSION } from '../capabilities';
import { DEFAULT_RELAYS, FALLBACK_RELAY, PAIRING_RELAY, PRIMARY_RELAY } from '../relays';

describe('event kinds', () => {
  it('session list is NIP-33 parameterized replaceable (30000–39999)', () => {
    expect(SESSION_LIST_KIND).toBeGreaterThanOrEqual(30000);
    expect(SESSION_LIST_KIND).toBeLessThan(40000);
  });

  it('command and response kinds are regular stored events (1–9999)', () => {
    for (const kind of [COMMAND_KIND, RESPONSE_KIND]) {
      expect(kind).toBeGreaterThanOrEqual(1);
      expect(kind).toBeLessThan(10000);
    }
    expect(COMMAND_KIND).not.toBe(RESPONSE_KIND);
  });

  it('live kind is ephemeral (20000–29999) — the v10 kind-split invariant', () => {
    expect(LIVE_KIND).toBeGreaterThanOrEqual(20000);
    expect(LIVE_KIND).toBeLessThan(30000);
  });

  it('CODEDECK_KINDS covers all four kinds exactly once', () => {
    expect([...CODEDECK_KINDS].sort((a, b) => a - b)).toEqual(
      [SESSION_LIST_KIND, COMMAND_KIND, RESPONSE_KIND, LIVE_KIND].sort((a, b) => a - b),
    );
    expect(new Set(CODEDECK_KINDS).size).toBe(CODEDECK_KINDS.length);
  });
});

describe('protocol constants', () => {
  it('v10 is a clean break from the hand-mirrored v9 era', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(10);
  });

  it('the self-hosted relay is the primary transport', () => {
    expect(DEFAULT_RELAYS[0]).toBe(PRIMARY_RELAY);
    expect(DEFAULT_RELAYS.length).toBeGreaterThanOrEqual(2);
    for (const url of DEFAULT_RELAYS) expect(url).toMatch(/^wss:\/\//);
  });

  it('CDX-042: two PUBLIC relays ship by default, so a clean install has redundancy', () => {
    // PRIMARY_RELAY is undeployed (CDX-007) and the phone scrubs it (CDX-021),
    // so the public relays are the only ones a fresh install can actually
    // reach — there must be more than one of them.
    const publicDefaults = DEFAULT_RELAYS.filter((url) => url !== PRIMARY_RELAY);
    expect(publicDefaults.length).toBeGreaterThanOrEqual(2);
    expect(publicDefaults).toContain(PAIRING_RELAY);
    expect(publicDefaults).toContain(FALLBACK_RELAY);
    expect(new Set(DEFAULT_RELAYS).size).toBe(DEFAULT_RELAYS.length);
  });
});
