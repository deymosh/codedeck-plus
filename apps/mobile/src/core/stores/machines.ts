/**
 * Machine/session types shared by the native adapter (`nativeMachines.ts`)
 * and the UI (`coreContext.tsx`, `Sidebar.tsx`, `getOrderedSessionKeys.ts`,
 * `deleteController` no longer exists — see git history for the retired
 * local composition).
 *
 * The merge policy this file used to implement in TS — sessions present in
 * an incoming list are upserted, absence never deletes (only an explicit
 * tombstone removes a session), machines keyed by pubkey — is Rust's job now
 * (`client_core::stores::machines::MachinesState::apply_session_list`,
 * ported verbatim and covered by its own property test). Only the shared
 * TYPES survive here.
 */
import type { StoreApi } from 'zustand/vanilla';
import type {
  BridgeHostKind,
  GsdState,
  ProviderProfileInfo,
  RemoteSessionInfo,
  UsageData,
} from '../nativeCoreTypes';

export type ListingPresence = 'live' | 'stale' | 'offline';

export interface SessionView {
  info: RemoteSessionInfo;
  presence: ListingPresence;
  /** ms timestamp this session was last present in an incoming list. */
  lastListedAt: number;
  /** Latest claude.ai usage snapshot (usage message, 3c routing). */
  usage?: UsageData;
  /** Latest GSD workflow state (gsd-state message, 3c routing — stored, not
   *  rendered until the Phase-5 strip; never dropped). */
  gsd?: GsdState;
}

export interface MachineView {
  pubkeyHex: string;
  /** Machine name from the last heartbeat (or pairing), UI display. */
  name: string;
  /** Which host binary — badge only, never identity. */
  host?: BridgeHostKind;
  /** User-facing label captured at pairing time. */
  label?: string;
  capabilities: string[];
  folders: string[];
  /** CDX-031: absolute workspace roots in `--workspace` order. `folders` lists
   *  what is inside them and can never name a root, so this is the only way
   *  the picker can offer root 2..N. Empty on pre-CDX-031 bridges. */
  roots: string[];
  protocolVersion: number | null;
  machineOffline: boolean;
  lastHeartbeatAt: number | null;
  sessions: Record<string, SessionView>;
  /** SDK-reported model list (models message, 3c routing). Machines are keyed
   *  by pubkey, so two hosts on one box each keep their own list. */
  models?: Array<{ id: string; label?: string }>;
  defaultModel?: string;
  /** CDX-035: why the bridge could not answer with a list (models message with
   *  an empty `models` + `error`). Rendered next to the picker; cleared by the
   *  next non-empty answer. */
  modelsError?: string;
  /** CDX-062: the bridge's REDACTED custom-provider profile list (each entry
   *  carries `hasToken`, never the token). Bridge-authoritative + in-memory
   *  only: `undefined` = "not fetched this boot" and drives the re-request
   *  loop; `[]` = the bridge genuinely stores zero profiles. */
  providerProfiles?: ProviderProfileInfo[];
}

export interface MachinesStoreState {
  machines: Record<string, MachineView>;
  /** sessionId → dismissedAtMs for user-deleted sessions in their undo/settle
   *  window. IN-MEMORY ONLY. Entries expire after a TTL Rust owns. */
  dismissedSessions: Record<string, number>;

  machine(pubkeyHex: string): MachineView | undefined;
  session(machinePubkey: string, sessionId: string): SessionView | undefined;
  machinePubkeys(): string[];
}

export type MachinesStore = StoreApi<MachinesStoreState>;
