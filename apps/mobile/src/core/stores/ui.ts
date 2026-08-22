/**
 * uiStore — UI selection + optimistic interaction-card state (Phase 3a/3c).
 * Deliberately tiny: no view logic lives in the core.
 *
 * respondedCards: when the user answers a permission/plan/question card the
 * phone marks it responded IMMEDIATELY (optimistic — the durable proof is the
 * tool_result that eventually lands in the transcript). Keyed per session so
 * two sessions can never cross-talk. planApprovalChoices remembers WHICH plan
 * option was tapped so the resolved card can label itself before the bridge
 * echoes anything.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';

/** Canonical machine+session key — the same `${machine} ${sessionId}` format
 *  the transcript store and the UI screens compose locally. */
export const sessionKeyOf = (machine: string, sessionId: string): string =>
  `${machine} ${sessionId}`;

/** Which conversation surface the main panel shows (Phase 2 renders it; the
 *  core needs it now for unread-clearing and the ping "am I viewing this?"
 *  decision). */
export type PanelMode = 'session' | 'dm' | 'marmot';

/**
 * Fire-and-answer feedback for set-credentials / set-device-config (CDX-011:
 * the formerly-unrouted acks). Transient by design — never persisted; a fresh
 * boot starts with no stale "saved" claims.
 */
export interface CredentialsAckState {
  state: 'saving' | 'saved' | 'failed';
  at: number;
  hasAnthropicKey?: boolean;
  hasGithubPat?: boolean;
  /** Bridge-side 1-token validation outcome; absent = not validated (network). */
  keyValid?: boolean;
  error?: string;
}

export interface DeviceConfigAckState {
  state: 'saving' | 'saved' | 'failed';
  at: number;
  error?: string;
}

/** CDX-062: fire-and-answer feedback for set-provider-profile, mirroring the
 *  credentials slice. Transient by design — never persisted; the profile list
 *  itself is bridge-authoritative machines-slice state, this is only the last
 *  round-trip's verdict. */
export interface ProviderProfileAckState {
  state: 'saving' | 'saved' | 'failed';
  at: number;
  /** Which profile the latest round-trip was about (ack routing detail). */
  profileId?: string;
  /** Bridge-side 1-token probe verdict; absent = probe could not run (network). */
  tokenValid?: boolean;
  error?: string;
}

/** The bottom "Deleted X — Undo" toast for a pending session delete. The
 *  deleteController owns its 4s lifecycle; this is only what the UI renders.
 *  Transient by design — never persisted. */
export interface UndoToastState {
  machine: string;
  sessionId: string;
  label: string;
}

export interface UiStoreState {
  selectedMachine: string | null;
  selectedSession: string | null;
  /** Which surface the main panel shows; DM/marmot selection flips it. */
  panelMode: PanelMode;
  /** DM conversation open in the panel (mirrors dm store's activePeer). */
  activeDmPeer: string | null;
  /** Marmot group open in the panel (mirrors marmot store's activeGroup). */
  activeMarmotGroup: string | null;
  /** sessionKeyOf(machine, sessionId) → has unread activity (the attention
   *  dot's isUnread input — see core/sessionNeedsAttention). Transient by
   *  design: a fresh boot starts with no stale dots. */
  unreadSessions: ReadonlySet<string>;
  /** sessionKey → set of optimistically-responded card ids (tool_use_ids). */
  respondedCards: Record<string, ReadonlySet<string>>;
  /** cardId → plan-approval key ('1' | '2' | '3') the user tapped. */
  planApprovalChoices: Record<string, string>;
  /** machine pubkey → latest set-credentials round-trip state. */
  credentialsStatus: Record<string, CredentialsAckState>;
  /** machine pubkey → latest set-device-config round-trip state. */
  deviceConfigStatus: Record<string, DeviceConfigAckState>;
  /** machine pubkey → latest set-provider-profile round-trip state (CDX-062). */
  providerProfileStatus: Record<string, ProviderProfileAckState>;
  /** Pending-delete undo toast (deleteController writes, UndoToast renders). */
  undoToast: UndoToastState | null;

