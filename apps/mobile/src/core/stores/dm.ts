/**
 * dmStore — NIP-17 direct messages, ported from the old app's dmStore +
 * nostrService (CDX-011 Phase 5b). DMs ONLY: the keypair lives in
 * identityStore and reaches this store through deps (plan §5); DM content is
 * standard Nostr (kind 14 rumor → kind 13 seal → kind 1059 gift wrap via
 * nostr-tools nip59) — deliberately protocol-independent, no @codedeck/protocol
 * schemas involved.
 *
 * Send path (ported): create the kind-14 rumor ONCE (deterministic rumor.id =
 * the message id for dedup), then seal+wrap twice — for the recipient AND for
 * ourselves (the self-copy is what makes our own messages survive a
 * reinstall/restart via relay catch-up) — and publish both through the app's
 * transport.
 *
 * Receive path: one dedicated kind-1059 subscription (own epoch guard, own
 * since-cursor: NIP-59 randomizes gift-wrap created_at up to 2 days into the
 * past, so catch-up subscribes from `latest known message − 48h`; the id +
 * content dedup absorbs the replays). Unwrap failures are COUNTED in
 * diagnostics and logged — never swallowed silently (the old processGiftWrap
 * bug, CD-001).
 *
 * Conversations are keyed by peer pubkey and carry `protocol: 'nip17'` — the
 * seam Phase 6 (Marmot) extends into a unified, per-protocol-tagged list.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import { z } from 'zod';
import { finalizeEvent } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { createRumor, createSeal, createWrap, unwrapEvent } from 'nostr-tools/nip59';
import type { NostrEvent } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import type { KV, Logger, PhoneTransport, TransportSubscription } from '../ports';
import type { Keypair } from '../crypto';

// --- Kinds + constants (standard Nostr, NOT @codedeck/protocol) ---

export const GIFT_WRAP_KIND = 1059;
export const DM_RUMOR_KIND = 14;
export const DM_RELAY_LIST_KIND = 10050;

/** NIP-59 randomizes gift-wrap created_at up to 2 days into the past — the
 *  catch-up `since` must reach back at least that far (ported: the old app
 *  used the same 48h window). */
export const GIFT_WRAP_SINCE_GRACE_SECONDS = 2 * 24 * 60 * 60;

/** Ported caps: bounded per-conversation history, fuzzy content dedup for
 *  other NIP-17 clients that generate different rumor ids per wrap. */
export const MAX_MESSAGES_PER_CONVERSATION = 500;
export const CONTENT_DEDUP_WINDOW_S = 60;

export const DM_STORAGE_KEY = 'dm';

/** Profile cache TTL (ported). */
const PROFILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// --- Types ---

/** Phase 6 (CDX-012): 'marmot' joined the union. NIP-17 conversations in THIS
 *  store are always 'nip17'; Marmot conversations live in the marmot store
 *  and both merge into one list via `unifiedConversations` (stores/marmot). */
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

// --- Pure helpers (unit-tested directly) ---

/** Rumor shape guard — zod 3 (standard Nostr content, kept out of protocol). */
export const dmRumorSchema = z.object({
  id: z.string().min(1),
  pubkey: z.string().regex(/^[0-9a-f]{64}$/i),
  kind: z.number().int(),
  content: z.string(),
  created_at: z.number(),
  tags: z.array(z.array(z.string())),
});

/**
 * The catch-up cursor (seconds) for the 1059 subscription: newest known
 * message minus the 48h gift-wrap randomization window; undefined = no local
 * history, fetch everything (ported getLatestMessageTimestamp).
 */
export function dmSinceCursor(
  messages: Record<string, readonly DmMessage[]>,
): number | undefined {
  let latest = 0;
  for (const conv of Object.values(messages)) {
    for (const msg of conv) {
      const ts = Math.floor(msg.at / 1000);
      if (ts > latest) latest = ts;
    }
  }
  return latest > 0 ? latest - GIFT_WRAP_SINCE_GRACE_SECONDS : undefined;
}

/** The one DM filter: gift wraps addressed to us, from the catch-up cursor. */
export function buildDmFilter(pubkeyHex: string, since?: number): Filter {
  return {
    kinds: [GIFT_WRAP_KIND],
    '#p': [pubkeyHex],
    ...(since !== undefined && since > 0 ? { since } : {}),
  };
}

