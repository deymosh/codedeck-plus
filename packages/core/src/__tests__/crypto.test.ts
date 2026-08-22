/** NIP-44 helpers: keypair generation and round-trips between two keypairs. */
import { describe, it, expect } from 'vitest';
import { generateKeypair, keypairFromSecret, encryptTo, decryptFrom } from '../nostr/crypto';

describe('nostr/crypto', () => {
  it('generateKeypair produces a coherent secret/pubkey/npub triple', () => {
    const kp = generateKeypair();
    expect(kp.secretKey).toBeInstanceOf(Uint8Array);
    expect(kp.secretKey).toHaveLength(32);
    expect(kp.pubkeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(kp.npub).toMatch(/^npub1/);
    // Rehydrating from the secret gives the same identity.
    expect(keypairFromSecret(kp.secretKey)).toEqual(kp);
  });

  it('NIP-44 round-trips both directions between two generated keypairs', () => {
    const bridge = generateKeypair();
    const phone = generateKeypair();
    const plaintext = JSON.stringify({ type: 'input', sessionId: 's1', text: 'héllo 🚀' });

    const toPhone = encryptTo(bridge.secretKey, phone.pubkeyHex, plaintext);
    expect(toPhone).not.toContain('héllo');
    expect(decryptFrom(phone.secretKey, bridge.pubkeyHex, toPhone)).toBe(plaintext);

    const toBridge = encryptTo(phone.secretKey, bridge.pubkeyHex, 'ack');
    expect(decryptFrom(bridge.secretKey, phone.pubkeyHex, toBridge)).toBe('ack');
  });

  it('a third party cannot decrypt, and tampered ciphertext throws', () => {
    const bridge = generateKeypair();
    const phone = generateKeypair();
    const eve = generateKeypair();
    const ciphertext = encryptTo(bridge.secretKey, phone.pubkeyHex, 'secret');

    expect(() => decryptFrom(eve.secretKey, bridge.pubkeyHex, ciphertext)).toThrow();
    expect(() => decryptFrom(phone.secretKey, bridge.pubkeyHex, ciphertext.slice(0, -4) + 'AAAA')).toThrow();
    expect(() => decryptFrom(phone.secretKey, bridge.pubkeyHex, 'garbage')).toThrow();
  });
});
