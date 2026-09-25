/**
 * Phone-side keypair + NIP-44 helpers, on nostr-tools directly.
 *
 * Deliberately mirrors @codedeck/core's nostr/crypto.ts WITHOUT importing it:
 * production phone code depends on neither the bridge engine nor the wire
 * protocol package at runtime — see `protocolConstants.ts` for the same
 * reasoning applied to the wire protocol's own constants and validators.
 */
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44';
import * as nip19 from 'nostr-tools/nip19';

export interface Keypair {
  secretKey: Uint8Array;
  pubkeyHex: string;
  npub: string;
}

export function generateKeypair(): Keypair {
  return keypairFromSecret(generateSecretKey());
}

export function keypairFromSecret(secretKey: Uint8Array): Keypair {
  const pubkeyHex = getPublicKey(secretKey);
  return { secretKey, pubkeyHex, npub: nip19.npubEncode(pubkeyHex) };
}

/** npub → hex pubkey. Throws on anything that is not a valid npub. */
export function hexFromNpub(npub: string): string {
  const decoded = nip19.decode(npub);
  if (decoded.type !== 'npub') {
    throw new Error(`not an npub: ${npub}`);
  }
  return decoded.data;
}

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

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** NIP-44 v2 encrypt from `secretKey`'s owner to `peerPubkeyHex`. */
export function encryptTo(secretKey: Uint8Array, peerPubkeyHex: string, plaintext: string): string {
  return encrypt(plaintext, getConversationKey(secretKey, peerPubkeyHex));
}

/** NIP-44 v2 decrypt a ciphertext sent by `peerPubkeyHex`. Throws on garbage —
 *  ingest paths must catch and count (never crash, never fake a disconnect). */
export function decryptFrom(secretKey: Uint8Array, peerPubkeyHex: string, ciphertext: string): string {
  return decrypt(ciphertext, getConversationKey(secretKey, peerPubkeyHex));
}