/** npub bech32 or 64-char hex → hex pubkey; null on invalid (ported). */
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

/** Display label for a pubkey without a resolved profile (ported). */
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

/** Conversation-list ordering: newest activity first. */
export function orderedConversations(
  conversations: Record<string, DmConversation>,
): DmConversation[] {
  return Object.values(conversations).sort((a, b) => b.lastMessageAt - a.lastMessageAt);
}

/** Signed kind-10050 DM relay list (NIP-17: one `relay` tag per relay). */
export function buildDmRelayListEvent(
  keypair: Keypair,
  relays: readonly string[],
  createdAt: number,
): NostrEvent {
  return finalizeEvent(
    {
      kind: DM_RELAY_LIST_KIND,
      content: '',
      created_at: createdAt,
      tags: relays.map((url) => ['relay', url]),
    },
    keypair.secretKey,
  );
}

// --- Persistence (KV port — same pattern as machines/outbox/settings) ---

export interface DmPersisted {
  conversations: Record<string, DmConversation>;
  messages: Record<string, DmMessage[]>;
  profiles: Record<string, DmProfile>;
}

const emptyPersisted = (): DmPersisted => ({ conversations: {}, messages: {}, profiles: {} });

export function hydrateDm(raw: string | undefined): DmPersisted {
  if (!raw) return emptyPersisted();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyPersisted();
  }
  if (typeof parsed !== 'object' || parsed === null) return emptyPersisted();
  const p = parsed as Partial<DmPersisted>;
  const conversations: Record<string, DmConversation> = {};
  for (const [peer, conv] of Object.entries(p.conversations ?? {})) {
    if (typeof conv !== 'object' || conv === null) continue;
    if (typeof conv.peerPubkey !== 'string' || conv.peerPubkey.length === 0) continue;
    conversations[peer] = {
      peerPubkey: conv.peerPubkey,
      protocol: 'nip17',
      lastMessageAt: typeof conv.lastMessageAt === 'number' ? conv.lastMessageAt : 0,
      unreadCount: typeof conv.unreadCount === 'number' ? conv.unreadCount : 0,
      lastPreview: typeof conv.lastPreview === 'string' ? conv.lastPreview : '',
    };
  }
  const messages: Record<string, DmMessage[]> = {};
  for (const [peer, list] of Object.entries(p.messages ?? {})) {
    if (!Array.isArray(list)) continue;
    messages[peer] = list.filter(
      (m): m is DmMessage =>
        typeof m === 'object' && m !== null &&
        typeof (m as DmMessage).id === 'string' &&
        typeof (m as DmMessage).content === 'string',
    );
  }
  const profiles: Record<string, DmProfile> = {};
  for (const [peer, profile] of Object.entries(p.profiles ?? {})) {
    if (typeof profile !== 'object' || profile === null) continue;
    if (typeof profile.fetchedAt !== 'number') continue;
    profiles[peer] = profile;
  }
  return { conversations, messages, profiles };
}

export async function loadPersistedDm(
  kv: KV,
  storageKey: string = DM_STORAGE_KEY,
): Promise<DmPersisted> {
  return hydrateDm(await kv.get(storageKey));
}

// --- Store ---

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

export interface DmStoreDeps {
  kv: KV;
  transport: PhoneTransport;
  /** The phone keypair — identityStore owns it (plan §5: keypair OUT of dmStore). */
  keypair(): Keypair;
  /** Current relay list (settings) — the 10050 advertisement + send targets. */
  relays(): readonly string[];
  now?(): number;
  profileFetcher?: ProfileFetcher;
  /** A NEW incoming message was stored (dedup already passed). `countsUnread`
   *  is the per-conversation unread gate: false while that conversation is
   *  open. The 5c notifier listens here — store-driven, never relay-sniffed. */
  onIncoming?(msg: DmMessage, countsUnread: boolean): void;
  /** Phase 6 (CDX-012): a 1059 unwrapped fine but its rumor is NOT a kind-14
   *  DM. Marmot welcomes (kind-444 rumors) arrive on this SAME gift-wrap
   *  subscription — return true to claim the ORIGINAL 1059 event (it is
   *  handed to the Marmot engine, which unwraps with its own keys); false/
   *  absent keeps the old count-as-invalid behavior. */
  onWrappedRumor?(event: NostrEvent, rumorKind: number): boolean;
  storageKey?: string;
  log?: Logger;
}

