/**
 * ManualTimers — a virtual-clock implementation of @codedeck/core's SyncTimers
 * seam. Contract tests inject it into BridgeCore (`syncTimers`) so the sync
 * server's ack-retry backoff (10s/20s/40s) and idle timeout run on test-driven
 * time instead of real waits: `advance(ms)` fires everything due, in due order.
 */
import type { SyncTimers } from '@codedeck/core';

interface ScheduledTask {
  at: number;
  fn: () => void;
}

export class ManualTimers implements SyncTimers {
  private nowMs = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, ScheduledTask>();

  set(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.nowMs + ms, fn });
    return id;
  }

  clear(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  /** Number of scheduled, not-yet-fired timers. */
  pendingCount(): number {
    return this.tasks.size;
  }

  /**
   * Move the virtual clock forward and fire every timer that comes due, in
   * schedule order. Timers set BY a fired callback for a later virtual time do
   * not fire within the same advance (they are due in the future).
   */
  advance(ms: number): void {
    this.nowMs += ms;
    const due = [...this.tasks.entries()]
      .filter(([, task]) => task.at <= this.nowMs)
      .sort((a, b) => a[1].at - b[1].at);
    for (const [id, task] of due) {
      if (!this.tasks.has(id)) continue; // cleared by an earlier callback
      this.tasks.delete(id);
      task.fn();
    }
  }
}
