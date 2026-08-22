/**
 * marmotStore — Marmot (MLS) DMs, CDX-012 (plan §5b, Phase 6).
 *
 * Split of labor (per plan): MDK in Rust does ALL the MLS crypto + group state
 * (src-tauri/src/marmot.rs, its own encrypted SQLite store); this store owns
 * transport + presentation. Every outgoing event comes back from Rust as JSON
 * for the app's existing relay client to publish; every received relay event
 * is fed into Rust via the seam. The seam (`MarmotPlatform`) is a port defined
 * HERE so the core stays platform-free — platform/marmot.ts implements it over
 * the Tauri commands; tests fake it.
 *
 * Wire model (MDK 0.8 / MIP-00, follows the yenn reference — NOT kind 443):
 *   • KeyPackages: addressable kind-30443, signed by the identity key,
 *     published on the app relays; peers fetch by author to invite us.
 *   • Welcomes: kind-444 rumors gift-wrapped in kind-1059 — they arrive on the
 *     dm store's EXISTING 1059 subscription, which routes non-NIP-17 rumors
 *     here (`onWrappedRumor` seam). Never published bare.
 *   • Group messages: kind-445, signed by MLS-derived EPHEMERAL keys, routed
 *     by the `h` tag (hex nostr group id). This store runs its own 445
 *     subscription filtered on the h tags of our groups.
 *   • kind 10051: KeyPackage relay list (MIP-00), published beside the KP —
 *     same pattern as NIP-17's kind-10050.
 *
 * Reference-critical behavior (VEIL-029, enforced Rust-side, honored here):
 * a 445 for a not-yet-joined group returns `not_joined` — this store BUFFERS
 * those (the group creator's first message legitimately races the welcome) and
 * re-feeds them after the welcome is accepted.
 *
 * Conversations are MLS groups (1:1 = 2-person group). They surface in the
 * SAME conversation list as NIP-17 via `unifiedConversations` with
 * `protocol: 'marmot'`. Scope guard: 1:1 parity first — the data model
 * carries member lists, but no multi-member management UI this phase.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import { finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import type { KV, Logger, PhoneTransport, TransportSubscription } from '../ports';
import type { Keypair } from '../crypto';
import { bytesToHex } from '../crypto';
import type { DmConversation } from './dm';

// --- Kinds + constants (standard Marmot, NOT @codedeck/protocol) ---

export const KEY_PACKAGE_KIND = 30443;
export const WELCOME_RUMOR_KIND = 444;
export const GROUP_MESSAGE_KIND = 445;
export const KP_RELAY_LIST_KIND = 10051;

/** 445 created_at is honest (no NIP-59 randomization) — a modest catch-up
 *  grace absorbs clock skew; structural dedup absorbs the replays. */
export const GROUP_MESSAGE_SINCE_GRACE_SECONDS = 60 * 60;

export const MAX_MESSAGES_PER_CONVERSATION = 500;
/** Bounded buffer for 445s that arrive before their group is joined. */
export const MAX_UNJOINED_BUFFER = 300;

export const MARMOT_STORAGE_KEY = 'marmot';

/** Default timeout for the one-shot peer KeyPackage fetch. */
export const KEY_PACKAGE_FETCH_TIMEOUT_MS = 8_000;

/**
 * CDX-030: KeyPackage rotation threshold. MLS KPs are one-shot, so we keep
 * exactly one unconsumed KP on the relays and only re-mint when it is gone
 * (consumed by a welcome), the relay set changed, or it has aged out.
 * 30 days balances relay hygiene (no unconsumed pile-up — the old churn was
 * 18 KPs in 2.4h) against key freshness (a KP embeds an HPKE init key; a
 * monthly rotation caps its exposure window, mirroring common KP-lifetime
 * practice in MLS deployments).
 */
export const KEY_PACKAGE_ROTATION_MS = 30 * 24 * 60 * 60 * 1000;

