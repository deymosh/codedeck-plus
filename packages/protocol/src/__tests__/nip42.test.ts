import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { makeAuthEvent } from 'nostr-tools/nip42';
import { createRelayAuthSigner } from '../nip42';

describe('createRelayAuthSigner', () => {
  it('signs a kind:22242 AUTH event that verifies against the given pubkey', async () => {
    const secretKey = generateSecretKey();
    const pubkeyHex = getPublicKey(secretKey);
    const signer = createRelayAuthSigner(secretKey)('wss://relay.example');

    const event = await signer(makeAuthEvent('wss://relay.example', 'a-challenge'));

    expect(event.kind).toBe(22242);
    expect(event.pubkey).toBe(pubkeyHex);
    expect(verifyEvent(event)).toBe(true);
  });

  it('returns a fresh signer per relay URL, all backed by the same key', async () => {
    const secretKey = generateSecretKey();
    const pubkeyHex = getPublicKey(secretKey);
    const build = createRelayAuthSigner(secretKey);

    const eventA = await build('wss://a.example')(makeAuthEvent('wss://a.example', 'chal-a'));
    const eventB = await build('wss://b.example')(makeAuthEvent('wss://b.example', 'chal-b'));

    expect(eventA.pubkey).toBe(pubkeyHex);
    expect(eventB.pubkey).toBe(pubkeyHex);
    expect(eventA.id).not.toBe(eventB.id);
  });
});
