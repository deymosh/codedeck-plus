/**
 * identityStore — the phone keypair, OUT of dmStore (per plan §5).
 *
 * One keypair per install, created on first boot and persisted (hex secret)
 * through the KV port. Everything that needs to sign/encrypt gets the keypair
 * from here — no other store touches key material.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  bytesToHex,
  generateKeypair,
  hexToBytes,
  keypairFromSecret,
  type Keypair,
} from '../crypto';
import type { KV, Logger } from '../ports';

export const IDENTITY_STORAGE_KEY = 'identity.secretKey';

export interface IdentityStoreState {
  keypair: Keypair;
  pubkeyHex: string;
  npub: string;
}

export type IdentityStore = StoreApi<IdentityStoreState>;

/** Load the persisted keypair or create + persist a fresh one. */
export async function loadOrCreateIdentity(
  kv: KV,
  log?: Logger,
  storageKey: string = IDENTITY_STORAGE_KEY,
): Promise<Keypair> {
  const stored = await kv.get(storageKey);
  if (stored) {
    try {
      return keypairFromSecret(hexToBytes(stored));
    } catch (err) {
      // A corrupt secret is unrecoverable — regenerate rather than brick the
      // app; the user re-pairs (log it loudly).
      log?.(`[Identity] stored secret invalid (${err}) — generating a new keypair`);
    }
  }
  const keypair = generateKeypair();
  await kv.set(storageKey, bytesToHex(keypair.secretKey));
  return keypair;
}

export function createIdentityStore(keypair: Keypair): IdentityStore {
  return createStore<IdentityStoreState>()(() => ({
    keypair,
    pubkeyHex: keypair.pubkeyHex,
    npub: keypair.npub,
  }));
}