// --- Seam types (implemented by platform/marmot.ts over the Tauri commands;
// faked in tests). All ids are hex strings; events are plain Nostr JSON. ---

export interface MarmotGroupInfo {
  groupId: string;
  hTag: string;
  name: string;
  members: string[];
  admins: string[];
  active: boolean;
}

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

export interface MarmotGroupCreated {
  groupId: string;
  hTag: string;
  /** The gift-wrapped (kind-1059) welcome to publish for the peer. */
  welcomeEvent: NostrEvent;
}

export interface MarmotOutgoing {
  /** The kind-445 event to publish. */
  event: NostrEvent;
  /** Inner rumor id — the stable message id both sides see. */
  rumorId: string;
  /** Rumor created_at, unix seconds. */
  createdAt: number;
}

export type MarmotIngested =
  | { type: 'welcome'; welcome: MarmotWelcomeInfo }
  | {
      type: 'message';
      groupId: string;
      id: string;
      sender: string;
      kind: number;
      content: string;
      createdAt: number;
    }
  | { type: 'not_joined'; hTag: string }
  | { type: 'none' }
  | { type: 'ignored'; reason: string };

/** The Rust MDK engine behind the Tauri commands. Every method may reject —
 *  callers convert failures into logged drops or failed-status messages. */
export interface MarmotPlatform {
  /** Idempotent; hands the identity secret to the engine (never logged). */
  init(secretHex: string): Promise<string>;
  publishKeyPackage(relays: readonly string[]): Promise<NostrEvent>;
  createGroup(
    peerPubkey: string,
    peerKeyPackage: NostrEvent,
    relays: readonly string[],
  ): Promise<MarmotGroupCreated>;
  send(groupId: string, text: string): Promise<MarmotOutgoing>;
  ingest(event: NostrEvent): Promise<MarmotIngested>;
  pendingWelcomes(): Promise<MarmotWelcomeInfo[]>;
  acceptWelcome(welcomeId: string): Promise<MarmotGroupInfo>;
  listGroups(): Promise<MarmotGroupInfo[]>;
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

// --- Pure helpers (unit-tested directly) ---

/** The 445 subscription filter for our groups' h tags. */
export function buildGroupMessageFilter(hTags: readonly string[], since?: number): Filter {
  return {
    kinds: [GROUP_MESSAGE_KIND],
    '#h': [...hTags],
    ...(since !== undefined && since > 0 ? { since } : {}),
  };
}

/** One-shot peer KeyPackage lookup filter (addressable — newest wins). */
export function buildKeyPackageFilter(peerPubkey: string): Filter {
  return { kinds: [KEY_PACKAGE_KIND], authors: [peerPubkey] };
}

/** Catch-up cursor for the 445 subscription (newest known − grace). */
export function marmotSinceCursor(
  messages: Record<string, readonly MarmotMessage[]>,
): number | undefined {
  let latest = 0;
  for (const conv of Object.values(messages)) {
    for (const msg of conv) {
      const ts = Math.floor(msg.at / 1000);
      if (ts > latest) latest = ts;
    }
  }
  return latest > 0 ? latest - GROUP_MESSAGE_SINCE_GRACE_SECONDS : undefined;
}

/** Signed kind-10051 KeyPackage relay list (MIP-00: one `relay` tag each). */
export function buildKpRelayListEvent(
  keypair: Keypair,
  relays: readonly string[],
  createdAt: number,
): NostrEvent {
  return finalizeEvent(
    {
      kind: KP_RELAY_LIST_KIND,
      content: '',
      created_at: createdAt,
      tags: relays.map((url) => ['relay', url]),
    },
    keypair.secretKey,
  );
}

/** The peer of a 1:1 group = the first member that is not us. */
export function peerOfGroup(members: readonly string[], me: string): string {
  return members.find((m) => m !== me) ?? '';
}

// --- CDX-030: KeyPackage mint-once bookkeeping ---

/** Identity of the last KP we successfully published — persisted so app
 *  restarts do NOT re-mint (the old behavior minted one per start). */
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

/**
 * Pure mint decision (CDX-030): mint+publish a new KeyPackage only when
 * none is stored, the stored one was consumed by a welcome, the relay set
 * changed, or rotation is due (KEY_PACKAGE_ROTATION_MS).
 */
export function shouldMintKeyPackage(
  stored: PublishedKeyPackage | null | undefined,
  relaysPayload: string,
  nowMs: number,
  rotationMs: number = KEY_PACKAGE_ROTATION_MS,
): boolean {
  if (!stored) return true;
  if (stored.consumed) return true;
  if (stored.relaysPayload !== relaysPayload) return true;
  if (nowMs - stored.publishedAt >= rotationMs) return true;
  return false;
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

/**
 * One-shot fetch of a peer's newest kind-30443 KeyPackage over the app
 * transport. Resolves null on timeout/none — never rejects.
 */
export function fetchKeyPackage(
  transport: PhoneTransport,
  peerPubkey: string,
  timeoutMs: number = KEY_PACKAGE_FETCH_TIMEOUT_MS,
): Promise<NostrEvent | null> {
  return new Promise((resolve) => {
    let newest: NostrEvent | null = null;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sub.close();
      resolve(newest);
    };
    const timer = setTimeout(finish, timeoutMs);
    const sub = transport.subscribe(buildKeyPackageFilter(peerPubkey), {
      onEvent: (event) => {
        if (event.kind !== KEY_PACKAGE_KIND || event.pubkey !== peerPubkey) return;
        if (!newest || event.created_at > newest.created_at) newest = event;
      },
      onEose: finish,
      onClose: finish,
    });
    if (done) {
      // subscribe() may have completed synchronously via onEose/onClose.
      sub.close();
    }
  });
}

// --- Persistence (KV port — same pattern as dm) ---

export interface MarmotPersisted {
  conversations: Record<string, MarmotConversation>;
  messages: Record<string, MarmotMessage[]>;
  /** CDX-030: last successfully published KeyPackage (null before first). */
  keyPackage?: PublishedKeyPackage | null;
}

const emptyPersisted = (): MarmotPersisted => ({
  conversations: {},
  messages: {},
  keyPackage: null,
});

/** Defensive parse of the persisted KP record (absent/garbage → null). */
function hydrateKeyPackage(raw: unknown): PublishedKeyPackage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const kp = raw as Partial<PublishedKeyPackage>;
  if (typeof kp.id !== 'string' || kp.id.length === 0) return null;
  if (typeof kp.publishedAt !== 'number' || !Number.isFinite(kp.publishedAt)) return null;
  return {
    id: kp.id,
    dTag: typeof kp.dTag === 'string' ? kp.dTag : '',
    relaysPayload: typeof kp.relaysPayload === 'string' ? kp.relaysPayload : '',
    publishedAt: kp.publishedAt,
    consumed: kp.consumed === true,
  };
}

