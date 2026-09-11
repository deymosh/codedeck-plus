/**
 * TypeScript mirror of `client_runtime`'s `Intent` / `*View` / `CoreEvent`
 * types (migration plan §2) — the JSON shapes `nativeCore.ts`'s `dispatch` /
 * `*View()` / `onCoreEvent` cross the Tauri `invoke`/`listen` boundary with.
 *
 * Hand-written, not generated: kept in lockstep with the Rust side by eye,
 * same as every other wire type in this codebase before a schema-generation
 * step exists. Every Rust enum here is `#[serde(rename_all = "camelCase",
 * rename_all_fields = "camelCase")]` (or just `"camelCase"` for a
 * fieldless/single-field enum) — externally tagged, so a variant with fields
 * is `{"variantName": {...}}` and a unit variant is the bare string
 * `"variantName"`. See `crates/client-runtime/src/intent.rs` and
 * `crates/client-runtime/src/core.rs`'s `CoreEvent` for the source of truth;
 * both carry a dedicated round-trip test asserting the exact shape.
 *
 * Per plan §2.5 this surface is stabilized, not frozen, until the first
 * Compose consumer (F3) — expect additive changes, not a redesign.
 */
import type {
  EffortLevel,
  GsdState,
  PermissionMode,
  RemoteSessionInfo,
  UsageData,
} from '@codedeck/protocol';

// --- shared wire literals (mirrors client-core's wire enums) ---

export type PermissionModifier = 'always' | 'never';
export type KeypressContext = 'plan-approval' | 'question';
export type BridgeHostKind = 'cli' | 'vscode' | 'service';
export type ListingPresence = 'live' | 'stale' | 'offline';

// --- Intent (plan §2.2) ---

/** Bytes + mime, never a platform type — the UI decodes whatever
 *  picker/camera/resize API it has into this shape before dispatching. */
export interface SessionImageSend {
  machine: string;
  sessionId: string;
  text: string;
  /** Raw bytes. Crosses Tauri IPC as a plain number array. */
  image: number[];
  filename: string;
  mimeType: string;
}

export type Intent =
  | { sendInput: { machine: string; sessionId: string; text: string; inputId: string } }
  | { retryOutboxItem: { machine: string; id: string } }
  | { sendSessionImage: SessionImageSend }
  | { deleteSession: { machine: string; sessionId: string; label: string | null } }
  | 'undoDelete'
  | { beginPairing: { url: string; label: string } }
  | { beginManualPairing: { npub: string; token: string; label: string } }
  | { stagePairing: { url: string } }
  | { confirmStagedPairing: { label: string } }
  | 'dismissStagedPairing'
  | 'resetPairing'
  | {
      respondPermission: {
        machine: string;
        sessionId: string;
        requestId: string;
        allow: boolean;
        modifier: PermissionModifier | null;
      };
    }
  | { answerQuestion: { machine: string; sessionId: string; text: string; optionCount: number } }
  | {
      keypress: {
        machine: string;
        sessionId: string;
        key: string;
        context: KeypressContext | null;
      };
    }
  | { setMode: { machine: string; sessionId: string; mode: PermissionMode } }
  | { setEffort: { machine: string; sessionId: string; level: EffortLevel } }
  | { setModel: { machine: string; sessionId: string; model: string } }
  | { interrupt: { machine: string; sessionId: string } }
  | { closeSession: { machine: string; sessionId: string } }
  | {
      createSession: {
        machine: string;
        cwd: string | null;
        createCwd: boolean | null;
        model: string | null;
        defaultEffort: EffortLevel | null;
        providerId: string | null;
        testSession: boolean | null;
      };
    }
  | { refreshSessions: { machine: string } }
  | { requestModels: { machine: string } }
  | { requestUsage: { machine: string; sessionId: string } }
  | { requestGsd: { machine: string; sessionId: string } }
  | { selectSession: { machine: string; sessionId: string | null } }
  | { selectDmPeer: { peer: string | null } }
  | { markDmRead: { peer: string } }
  | { startDmConversation: { peerInput: string } }
  | { sendDm: { peer: string; text: string } }
  | { sendDmImage: { peer: string; text: string; image: number[] } }
  | { selectMarmotGroup: { groupId: string | null } }
  | { markMarmotRead: { groupId: string } }
  | { acceptMarmotWelcome: { welcomeId: string } }
  | { sendMarmotMessage: { groupId: string; text: string } }
  | { startMarmotChat: { peerPubkey: string } }
  | { addRelay: { url: string } }
  | { removeRelay: { url: string } }
  | { addRelays: { urls: string[] } }
  | { setTorEnabled: boolean }
  | { setStayConnected: boolean }
  | { setMeshTestTarget: boolean }
  | { setBlossomServer: string }
  | { setNotificationsEnabled: boolean }
  | { setDefaultMode: PermissionMode }
  /** Empty string = unset (the bridge/SDK default) — `EffortLevel` has no
   *  such variant, so this carries the raw wire string, same as the store. */
  | { setDefaultEffort: string }
  | { setDefaultModel: string }
  | { setUiScale: number }
  | { setShowUsageBadge: boolean }
  | { setShowCommitBadge: boolean }
  | { addQuickPrompt: { id: string; label: string; text: string } }
  | { updateQuickPrompt: { id: string; label: string; text: string } }
  | { removeQuickPrompt: { id: string } };

