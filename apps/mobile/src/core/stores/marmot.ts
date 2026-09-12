/**
 * Marmot (MLS group chat) types shared by the native adapter
 * (`nativeMarmot.ts`) and the UI (`DmTile.tsx`, `DmSection.tsx`,
 * `dm/MarmotChatScreen.tsx`, `MainPanel.tsx`).
 *
 * The MDK/MLS engine itself, the kind-445 subscription lifecycle, the
 * KeyPackage mint-once decision, and gift-wrap welcome routing are Rust's
 * job now (`client_core::marmot_engine`, `client_runtime::marmot`,
 * `client_runtime::Core`'s own start sequence) — only the shared TYPES and
 * `unifiedConversations` (a pure formatter the UI calls directly to merge
 * the DM + Marmot lists) survive here.
 */
import type { StoreApi } from 'zustand/vanilla';
import type { DmConversation } from './dm';

export interface MarmotWelcomeInfo {
  welcomeId: string;
  wrapperId: string;
  groupId: string;
  hTag: string;
  name: string;
  /** Who invited us — the 1:1 peer. */
  welcomer: string;
  memberCount: number;
}

// --- Store types ---

export interface MarmotConversation {
  /** MLS group id (hex) — the conversation key. */
  groupId: string;
  /** kind-445 routing key (`h` tag). */
  hTag: string;
  /** The other member (1:1); '' until known. Profile lookups reuse the dm
   *  store's per-pubkey cache — protocol-agnostic. */
  peerPubkey: string;
  name: string;
  memberCount: number;
  lastMessageAt: number;
  unreadCount: number;
  lastPreview: string;
}

export type MarmotMessageStatus = 'sent' | 'delivered' | 'failed';

export interface MarmotMessage {
  /** Inner rumor id — identical on the sender echo and the recipient copy. */
  id: string;
  groupId: string;
  senderPubkey: string;
  content: string;
  /** ms timestamp. */
  at: number;
  status: MarmotMessageStatus;
}

export interface MarmotDiagnostics {
  eventsReceived: number;
  /** Ingest results of type 'ignored' — counted + logged, never silent. */
  ignored: number;
  /** Seam call failures (counted + logged, never thrown at the caller). */
  errors: number;
}

/**
 * The Phase 6 unified conversation list: both protocols, newest first. `key`
 * is what the UI routes on (peer pubkey for NIP-17, group id for Marmot).
 */
export interface UnifiedConversation {
  protocol: 'nip17' | 'marmot';
  key: string;
  peerPubkey: string;
  lastMessageAt: number;
  unreadCount: number;
  lastPreview: string;
  /** Marmot: the MLS group's own name ('' when it has none). NIP-17 has no
   *  such thing and always carries ''. The list uses it to label a group (and
   *  a 1:1 whose peer is not yet known) instead of showing a bare avatar. */
  title: string;
  /** Members in the conversation — 2 for NIP-17, the MLS roster for Marmot.
   *  Above 2 there is no single peer to name, so the title leads. */
  memberCount: number;
}

export function unifiedConversations(
  nip17: Record<string, DmConversation>,
  marmot: Record<string, MarmotConversation>,
): UnifiedConversation[] {
  const list: UnifiedConversation[] = [
    ...Object.values(nip17).map((c) => ({
      protocol: 'nip17' as const,
      key: c.peerPubkey,
      peerPubkey: c.peerPubkey,
      lastMessageAt: c.lastMessageAt,
      unreadCount: c.unreadCount,
      lastPreview: c.lastPreview,
      title: '',
      memberCount: 2,
    })),
    ...Object.values(marmot).map((c) => ({
      protocol: 'marmot' as const,
      key: c.groupId,
      peerPubkey: c.peerPubkey,
      lastMessageAt: c.lastMessageAt,
      unreadCount: c.unreadCount,
      lastPreview: c.lastPreview,
      title: c.name,
      memberCount: c.memberCount,
    })),
  ];
  return list.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
}

// --- CDX-030: KeyPackage mint-once bookkeeping — the STATE shape only
// survives (a native adapter must supply SOME value for it); the mint
// decision itself is Rust's now. ---

export interface PublishedKeyPackage {
  /** Event id of the published kind-30443. */
  id: string;
  /** Its `d` tag (addressable identity on the relays). */
  dTag: string;
  /** JSON.stringify of the relay list it was published to — a changed relay
   *  set needs a fresh publish so new relays carry a KP. */
  relaysPayload: string;
  /** ms timestamp of the successful publish. */
  publishedAt: number;
  /** A welcome arrived — some KP of ours was consumed (MLS KPs are
   *  one-shot); conservatively re-mint on the next start. */
  consumed: boolean;
}

export type StartMarmotChatResult =
  | { ok: true; groupId: string }
  | { ok: false; reason: 'unavailable' | 'no-key-package' | 'failed' };

export interface MarmotStoreState {
  /** The platform seam exists AND init succeeded — Marmot chats can start.
   *  False in plain-browser dev and until the first start() completes. */
  available: boolean;
  conversations: Record<string, MarmotConversation>;
  /** groupId → messages ascending by `at`. */
  messages: Record<string, MarmotMessage[]>;
  pendingWelcomes: Record<string, MarmotWelcomeInfo>;
  /** Conversation open in the UI — suppresses its unread counting. */
  activeGroup: string | null;
  subscribed: boolean;
  diagnostics: MarmotDiagnostics;
  /** CDX-030: last successfully published KP (persisted; null before the
   *  first publish). Drives the mint-once decision across app starts. */
  publishedKeyPackage: PublishedKeyPackage | null;

  /** Send into a group; optimistic echo with the rumor id. */
  send(groupId: string, text: string): Promise<MarmotMessage | null>;
  /** Re-send a failed message (replaces the failed entry on success). */
  retry(groupId: string, messageId: string): Promise<void>;
  /** Full start-chat flow: fetch peer KP → create group → publish welcome. */
  startChat(peerPubkey: string): Promise<StartMarmotChatResult>;
  /** Accept a pending welcome → group joined → buffered 445s re-fed. */
  acceptWelcome(welcomeId: string): Promise<boolean>;

  setActiveGroup(groupId: string | null): void;
  markRead(groupId: string): void;
}

export type MarmotStore = StoreApi<MarmotStoreState>;