export function hydrateMarmot(raw: string | undefined): MarmotPersisted {
  if (!raw) return emptyPersisted();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyPersisted();
  }
  if (typeof parsed !== 'object' || parsed === null) return emptyPersisted();
  const p = parsed as Partial<MarmotPersisted>;
  const conversations: Record<string, MarmotConversation> = {};
  for (const [groupId, conv] of Object.entries(p.conversations ?? {})) {
    if (typeof conv !== 'object' || conv === null) continue;
    if (typeof conv.groupId !== 'string' || conv.groupId.length === 0) continue;
    conversations[groupId] = {
      groupId: conv.groupId,
      hTag: typeof conv.hTag === 'string' ? conv.hTag : '',
      peerPubkey: typeof conv.peerPubkey === 'string' ? conv.peerPubkey : '',
      name: typeof conv.name === 'string' ? conv.name : '',
      memberCount: typeof conv.memberCount === 'number' ? conv.memberCount : 2,
      lastMessageAt: typeof conv.lastMessageAt === 'number' ? conv.lastMessageAt : 0,
      unreadCount: typeof conv.unreadCount === 'number' ? conv.unreadCount : 0,
      lastPreview: typeof conv.lastPreview === 'string' ? conv.lastPreview : '',
    };
  }
  const messages: Record<string, MarmotMessage[]> = {};
  for (const [groupId, list] of Object.entries(p.messages ?? {})) {
    if (!Array.isArray(list)) continue;
    messages[groupId] = list.filter(
      (m): m is MarmotMessage =>
        typeof m === 'object' && m !== null &&
        typeof (m as MarmotMessage).id === 'string' &&
        typeof (m as MarmotMessage).content === 'string',
    );
  }
  return { conversations, messages, keyPackage: hydrateKeyPackage(p.keyPackage) };
}

