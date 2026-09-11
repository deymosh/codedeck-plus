/**
 * NIP-17 DM types + the pure peer-input helpers, shared by the native
 * adapter (`nativeDm.ts`) and the UI (`DmTile.tsx`, `DmSection.tsx`,
 * `dm/DmChatScreen.tsx`, `dm/MarmotChatScreen.tsx`, `platform/profileFetch.ts`).
 *
 * The gift-wrap send/receive path (rumor → seal → wrap, the dedicated 1059
 * subscription with its own epoch guard and catch-up cursor, dedup, and
 * persistence) is Rust's job now (`client_runtime::giftwrap`,
 * `client_core::stores::dm`) — only the shared TYPES and the two pure
 * formatters (`parsePeerInput`/`truncatePeerLabel`, which the UI calls
 * directly for input validation and display) survive here.
 */
import type { StoreApi } from 'zustand/vanilla';
import * as nip19 from 'nostr-tools/nip19';
import type { NostrEvent } from 'nostr-tools/core';

export type DmProtocol = 'nip17' | 'marmot';

export interface DmConversation {
  peerPubkey: string;
  protocol: DmProtocol;
  /** ms timestamp of the newest message (rumor time). */
  lastMessageAt: number;
  unreadCount: number;
  /** Last-message preview for the conversation list. */
  lastPreview: string;
}

export type DmMessageStatus = 'sent' | 'delivered' | 'failed';

export interface DmMessage {
  /** The rumor id — deterministic across the recipient wrap, the self wrap,
   *  and the local optimistic add, so dedup is structural. */
  id: string;
  peerPubkey: string;
  senderPubkey: string;
  content: string;
  /** ms timestamp (rumor created_at; local clock for failed sends). */
  at: number;
  status: DmMessageStatus;
}

export interface DmProfile {
  name?: string;
  displayName?: string;
  picture?: string;
  nip05?: string;
  about?: string;
  fetchedAt: number;
  status: 'ok' | 'notfound';
}

export type DmProfileStatus = 'loading' | 'ok' | 'error';

/** One-shot kind-0 resolution — implemented in platform/ (outbox strategy over
 *  its own pool), faked in tests. Must resolve, never reject. */
export type ProfileFetcher = (pubkeyHex: string) => Promise<DmProfile>;

export interface DmDiagnostics {
  /** 1059 events seen by this store since app start. */
  eventsReceived: number;
  /** Gift wraps we could not unwrap (CD-001: counted + logged, NEVER silent). */
  unwrapFailures: number;
  /** Unwrapped fine but not a valid kind-14 DM rumor. */
  invalidRumors: number;
}

/** npub bech32 or 64-char hex → hex pubkey; null on invalid. */
export function parsePeerInput(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.startsWith('npub1')) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === 'npub') return decoded.data;
    } catch {
      /* invalid bech32 */
    }
    return null;
  }
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  return null;
}

/** Display label for a pubkey without a resolved profile. */
export function truncatePeerLabel(pubkeyHex: string): string {
  if (/^[0-9a-f]{64}$/i.test(pubkeyHex)) {
    try {
      const npub = nip19.npubEncode(pubkeyHex.toLowerCase());
      return `${npub.slice(0, 10)}…${npub.slice(-4)}`;
    } catch {
      /* fall through */
    }
  }
  if (pubkeyHex.length < 16) return pubkeyHex;
  return `${pubkeyHex.slice(0, 8)}…${pubkeyHex.slice(-4)}`;
}

export interface DmStoreState {
  conversations: Record<string, DmConversation>;
  /** peerPubkey → messages ascending by `at`. */
  messages: Record<string, DmMessage[]>;
  /** Conversation open in the UI — incoming messages for it never count unread. */
  activePeer: string | null;
  /** The 1059 subscription of the current epoch is live. */
  subscribed: boolean;
  diagnostics: DmDiagnostics;
  profiles: Record<string, DmProfile>;
  /** Transient per-pubkey resolution status for the UI (not persisted). */
  profileStatus: Record<string, DmProfileStatus>;

  /** (Re)subscribe to gift wraps with the catch-up window + publish the
   *  kind-10050 DM relay list. Called by the connection FSM's open-socket
   *  effect; every call supersedes the previous epoch. */
  start(): void;
  /** Deliberate teardown (close-socket effect / shutdown). */
  stop(): void;

  /** Send a NIP-17 DM: rumor once, wrap for recipient + self, publish both. */
  send(peerPubkey: string, content: string): Promise<DmMessage>;
  /** Re-send a failed message (replaces the failed entry on success). */
  retry(peerPubkey: string, messageId: string): Promise<void>;
  /** Parse npub/hex input and open (or create) the conversation.
   *  Returns the peer pubkey hex, or null on invalid input. */
  startConversation(peerInput: string): string | null;
  setActivePeer(peerPubkey: string | null): void;
  markRead(peerPubkey: string): void;

  resolveProfile(pubkeyHex: string, opts?: { force?: boolean }): Promise<void>;
  /** Kick off resolution for every conversation peer + ourselves. */
  resolveAllProfiles(): void;

  /** Ingest one kind-1059 event (the subscription's path; exposed for tests). */
  ingest(event: NostrEvent): void;
}

export type DmStore = StoreApi<DmStoreState>;