  selectMachine(pubkeyHex: string | null): void;
  selectSession(machinePubkey: string, sessionId: string | null): void;
  /** Open a DM conversation (or null = the DM list) — panelMode follows. */
  selectDmPeer(peerPubkey: string | null): void;
  /** Open a Marmot group (or null = the list) — panelMode follows. */
  selectMarmotGroup(groupId: string | null): void;
  markSessionUnread(machine: string, sessionId: string): void;
  clearSessionUnread(machine: string, sessionId: string): void;
  isSessionUnread(machine: string, sessionId: string): boolean;
  markCardResponded(machine: string, sessionId: string, cardId: string): void;
  isCardResponded(machine: string, sessionId: string, cardId: string): boolean;
  setPlanApprovalChoice(cardId: string, key: string): void;

  /** A set-credentials command left for this machine — show "saving…". */
  noteCredentialsSent(machinePubkey: string): void;
  applyCredentialsAck(
    machinePubkey: string,
    ack: { success: boolean; hasAnthropicKey: boolean; hasGithubPat: boolean; keyValid?: boolean; error?: string },
  ): void;
  /** A set-device-config command left for this machine — show "saving…". */
  noteDeviceConfigSent(machinePubkey: string): void;
  applyDeviceConfigAck(machinePubkey: string, ack: { success: boolean; error?: string }): void;
  /** A set-provider-profile command left for this machine — show "saving…". */
  noteProviderProfileSent(machinePubkey: string, profileId: string): void;
  applyProviderProfileAck(
    machinePubkey: string,
    ack: { profileId: string; success: boolean; tokenValid?: boolean; error?: string },
  ): void;

  setUndoToast(toast: UndoToastState | null): void;
}

export type UiStore = StoreApi<UiStoreState>;

export interface UiStoreDeps {
  now?(): number;
  /** App visibility (the connection FSM tracks it, debounced). Selecting a
   *  session only clears its unread mark while the app is actually visible —
   *  a background selection change must not eat the dot. Default: visible. */
  visible?(): boolean;
  /** CDX-026c: the user opened this session in view (same visible-app gate as
   *  the unread clear) — cancel its delivered OS notifications. */
  onSessionViewed?(machine: string, sessionId: string): void;
  /** CDX-026c: the user opened this DM conversation — cancel that peer's
   *  delivered OS notifications. */
  onDmOpened?(peerPubkey: string): void;
}