export async function loadPersistedMarmot(
  kv: KV,
  storageKey: string = MARMOT_STORAGE_KEY,
): Promise<MarmotPersisted> {
  return hydrateMarmot(await kv.get(storageKey));
}

// --- Store ---

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

  /** Init engine + reconcile groups + publish KP/10051 + (re)subscribe 445.
   *  Called by the connection FSM's open-socket effect (same lifecycle as the
   *  dm store); every call supersedes the previous epoch. */
  start(): void;
  stop(): void;

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

  /** Feed a kind-1059 whose rumor was NOT a NIP-17 DM (dm store routes these
   *  here — Marmot welcomes travel gift-wrapped like DMs do). */
  ingestGiftWrap(event: NostrEvent): void;
  /** Feed one kind-445 (the subscription's path; exposed for tests). */
  ingestGroupMessage(event: NostrEvent): void;
}

export type MarmotStore = StoreApi<MarmotStoreState>;

export interface MarmotStoreDeps {
  kv: KV;
  transport: PhoneTransport;
  /** null/undefined = platform without Marmot (plain browser dev). */
  marmot?: MarmotPlatform | null;
  keypair(): Keypair;
  relays(): readonly string[];
  now?(): number;
  kpFetchTimeoutMs?: number;
  /** A NEW incoming message was stored. Same contract as dm's onIncoming. */
  onIncoming?(msg: MarmotMessage, countsUnread: boolean): void;
  storageKey?: string;
  log?: Logger;
}