export function createDmStore(deps: DmStoreDeps, initial?: DmPersisted): DmStore {
  const now = deps.now ?? Date.now;
  const storageKey = deps.storageKey ?? DM_STORAGE_KEY;
  const log = deps.log ?? (() => {});
  const init = initial ?? emptyPersisted();

  // Subscription epoch guard (same pattern as PhoneNostrClient): callbacks
  // from a superseded subscription are ignored, deliberate teardown is silent.
  let epoch = 0;
  let sub: TransportSubscription | null = null;

  /** Last 10050 payload published this app run (replaceable — republish only
   *  when the relay list actually changed). */
  let publishedRelayList: string | null = null;

  /** In-flight profile fetches (dedup concurrent callers). */
  const profileInFlight = new Map<string, Promise<void>>();

  const store = createStore<DmStoreState>()((set, get) => {
    const persist = (): void => {
      const { conversations, messages, profiles } = get();
      void deps.kv
        .set(storageKey, JSON.stringify({ conversations, messages, profiles }))
        .catch((err) => log(`[DM] persist failed: ${err}`));
    };

    /** Insert a message with structural dedup; upsert its conversation. */
    const addMessage = (msg: DmMessage): boolean => {
      const state = get();
      const existing = state.messages[msg.peerPubkey] ?? [];

      // Primary dedup: rumor id (covers the self-wrap echo of our own sends).
      if (existing.some((m) => m.id === msg.id)) return false;

      // Fallback dedup (ported): same sender + content within the window —
      // other NIP-17 clients can generate a different rumor id per copy.
      const isDuplicate = existing.some(
        (m) =>
          m.senderPubkey === msg.senderPubkey &&
          m.content === msg.content &&
          Math.abs(m.at - msg.at) < CONTENT_DEDUP_WINDOW_S * 1000,
      );
      if (isDuplicate) {
        log(`[DM] content-dedup: skipping duplicate of ${msg.id.slice(0, 12)}…`);
        return false;
      }

      // Insert in `at` order (catch-up can replay history in any order),
      // then cap the conversation.
      let list = [...existing, msg].sort((a, b) => a.at - b.at);
      if (list.length > MAX_MESSAGES_PER_CONVERSATION) {
        list = list.slice(-MAX_MESSAGES_PER_CONVERSATION);
      }

      const me = deps.keypair().pubkeyHex;
      const prev = state.conversations[msg.peerPubkey];
      const isIncoming = msg.senderPubkey !== me;
      const countsUnread = isIncoming && state.activePeer !== msg.peerPubkey;
      const newest = list[list.length - 1]!;
      const conversation: DmConversation = {
        peerPubkey: msg.peerPubkey,
        protocol: 'nip17',
        lastMessageAt: newest.at,
        unreadCount: (prev?.unreadCount ?? 0) + (countsUnread ? 1 : 0),
        lastPreview: newest.content,
      };

      set({
        messages: { ...state.messages, [msg.peerPubkey]: list },
        conversations: { ...state.conversations, [msg.peerPubkey]: conversation },
      });
      persist();

      // A conversation auto-created by an incoming message resolves its
      // peer's profile (ported).
      if (!prev) void get().resolveProfile(msg.peerPubkey);
      if (isIncoming) deps.onIncoming?.(msg, countsUnread);
      return true;
    };

    return {
      conversations: init.conversations,
      messages: init.messages,
      activePeer: null,
      subscribed: false,
      diagnostics: { eventsReceived: 0, unwrapFailures: 0, invalidRumors: 0 },
      profiles: init.profiles,
      profileStatus: {},

      start: () => {
        // Supersede any previous subscription (fresh epoch).
        epoch++;
        const myEpoch = epoch;
        sub?.close();

        const me = deps.keypair().pubkeyHex;
        const since = dmSinceCursor(get().messages);
        const filter = buildDmFilter(me, since);
        log(
          `[DM] subscribing kinds=[${GIFT_WRAP_KIND}] since=${since ?? 'none (full history)'}`,
        );
        sub = deps.transport.subscribe(filter, {
          onEvent: (event) => {
            if (myEpoch !== epoch) return; // superseded
            get().ingest(event);
          },
          onClose: () => {
            if (myEpoch !== epoch) return; // deliberate teardown elsewhere
            // The app-wide socket died with it; the connection FSM restarts
            // both subscriptions via open-socket on reconnect.
            sub = null;
            set({ subscribed: false });
          },
        });
        set({ subscribed: true });

        // Advertise our DM relay list (kind 10050, replaceable) so NIP-17
        // peers know where to deliver — republished only when it changes.
        const relays = deps.relays();
        const payload = JSON.stringify(relays);
        if (payload !== publishedRelayList && relays.length > 0) {
          // Mark BEFORE the async publish settles so a reconnect storm never
          // double-publishes; a failure resets the marker for the next start.
          publishedRelayList = payload;
          const event = buildDmRelayListEvent(
            deps.keypair(),
            relays,
            Math.floor(now() / 1000),
          );
          void deps.transport
            .publish(event)
            .then((ok) => {
              if (!ok) {
                publishedRelayList = null;
                log('[DM] kind-10050 relay list rejected by all relays');
              }
            })
            .catch((err) => {
              publishedRelayList = null;
              log(`[DM] kind-10050 publish failed: ${err}`);
            });
        }
      },

      stop: () => {
        epoch++; // orphan in-flight callbacks BEFORE closing
        const s = sub;
        sub = null;
        s?.close();
        set({ subscribed: false });
      },

      send: async (peerPubkey, content) => {
        const keypair = deps.keypair();
        const me = keypair.pubkeyHex;

        try {
          // Rumor ONCE — its id is the message id across all copies (dedup).
          const rumor = createRumor(
            { kind: DM_RUMOR_KIND, content, tags: [['p', peerPubkey]] },
            keypair.secretKey,
          );

          // Recipient copy + self copy (own messages survive restarts).
          const wrapForRecipient = createWrap(
            createSeal(rumor, keypair.secretKey, peerPubkey),
            peerPubkey,
          );
          const wrapForSelf = createWrap(
            createSeal(rumor, keypair.secretKey, me),
            me,
          );

          const [recipientOk, selfOk] = await Promise.all([
            deps.transport.publish(wrapForRecipient),
            deps.transport.publish(wrapForSelf),
          ]);
          if (!selfOk) log('[DM] self-copy wrap rejected by all relays');

          const msg: DmMessage = {
            id: rumor.id,
            peerPubkey,
            senderPubkey: me,
            content,
            at: rumor.created_at * 1000,
            status: recipientOk ? 'sent' : 'failed',
          };
          addMessage(msg);
          if (!recipientOk) log('[DM] send failed: no relay accepted the recipient wrap');
          return msg;
        } catch (err) {
          log(`[DM] send threw: ${err instanceof Error ? err.message : String(err)}`);
          const msg: DmMessage = {
            id: globalThis.crypto.randomUUID(),
            peerPubkey,
            senderPubkey: me,
            content,
            at: now(),
            status: 'failed',
          };
          addMessage(msg);
          return msg;
        }
      },

      retry: async (peerPubkey, messageId) => {
        const failed = (get().messages[peerPubkey] ?? []).find(
          (m) => m.id === messageId && m.status === 'failed',
        );
        if (!failed) return;
        // Remove the failed entry FIRST — the content-dedup would otherwise
        // reject the resend as a duplicate of it. If the resend fails again,
        // a fresh failed entry (still retryable) takes its place.
        const state = get();
        set({
          messages: {
            ...state.messages,
            [peerPubkey]: (state.messages[peerPubkey] ?? []).filter((m) => m.id !== messageId),
          },
        });
        persist();
        await get().send(peerPubkey, failed.content);
      },

      startConversation: (peerInput) => {
        const peer = parsePeerInput(peerInput);
        if (peer === null) return null;
        const state = get();
        if (!state.conversations[peer]) {
          set({
            conversations: {
              ...state.conversations,
              [peer]: {
                peerPubkey: peer,
                protocol: 'nip17',
                lastMessageAt: now(),
                unreadCount: 0,
                lastPreview: '',
              },
            },
          });
          persist();
          void get().resolveProfile(peer);
        }
        get().setActivePeer(peer);
        return peer;
      },

      setActivePeer: (peerPubkey) => {
        set({ activePeer: peerPubkey });
        if (peerPubkey) get().markRead(peerPubkey);
      },

      markRead: (peerPubkey) => {
        const conv = get().conversations[peerPubkey];
        if (!conv || conv.unreadCount === 0) return;
        set({
          conversations: {
            ...get().conversations,
            [peerPubkey]: { ...conv, unreadCount: 0 },
          },
        });
        persist();
      },

      resolveProfile: async (pubkeyHex, opts) => {
        const fetcher = deps.profileFetcher;
        if (!fetcher) return;

        const cached = get().profiles[pubkeyHex];
        if (
          !opts?.force &&
          cached &&
          cached.status === 'ok' &&
          now() - cached.fetchedAt < PROFILE_CACHE_TTL_MS
        ) {
          set({ profileStatus: { ...get().profileStatus, [pubkeyHex]: 'ok' } });
          return;
        }

        const inFlight = profileInFlight.get(pubkeyHex);
        if (inFlight) return inFlight;

        set({ profileStatus: { ...get().profileStatus, [pubkeyHex]: 'loading' } });
        const task = (async (): Promise<void> => {
          const meta = await fetcher(pubkeyHex);
          set({
            profiles: { ...get().profiles, [pubkeyHex]: meta },
            profileStatus: {
              ...get().profileStatus,
              // notfound is cached (cheap retry later) but surfaces as an
              // error state so the UI shows a tap-to-retry (ported).
              [pubkeyHex]: meta.status === 'ok' ? 'ok' : 'error',
            },
          });
          persist();
        })().finally(() => profileInFlight.delete(pubkeyHex));
        profileInFlight.set(pubkeyHex, task);
        return task;
      },

      resolveAllProfiles: () => {
        void get().resolveProfile(deps.keypair().pubkeyHex);
        for (const peer of Object.keys(get().conversations)) {
          void get().resolveProfile(peer);
        }
      },

      ingest: (event) => {
        if (event.kind !== GIFT_WRAP_KIND) return;
        const diagnostics = get().diagnostics;
        set({ diagnostics: { ...diagnostics, eventsReceived: diagnostics.eventsReceived + 1 } });

        const keypair = deps.keypair();
        let rumorRaw: unknown;
        try {
          rumorRaw = unwrapEvent(event, keypair.secretKey);
        } catch (err) {
          // CD-001: the old processGiftWrap swallowed this silently. Count it,
          // log it, drop the event — never throw, never fake a disconnect.
          const d = get().diagnostics;
          set({ diagnostics: { ...d, unwrapFailures: d.unwrapFailures + 1 } });
          log(
            `[DM] unwrap failed for ${event.id.slice(0, 12)}… (failure #${d.unwrapFailures + 1}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return;
        }

        const parsed = dmRumorSchema.safeParse(rumorRaw);
        // Not a DM but a well-formed rumor of another kind (a Marmot 444
        // welcome, most likely): offer it to the Phase 6 router before
        // counting it invalid.
        if (parsed.success && parsed.data.kind !== DM_RUMOR_KIND) {
          if (deps.onWrappedRumor?.(event, parsed.data.kind)) return;
        }
        if (!parsed.success || parsed.data.kind !== DM_RUMOR_KIND) {
          const d = get().diagnostics;
          set({ diagnostics: { ...d, invalidRumors: d.invalidRumors + 1 } });
          log(
            `[DM] dropping non-DM rumor from wrap ${event.id.slice(0, 12)}… (${
              parsed.success ? `kind ${parsed.data.kind}` : 'schema mismatch'
            })`,
          );
          return;
        }
        const rumor = parsed.data;

        const me = keypair.pubkeyHex;
        const sender = rumor.pubkey.toLowerCase();
        // Self-copies: the peer is the p-tag, not the sender (ported).
        const pTags = rumor.tags.filter((t) => t[0] === 'p' && t[1]).map((t) => t[1]!);
        const peerPubkey = sender === me ? (pTags[0] ?? sender) : sender;

        addMessage({
          id: rumor.id,
          peerPubkey,
          senderPubkey: sender,
          content: rumor.content,
          at: rumor.created_at * 1000,
          status: sender === me ? 'sent' : 'delivered',
        });
      },
    };
  });

  return store;
}
