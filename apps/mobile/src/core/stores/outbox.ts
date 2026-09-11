/**
 * Outbox types shared by the native adapter (`nativeOutbox.ts`) and the UI
 * (`coreContext.tsx`, `transcript/outboxCoverage.ts`,
 * `transcript/rows/OutboxRow.tsx`).
 *
 * The lifecycle (pending → published → confirmed/failed), the confirm
 * timeout sweep, and the CDX-013 retention cap are Rust's job now
 * (`client_core::stores::outbox`) — only the shared TYPES survive here.
 */
import type { StoreApi } from 'zustand/vanilla';

export type OutboxItemState = 'pending' | 'published' | 'confirmed' | 'failed';

export interface OutboxItem {
  /** Also the wire `inputId` echoed back by input-ack. */
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

export interface OutboxStoreState {
  items: Record<string, OutboxItem>;

  /** Create + publish one input. Resolves when the publish attempt settles. */
  send(machine: string, sessionId: string, text: string): Promise<OutboxItem>;
  /** input-ack from the bridge. */
  confirm(inputId: string): void;
  /** input-failed from the bridge. */
  fail(inputId: string, reason: string): void;
  /** Re-publish a failed item (user action). */
  retry(id: string): Promise<OutboxItem | undefined>;
  /** Time out unanswered sends: pending/published older than the timeout →
   *  failed (visible + retryable). Call on heartbeat/reconnect ticks. */
  sweep(): void;

  item(id: string): OutboxItem | undefined;
  itemsFor(machine: string, sessionId: string): OutboxItem[];
  unresolved(): OutboxItem[];
}

export type OutboxStore = StoreApi<OutboxStoreState>;