// --- Views (plan §2.1) ---

export interface SessionView {
  info: RemoteSessionInfo;
  presence: ListingPresence;
  lastListedAt: number;
  usage?: UsageData;
  gsd?: GsdState;
}

export interface MachineView {
  pubkeyHex: string;
  name: string;
  host?: BridgeHostKind;
  label?: string;
  capabilities: string[];
  folders: string[];
  roots: string[];
  protocolVersion?: number;
  machineOffline: boolean;
  lastHeartbeatAt?: number;
  sessions: Record<string, SessionView>;
}

export interface MachinesView {
  machines: Record<string, MachineView>;
}

/** `#[serde(transparent)]` on the Rust side — the view IS the settings
 *  object, no wrapper field. */
export interface SettingsView {
  relays: string[];
  uiScale: number;
  stayConnected: boolean;
  torProxyEnabled: boolean;
  meshTestTarget: boolean;
  blossomServer: string;
  defaultMode: PermissionMode;
  defaultEffort: string;
  defaultModel: string;
  notificationsEnabled: boolean;
  showUsageBadge: boolean;
  showCommitBadge: boolean;
}

export type OutboxItemState = 'pending' | 'published' | 'confirmed' | 'failed';

export interface OutboxItem {
  id: string;
  machine: string;
  sessionId: string;
  text: string;
  state: OutboxItemState;
  createdAt: number;
  publishedAt: number | null;
  confirmedAt: number | null;
  failedAt: number | null;
  error: string | null;
  attempts: number;
}

export interface OutboxView {
  items: OutboxItem[];
}

export interface PairingCandidateView {
  pubkeyHex: string;
  npub: string;
  machine: string;
  relays: string[];
}

export interface PairingView {
  phase: 'idle' | 'awaiting-ack' | 'paired' | 'failed';
  error: string | null;
  timedOut: boolean;
  hasStaged: boolean;
  candidate: PairingCandidateView | null;
}

export type DmProtocol = 'nip17' | 'marmot';
export type DmMessageStatus = 'sent' | 'delivered' | 'failed';

export interface DmConversation {
  peerPubkey: string;
  protocol: DmProtocol;
  lastMessageAt: number;
  unreadCount: number;
  lastPreview: string;
}

export interface DmMessage {
  id: string;
  peerPubkey: string;
  senderPubkey: string;
  content: string;
  at: number;
  status: DmMessageStatus;
}

export interface DmView {
  conversations: DmConversation[];
  messages: Record<string, DmMessage[]>;
  activePeer: string | null;
  eventsReceived: number;
  unwrapFailures: number;
  invalidRumors: number;
}

export type MarmotMessageStatus = 'sent' | 'delivered' | 'failed';

export interface MarmotConversation {
  groupId: string;
  hTag: string;
  peerPubkey: string;
  name: string;
  memberCount: number;
  lastMessageAt: number;
  unreadCount: number;
  lastPreview: string;
}

export interface MarmotMessage {
  id: string;
  groupId: string;
  senderPubkey: string;
  content: string;
  at: number;
  status: MarmotMessageStatus;
}

export interface MarmotView {
  conversations: MarmotConversation[];
  messages: Record<string, MarmotMessage[]>;
  activeGroup: string | null;
  eventsReceived: number;
  ignored: number;
  errors: number;
  buffered: number;
}

// --- CoreEvent (plan §2.3) ---

export type SliceId =
  | 'connection'
  | 'machines'
  | 'transcript'
  | 'outbox'
  | 'cards'
  | 'settings'
  | 'pairing'
  | 'dm'
  | 'marmot';

export type ActionFailedKind =
  | 'decryptFailed'
  | 'decodeFailed'
  | 'publishRejected'
  | 'publishUnreachable';

export type CoreEvent =
  | { stateChanged: { slice: SliceId } }
  | { outboxSettled: { id: string; delivered: boolean } }
  | { pairingSettled: { paired: boolean } }
  | { actionFailed: { kind: ActionFailedKind } };
