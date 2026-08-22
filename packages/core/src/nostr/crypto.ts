/**
 * NIP-44 crypto helpers + keypair generation for the bridge ↔ phone channel.
 *
 * Ported from codedeck-bridge-vscode/src/nostrRelay.ts: nostr-tools nip44 (v2)
 * with getConversationKey. Every protocol payload crosses the relay NIP-44
 * encrypted between the bridge keypair and one phone keypair — the relay only
 * ever sees ciphertext.
 */
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44';
import * as nip19 from 'nostr-tools/nip19';

export interface Keypair {
  secretKey: Uint8Array;
  pubkeyHex: string;
  npub: string;
}

/** Generate a fresh bridge/phone keypair. */
export function generateKeypair(): Keypair {
  return keypairFromSecret(generateSecretKey());
}

/** Rehydrate the full keypair from a stored secret key. */
export function keypairFromSecret(secretKey: Uint8Array): Keypair {
  const pubkeyHex = getPublicKey(secretKey);
  return { secretKey, pubkeyHex, npub: nip19.npubEncode(pubkeyHex) };
}

/** npub for a hex pubkey (e.g. deriving a paired phone's npub from the event author). */
export function npubFromHex(pubkeyHex: string): string {
  return nip19.npubEncode(pubkeyHex);
}

/** Hex → bytes for stored secret keys (hosts persist the nsec as hex). */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error('invalid hex string');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/** Bytes → hex for storing secret keys. */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** NIP-44 v2 encrypt `plaintext` from `secretKey`'s owner to `peerPubkeyHex`. */
export function encryptTo(
  secretKey: Uint8Array,
  peerPubkeyHex: string,
  plaintext: string,
): string {
  return encrypt(plaintext, getConversationKey(secretKey, peerPubkeyHex));
}

/**
 * NIP-44 v2 decrypt a ciphertext sent by `peerPubkeyHex` to `secretKey`'s
 * owner. Throws on garbage/tampered/not-for-us ciphertext — callers on ingest
 * paths must catch and drop (see ingest.ts).
 */
export function decryptFrom(
  secretKey: Uint8Array,
  peerPubkeyHex: string,
  ciphertext: string,
): string {
  return decrypt(ciphertext, getConversationKey(secretKey, peerPubkeyHex));
}