export function createMarmotStore(
  deps: MarmotStoreDeps,
  initial?: MarmotPersisted,
): MarmotStore {
  const now = deps.now ?? Date.now;
  const storageKey = deps.storageKey ?? MARMOT_STORAGE_KEY;
  const log = deps.log ?? (() => {});
  const init = initial ?? emptyPersisted();
  const seam = deps.marmot ?? null;

  // Subscription epoch guard (same pattern as dm).
  let epoch = 0;
  let sub: TransportSubscription | null = null;

  /** Engine init is once per run (idempotent Rust-side anyway). */
  let initialized = false;
  /** kind-10051 relay list published this app run for this relay payload
   *  (replaceable — republishing is harmless; behavior unchanged by CDX-030;
   *  the KP itself is now gated on the PERSISTED publishedKeyPackage). */
  let relayListPublishedFor: string | null = null;

  /** 445s for groups we have not joined yet (VEIL-029 buffer), bounded. */
  const unjoinedBuffer: NostrEvent[] = [];

  const store = createStore<MarmotStoreState>()((set, get) => {
    const persist = (): void => {
      const { conversations, messages, publishedKeyPackage } = get();
      void deps.kv
        .set(
          storageKey,
          JSON.stringify({ conversations, messages, keyPackage: publishedKeyPackage }),
        )
        .catch((err) => log(`[Marmot] persist failed: ${err}`));
    };

    const bumpDiag = (field: keyof MarmotDiagnostics): void => {
      const d = get().diagnostics;
      set({ diagnostics: { ...d, [field]: d[field] + 1 } });
    };

    /** Upsert a conversation from engine group info (join/create/reconcile). */
    const upsertConversation = (info: MarmotGroupInfo): void => {
      const me = deps.keypair().pubkeyHex;
      const state = get();
      const prev = state.conversations[info.groupId];
      const conversation: MarmotConversation = {
        groupId: info.groupId,
        hTag: info.hTag,
        peerPubkey: peerOfGroup(info.members, me) || prev?.peerPubkey || '',
        name: info.name,
        memberCount: info.members.length || prev?.memberCount || 2,
        lastMessageAt: prev?.lastMessageAt ?? now(),
        unreadCount: prev?.unreadCount ?? 0,
        lastPreview: prev?.lastPreview ?? '',
      };
      set({ conversations: { ...state.conversations, [info.groupId]: conversation } });
      persist();
    };

    /** Insert a message with structural dedup; bump its conversation. */
    const addMessage = (msg: MarmotMessage): boolean => {
      const state = get();
      const existing = state.messages[msg.groupId] ?? [];
      if (existing.some((m) => m.id === msg.id)) {
        // The relay echo of our own optimistic send confirms delivery.
        const mine = existing.find((m) => m.id === msg.id);
        if (mine && mine.status === 'failed') {
          set({
            messages: {
              ...state.messages,
              [msg.groupId]: existing.map((m) =>
                m.id === msg.id ? { ...m, status: 'sent' as const } : m,
              ),
            },
          });
          persist();
        }
        return false;
      }

      let list = [...existing, msg].sort((a, b) => a.at - b.at);
      if (list.length > MAX_MESSAGES_PER_CONVERSATION) {
        list = list.slice(-MAX_MESSAGES_PER_CONVERSATION);
      }

      const me = deps.keypair().pubkeyHex;
      const prev = state.conversations[msg.groupId];
      const isIncoming = msg.senderPubkey !== me;
      const countsUnread = isIncoming && state.activeGroup !== msg.groupId;
      const newest = list[list.length - 1]!;
      const conversation: MarmotConversation = {
        groupId: msg.groupId,
        hTag: prev?.hTag ?? '',
        peerPubkey: prev?.peerPubkey ?? (isIncoming ? msg.senderPubkey : ''),
        name: prev?.name ?? '',
        memberCount: prev?.memberCount ?? 2,
        lastMessageAt: newest.at,
        unreadCount: (prev?.unreadCount ?? 0) + (countsUnread ? 1 : 0),
        lastPreview: newest.content,
      };

      set({
        messages: { ...state.messages, [msg.groupId]: list },
        conversations: { ...state.conversations, [msg.groupId]: conversation },
      });
      persist();
      if (isIncoming) deps.onIncoming?.(msg, countsUnread);
      return true;
    };

    /** (Re)build the 445 subscription over the current groups' h tags. */
    const resubscribe = (): void => {
      epoch++;
      const myEpoch = epoch;
      sub?.close();
      sub = null;

      const hTags = Object.values(get().conversations)
        .map((c) => c.hTag)
        .filter((h) => h.length > 0);
      if (hTags.length === 0) {
        set({ subscribed: true }); // nothing to subscribe to yet — not an error
        return;
      }
      const since = marmotSinceCursor(get().messages);
      const filter = buildGroupMessageFilter(hTags, since);
      log(`[Marmot] subscribing kinds=[${GROUP_MESSAGE_KIND}] groups=${hTags.length}`);
      sub = deps.transport.subscribe(filter, {
        onEvent: (event) => {
          if (myEpoch !== epoch) return;
          get().ingestGroupMessage(event);
        },
        onClose: () => {
          if (myEpoch !== epoch) return;
          sub = null;
          set({ subscribed: false });
        },
      });
      set({ subscribed: true });
    };

    /** Re-feed buffered 445s (after a group join). Order preserved. */
    const refeedBuffered = (hTag: string): void => {
      const matching = unjoinedBuffer.filter((e) =>
        e.tags.some((t) => t[0] === 'h' && t[1] === hTag),
      );
      for (let i = unjoinedBuffer.length - 1; i >= 0; i--) {
        if (unjoinedBuffer[i]!.tags.some((t) => t[0] === 'h' && t[1] === hTag)) {
          unjoinedBuffer.splice(i, 1);
        }
      }
      for (const event of matching) get().ingestGroupMessage(event);
    };

    /** Common ingest tail for seam results. */
    const applyIngested = (result: MarmotIngested, source: NostrEvent): void => {
      switch (result.type) {
        case 'welcome': {
          const w = result.welcome;
          log(`[Marmot] welcome pending from ${w.welcomer.slice(0, 12)}… (${w.name})`);
          set({ pendingWelcomes: { ...get().pendingWelcomes, [w.welcomeId]: w } });
          // CDX-030: a welcome means a peer consumed one of our one-shot KPs
          // — mark the stored KP consumed so the NEXT start re-mints (peers
          // must always find a fresh unconsumed KP on the relays).
          const kp = get().publishedKeyPackage;
          if (kp && !kp.consumed) {
            set({ publishedKeyPackage: { ...kp, consumed: true } });
            persist();
          }
          return;
        }
        case 'message': {
          // Chat rumors are kind 9; reactions/deletes etc. are out of Phase 6
          // scope — dropped silently by kind (they decrypt fine, we just
          // don't render them yet).
          if (result.kind !== 9) return;
          addMessage({
            id: result.id,
            groupId: result.groupId,
            senderPubkey: result.sender,
            content: result.content,
            at: result.createdAt * 1000,
            status: result.sender === deps.keypair().pubkeyHex ? 'sent' : 'delivered',
          });
          return;
        }
        case 'not_joined': {
          if (unjoinedBuffer.length >= MAX_UNJOINED_BUFFER) unjoinedBuffer.shift();
          unjoinedBuffer.push(source);
          return;
        }
        case 'ignored': {
          bumpDiag('ignored');
          log(`[Marmot] ignored ${source.id.slice(0, 12)}…: ${result.reason}`);
          return;
        }
        case 'none':
          return;
      }
    };

    /** Engine init + group/welcome reconcile + KP publish. Async part of
     *  start(); epoch-guarded so a superseding start()/stop() wins. */
    const startAsync = async (myEpoch: number): Promise<void> => {
      if (!seam) return;
      try {
        if (!initialized) {
          const secretHex = bytesToHex(deps.keypair().secretKey);
          await seam.init(secretHex);
          initialized = true;
        }
        if (myEpoch !== epoch) return;
        set({ available: true });

        // Reconcile conversations from the engine's group list (covers a JS
        // store wipe with surviving MLS state, and member/name drift).
        const groups = await seam.listGroups();
        if (myEpoch !== epoch) return;
        for (const info of groups) {
          if (info.active) upsertConversation(info);
        }
        const welcomes = await seam.pendingWelcomes();
        if (myEpoch !== epoch) return;
        const pending: Record<string, MarmotWelcomeInfo> = {};
        for (const w of welcomes) pending[w.welcomeId] = w;
        set({ pendingWelcomes: pending });

        // Publish our KeyPackage + the kind-10051 KP relay list so peers can
        // start Marmot chats with us. CDX-030: the KP is minted ONCE and its
        // identity persisted — a restart republishes nothing until the KP is
        // consumed by a welcome, the relay set changes, or rotation is due
        // (the old per-start mint piled 18 unconsumed one-shot KPs on the
        // relays in 2.4h). The replaceable 10051 keeps its once-per-run-per-
        // payload behavior unchanged.
        const relays = deps.relays();
        const payload = JSON.stringify(relays);
        if (relays.length > 0) {
          if (shouldMintKeyPackage(get().publishedKeyPackage, payload, now())) {
            try {
              const kpEvent = await seam.publishKeyPackage(relays);
              const kpOk = await deps.transport.publish(kpEvent);
              if (kpOk) {
                set({
                  publishedKeyPackage: {
                    id: kpEvent.id,
                    dTag: kpEvent.tags.find((t) => t[0] === 'd')?.[1] ?? '',
                    relaysPayload: payload,
                    publishedAt: now(),
                    consumed: false,
                  },
                });
                persist();
              } else {
                // Nothing stored — the next start retries the mint.
                log('[Marmot] KeyPackage publish rejected by all relays');
              }
            } catch (err) {
              bumpDiag('errors');
              log(`[Marmot] KeyPackage publish failed: ${err}`);
            }
          }
          if (payload !== relayListPublishedFor) {
            relayListPublishedFor = payload;
            try {
              const listOk = await deps.transport.publish(
                buildKpRelayListEvent(deps.keypair(), relays, Math.floor(now() / 1000)),
              );
              if (!listOk) {
                relayListPublishedFor = null;
                log('[Marmot] KP relay-list publish rejected by all relays');
              }
            } catch (err) {
              relayListPublishedFor = null;
              bumpDiag('errors');
              log(`[Marmot] KP relay-list publish failed: ${err}`);
            }
          }
        }

        if (myEpoch !== epoch) return;
        // Subscribe over the (possibly grown) group set. resubscribe() bumps
        // the epoch itself; run it only if we are still current.
        resubscribe();
      } catch (err) {
        bumpDiag('errors');
        log(`[Marmot] start failed: ${err}`);
      }
    };

    return {
      available: false,
      conversations: init.conversations,
      messages: init.messages,
      pendingWelcomes: {},
      activeGroup: null,
      subscribed: false,
      diagnostics: { eventsReceived: 0, ignored: 0, errors: 0 },
      publishedKeyPackage: init.keyPackage ?? null,

      start: () => {
        if (!seam) return;
        epoch++;
        void startAsync(epoch);
      },

      stop: () => {
        epoch++;
        const s = sub;
        sub = null;
        s?.close();
        set({ subscribed: false });
      },

      send: async (groupId, text) => {
        if (!seam) return null;
        const me = deps.keypair().pubkeyHex;
        try {
          const out = await seam.send(groupId, text);
          const ok = await deps.transport.publish(out.event);
          const msg: MarmotMessage = {
            id: out.rumorId,
            groupId,
            senderPubkey: me,
            content: text,
            at: out.createdAt * 1000,
            status: ok ? 'sent' : 'failed',
          };
          addMessage(msg);
          if (!ok) log('[Marmot] send: no relay accepted the 445');
          return msg;
        } catch (err) {
          bumpDiag('errors');
          log(`[Marmot] send failed: ${err instanceof Error ? err.message : String(err)}`);
          const msg: MarmotMessage = {
            id: globalThis.crypto.randomUUID(),
            groupId,
            senderPubkey: me,
            content: text,
            at: now(),
            status: 'failed',
          };
          addMessage(msg);
          return msg;
        }
      },

      retry: async (groupId, messageId) => {
        const failed = (get().messages[groupId] ?? []).find(
          (m) => m.id === messageId && m.status === 'failed',
        );
        if (!failed) return;
        // Remove the failed entry FIRST (a resend mints a fresh rumor id, so
        // the old entry would linger as a duplicate otherwise).
        const state = get();
        set({
          messages: {
            ...state.messages,
            [groupId]: (state.messages[groupId] ?? []).filter((m) => m.id !== messageId),
          },
        });
        persist();
        await get().send(groupId, failed.content);
      },

      startChat: async (peerPubkey) => {
        if (!seam || !get().available) return { ok: false, reason: 'unavailable' };
        // An existing 1:1 with this peer is just opened, not duplicated.
        const existing = Object.values(get().conversations).find(
          (c) => c.peerPubkey === peerPubkey,
        );
        if (existing) return { ok: true, groupId: existing.groupId };

        const kp = await fetchKeyPackage(
          deps.transport,
          peerPubkey,
          deps.kpFetchTimeoutMs ?? KEY_PACKAGE_FETCH_TIMEOUT_MS,
        );
        if (!kp) return { ok: false, reason: 'no-key-package' };
        try {
          const created = await seam.createGroup(peerPubkey, kp, deps.relays());
          const welcomeOk = await deps.transport.publish(created.welcomeEvent);
          if (!welcomeOk) {
            // The group exists engine-side but the peer can never join —
            // surface failure; a retry recreates a fresh group.
            log('[Marmot] welcome publish rejected by all relays');
            return { ok: false, reason: 'failed' };
          }
          upsertConversation({
            groupId: created.groupId,
            hTag: created.hTag,
            name: '',
            members: [deps.keypair().pubkeyHex, peerPubkey],
            admins: [],
            active: true,
          });
          resubscribe();
          return { ok: true, groupId: created.groupId };
        } catch (err) {
          bumpDiag('errors');
          log(`[Marmot] startChat failed: ${err instanceof Error ? err.message : String(err)}`);
          return { ok: false, reason: 'failed' };
        }
      },

      acceptWelcome: async (welcomeId) => {
        if (!seam) return false;
        try {
          const info = await seam.acceptWelcome(welcomeId);
          const pending = { ...get().pendingWelcomes };
          const welcome = pending[welcomeId];
          delete pending[welcomeId];
          set({ pendingWelcomes: pending });
          upsertConversation(info);
          // The welcomer is the 1:1 peer even if the member list hasn't
          // settled engine-side yet.
          if (welcome) {
            const conv = get().conversations[info.groupId];
            if (conv && conv.peerPubkey === '') {
              set({
                conversations: {
                  ...get().conversations,
                  [info.groupId]: { ...conv, peerPubkey: welcome.welcomer },
                },
              });
              persist();
            }
          }
          resubscribe();
          refeedBuffered(info.hTag);
          return true;
        } catch (err) {
          bumpDiag('errors');
          log(`[Marmot] accept welcome failed: ${err instanceof Error ? err.message : String(err)}`);
          // A dead welcome (stale KP after reinstall) can never be accepted —
          // drop the card instead of offering an infinite retry (VEIL-117).
          const pending = { ...get().pendingWelcomes };
          delete pending[welcomeId];
          set({ pendingWelcomes: pending });
          return false;
        }
      },

      setActiveGroup: (groupId) => {
        set({ activeGroup: groupId });
        if (groupId) get().markRead(groupId);
      },

      markRead: (groupId) => {
        const conv = get().conversations[groupId];
        if (!conv || conv.unreadCount === 0) return;
        set({
          conversations: {
            ...get().conversations,
            [groupId]: { ...conv, unreadCount: 0 },
          },
        });
        persist();
      },

      ingestGiftWrap: (event) => {
        if (!seam || event.kind !== 1059) return;
        bumpDiag('eventsReceived');
        void seam
          .ingest(event)
          .then((result) => applyIngested(result, event))
          .catch((err) => {
            bumpDiag('errors');
            log(`[Marmot] wrap ingest failed: ${err}`);
          });
      },

      ingestGroupMessage: (event) => {
        if (!seam || event.kind !== GROUP_MESSAGE_KIND) return;
        bumpDiag('eventsReceived');
        void seam
          .ingest(event)
          .then((result) => applyIngested(result, event))
          .catch((err) => {
            bumpDiag('errors');
            log(`[Marmot] 445 ingest failed: ${err}`);
          });
      },
    };
  });

  return store;
}
