/**
 * UI selection + optimistic interaction-card TYPES, shared by the native
 * adapter (`nativeUi.ts`) and the UI (`coreContext.tsx`, `Sidebar.tsx`,
 * `useAttentionDirection.ts`).
 *
 * The mutations (select/mark/respond/ack bookkeeping) are Rust's job now
 * (`client_core::stores::ui`) — only `sessionKeyOf` (a pure formatter the UI
 * calls directly) and the shared TYPES survive here.
 */
import type { StoreApi } from 'zustand/vanilla';

/** Canonical machine+session key — the same `${machine} ${sessionId}` format
 *  the transcript store and the UI screens compose locally. */
export const sessionKeyOf = (machine: string, sessionId: string): string =>
  `${machine} ${sessionId}`;

/** Which conversation surface the main panel shows. */
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

/** The bottom "Deleted X — Undo" toast for a pending session delete.
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
  /** Pending-delete undo toast. */
  undoToast: UndoToastState | null;

  selectSession(machinePubkey: string, sessionId: string | null): void;
  /** Open a DM conversation (or null = the DM list) — panelMode follows. */
  selectDmPeer(peerPubkey: string | null): void;
  /** Open a Marmot group (or null = the list) — panelMode follows. */
  selectMarmotGroup(groupId: string | null): void;
  isSessionUnread(machine: string, sessionId: string): boolean;
  /** Optimistic local mark; Rust applies the same transition as a side effect
   *  of `Intent::RespondPermission`, so the next refresh reflects it either
   *  way — this just avoids a one-frame flicker back to "unresponded". */
  markCardResponded(machine: string, sessionId: string, cardId: string): void;
  isCardResponded(machine: string, sessionId: string, cardId: string): boolean;
  setPlanApprovalChoice(cardId: string, key: string): void;

  /** A set-credentials command left for this machine — show "saving…". */
  noteCredentialsSent(machinePubkey: string): void;
  /** A set-device-config command left for this machine — show "saving…". */
  noteDeviceConfigSent(machinePubkey: string): void;
  /** A set-provider-profile command left for this machine — show "saving…". */
  noteProviderProfileSent(machinePubkey: string, profileId: string): void;
}

export type UiStore = StoreApi<UiStoreState>;