export function createUiStore(deps: UiStoreDeps = {}): UiStore {
  const now = deps.now ?? Date.now;
  const visible = deps.visible ?? ((): boolean => true);

  return createStore<UiStoreState>()((set, get) => {
    /** Delete `key` from unreadSessions if present ({} = no change). */
    const withUnreadCleared = (key: string): Partial<UiStoreState> => {
      const unread = get().unreadSessions;
      if (!unread.has(key)) return {};
      const next = new Set(unread);
      next.delete(key);
      return { unreadSessions: next };
    };

    return {
    selectedMachine: null,
    selectedSession: null,
    panelMode: 'session',
    activeDmPeer: null,
    activeMarmotGroup: null,
    unreadSessions: new Set<string>(),
    respondedCards: {},
    planApprovalChoices: {},
    credentialsStatus: {},
    deviceConfigStatus: {},
    providerProfileStatus: {},
    undoToast: null,

    selectMachine: (pubkeyHex) =>
      set({ selectedMachine: pubkeyHex, selectedSession: null, panelMode: 'session' }),
    // Opening/viewing a session clears its unread dot — but only when the app
    // is actually visible (old-app semantics: a hidden app keeps the dot).
    // The same gate cancels the session's delivered OS notifications
    // (CDX-026c): answered permissions / read turns leave the shade.
    selectSession: (machinePubkey, sessionId) => {
      const viewed = sessionId !== null && visible();
      set({
        selectedMachine: machinePubkey,
        selectedSession: sessionId,
        panelMode: 'session',
        ...(viewed ? withUnreadCleared(sessionKeyOf(machinePubkey, sessionId!)) : {}),
      });
      if (viewed) deps.onSessionViewed?.(machinePubkey, sessionId!);
    },
    selectDmPeer: (peerPubkey) => {
      set({ activeDmPeer: peerPubkey, panelMode: 'dm' });
      // Opening a conversation reads it — its notifications go (CDX-026c).
      if (peerPubkey !== null) deps.onDmOpened?.(peerPubkey);
    },
    selectMarmotGroup: (groupId) => set({ activeMarmotGroup: groupId, panelMode: 'marmot' }),

    markSessionUnread: (machine, sessionId) => {
      const key = sessionKeyOf(machine, sessionId);
      const unread = get().unreadSessions;
      if (unread.has(key)) return;
      set({ unreadSessions: new Set(unread).add(key) });
    },
    clearSessionUnread: (machine, sessionId) => {
      const patch = withUnreadCleared(sessionKeyOf(machine, sessionId));
      if ('unreadSessions' in patch) set(patch);
    },
    isSessionUnread: (machine, sessionId) =>
      get().unreadSessions.has(sessionKeyOf(machine, sessionId)),

    markCardResponded: (machine, sessionId, cardId) => {
      const key = sessionKeyOf(machine, sessionId);
      const prev = get().respondedCards[key];
      const next = new Set(prev ?? []);
      next.add(cardId);
      set({ respondedCards: { ...get().respondedCards, [key]: next } });
    },
    isCardResponded: (machine, sessionId, cardId) =>
      get().respondedCards[sessionKeyOf(machine, sessionId)]?.has(cardId) ?? false,
    setPlanApprovalChoice: (cardId, key) =>
      set({ planApprovalChoices: { ...get().planApprovalChoices, [cardId]: key } }),

    noteCredentialsSent: (machinePubkey) =>
      set({
        credentialsStatus: {
          ...get().credentialsStatus,
          [machinePubkey]: { state: 'saving', at: now() },
        },
      }),
    applyCredentialsAck: (machinePubkey, ack) =>
      set({
        credentialsStatus: {
          ...get().credentialsStatus,
          [machinePubkey]: {
            state: ack.success ? 'saved' : 'failed',
            at: now(),
            hasAnthropicKey: ack.hasAnthropicKey,
            hasGithubPat: ack.hasGithubPat,
            ...(ack.keyValid !== undefined ? { keyValid: ack.keyValid } : {}),
            ...(ack.error !== undefined ? { error: ack.error } : {}),
          },
        },
      }),
    noteDeviceConfigSent: (machinePubkey) =>
      set({
        deviceConfigStatus: {
          ...get().deviceConfigStatus,
          [machinePubkey]: { state: 'saving', at: now() },
        },
      }),
    applyDeviceConfigAck: (machinePubkey, ack) =>
      set({
        deviceConfigStatus: {
          ...get().deviceConfigStatus,
          [machinePubkey]: {
            state: ack.success ? 'saved' : 'failed',
            at: now(),
            ...(ack.error !== undefined ? { error: ack.error } : {}),
          },
        },
      }),

    noteProviderProfileSent: (machinePubkey, profileId) =>
      set({
        providerProfileStatus: {
          ...get().providerProfileStatus,
          [machinePubkey]: { state: 'saving', at: now(), profileId },
        },
      }),
    applyProviderProfileAck: (machinePubkey, ack) =>
      set({
        providerProfileStatus: {
          ...get().providerProfileStatus,
          [machinePubkey]: {
            state: ack.success ? 'saved' : 'failed',
            at: now(),
            profileId: ack.profileId,
            ...(ack.tokenValid !== undefined ? { tokenValid: ack.tokenValid } : {}),
            ...(ack.error !== undefined ? { error: ack.error } : {}),
          },
        },
      }),

    setUndoToast: (toast) => set({ undoToast: toast }),
    };
  });
}
