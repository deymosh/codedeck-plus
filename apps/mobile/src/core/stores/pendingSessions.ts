/**
 * Pending-session types shared by the native adapter
 * (`nativePendingSessions.ts`) and the UI (`coreContext.tsx`).
 *
 * Applying `session-pending`/`session-ready`/`session-failed` and sweeping
 * stale placeholders is Rust's job now
 * (`client_core::stores::pending_sessions`) — only the shared TYPES survive
 * here.
 */
import type { StoreApi } from 'zustand/vanilla';

export type PendingSessionState = 'pending' | 'failed';

export interface PendingSessionView {
  pendingId: string;
  machine: string;
  /** Machine display name from the message (not the pubkey). */
  machineName: string;
  createdAt: string;
  state: PendingSessionState;
  /** Set when state === 'failed'. */
  reason?: string;
  /** ms timestamp the placeholder appeared (sweep bookkeeping). */
  seenAt: number;
}

export interface PendingSessionsStoreState {
  pending: Record<string, PendingSessionView>;

  applyPending(machine: string, msg: { pendingId: string; machine: string; createdAt: string }): void;
  /** session-ready (or the session appearing in a list) resolves the placeholder. */
  resolve(pendingId: string): void;
  applyFailed(pendingId: string, reason: string): void;
  /** User dismisses a failed card. */
  dismiss(pendingId: string): void;
  /** Drop never-resolved placeholders older than the sweep window. */
  sweep(): void;

  pendingFor(machine: string): PendingSessionView[];
}

export type PendingSessionsStore = StoreApi<PendingSessionsStoreState>;
