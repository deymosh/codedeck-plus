/**
 * outboxStore — nothing the user sends silently vanishes.
 *
 * Every input goes through an explicit lifecycle:
 *   pending   — created, publish to the relay not yet confirmed
 *   published — at least one relay accepted the kind-4515 event
 *   confirmed — the bridge echoed our inputId in an input-ack
 *   failed    — publish failed, the bridge said input-failed, or no ack within
 *               the timeout (sweep) — visible in the UI with a retry action
 *
 * Items are persisted through the KV port on every transition, so an app kill
 * mid-send leaves an honest 'pending'/'published' record that the next boot's
 * sweep surfaces as failed-with-retry instead of dropping on the floor.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { PhoneToBridgeMessage } from '@codedeck/protocol';
import type { KV, Logger } from '../ports';

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

export const OUTBOX_STORAGE_KEY = 'outbox';
export const OUTBOX_CONFIRM_TIMEOUT_MS = 30_000;

/** CDX-013 retention: the outbox previously grew without bound (every input
 *  ever sent stayed in the KV blob forever). Resolved items (confirmed/failed)
 *  beyond this cap are dropped oldest-first; unresolved items are NEVER
 *  dropped — nothing the user sent silently vanishes. */
export const MAX_OUTBOX_ITEMS = 200;

export function serializeOutbox(items: Record<string, OutboxItem>): string {
  return JSON.stringify(Object.values(items));
}

export function hydrateOutbox(raw: string | undefined): Record<string, OutboxItem> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!Array.isArray(parsed)) return {};
  const out: Record<string, OutboxItem> = {};
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as OutboxItem;
    if (typeof o.id !== 'string' || o.id.length === 0) continue;
    out[o.id] = o;
  }
  return out;
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

export interface OutboxStoreDeps {
  kv: KV;
  /** Publish an input command. Resolves true when a relay accepted it. */
  publish(machine: string, msg: PhoneToBridgeMessage): Promise<boolean>;
  now(): number;
  newId(): string;
  confirmTimeoutMs?: number;
  storageKey?: string;
  /** CDX-013 retention cap (default MAX_OUTBOX_ITEMS). */
  maxItems?: number;
  /** Fired on every user send, BEFORE the publish attempt. createPhoneCore
   *  composes its consumers into this one closure (unread-clearing now; the
   *  Phase-6 first-message title fallback slots in beside it). */
  onSend?(machine: string, sessionId: string, text: string): void;
  log?: Logger;
}

export function createOutboxStore(
  deps: OutboxStoreDeps,
  initialItems: Record<string, OutboxItem> = {},
): OutboxStore {
  const storageKey = deps.storageKey ?? OUTBOX_STORAGE_KEY;
  const confirmTimeoutMs = deps.confirmTimeoutMs ?? OUTBOX_CONFIRM_TIMEOUT_MS;
  const maxItems = deps.maxItems ?? MAX_OUTBOX_ITEMS;

  const store = createStore<OutboxStoreState>()((set, get) => {
    const persist = (): void => {
      void deps.kv.set(storageKey, serializeOutbox(get().items)).catch((err) => {
        deps.log?.(`[Outbox] persist failed: ${err}`);
      });
    };

    const put = (item: OutboxItem): void => {
      let items = { ...get().items, [item.id]: item };
      // CDX-013 retention: cap the blob. Only RESOLVED items are eligible for
      // eviction (oldest first); pending/published always survive.
      if (Object.keys(items).length > maxItems) {
        const resolved = Object.values(items)
          .filter((i) => i.state === 'confirmed' || i.state === 'failed')
          .sort((a, b) => a.createdAt - b.createdAt);
        let excess = Object.keys(items).length - maxItems;
        for (const victim of resolved) {
          if (excess <= 0) break;
          if (victim.id === item.id) continue; // never evict what we just wrote
          delete items[victim.id];
          excess--;
        }
        items = { ...items };
      }
      set({ items });
      persist();
    };

    const publishItem = async (item: OutboxItem): Promise<OutboxItem> => {
      put({ ...item, state: 'pending', attempts: item.attempts + 1, error: null, failedAt: null });
      let accepted = false;
      let error: string | null = null;
      try {
        accepted = await deps.publish(item.machine, {
          type: 'input',
          sessionId: item.sessionId,
          text: item.text,
          inputId: item.id,
        });
      } catch (err) {
        error = String(err);
      }
      const current = get().items[item.id];
      // The ack can beat the publish promise (in-memory transports) — a
      // confirmed/failed verdict from the bridge always wins.
      if (!current || current.state === 'confirmed' || current.state === 'failed') {
        return current ?? item;
      }
      const next: OutboxItem = accepted
        ? { ...current, state: 'published', publishedAt: deps.now() }
        : {
            ...current,
            state: 'failed',
            failedAt: deps.now(),
            error: error ?? 'no relay accepted the event',
          };
      put(next);
      return next;
    };

    return {
      items: initialItems,

      send: async (machine, sessionId, text) => {
        deps.onSend?.(machine, sessionId, text);
        const item: OutboxItem = {
          id: deps.newId(),
          machine,
          sessionId,
          text,
          state: 'pending',
          createdAt: deps.now(),
          publishedAt: null,
          confirmedAt: null,
          failedAt: null,
          error: null,
          attempts: 0,
        };
        return publishItem(item);
      },

      confirm: (inputId) => {
        const item = get().items[inputId];
        if (!item || item.state === 'confirmed') return;
        put({ ...item, state: 'confirmed', confirmedAt: deps.now(), error: null });
      },

      fail: (inputId, reason) => {
        const item = get().items[inputId];
        if (!item || item.state === 'confirmed' || item.state === 'failed') return;
        put({ ...item, state: 'failed', failedAt: deps.now(), error: reason });
      },

      retry: async (id) => {
        const item = get().items[id];
        if (!item || item.state !== 'failed') return item;
        return publishItem(item);
      },

      sweep: () => {
        const now = deps.now();
        for (const item of Object.values(get().items)) {
          if (item.state !== 'pending' && item.state !== 'published') continue;
          const startedAt = item.publishedAt ?? item.createdAt;
          if (now - startedAt < confirmTimeoutMs) continue;
          put({
            ...item,
            state: 'failed',
            failedAt: now,
            error: item.state === 'published' ? 'no ack from bridge' : 'publish timed out',
          });
        }
      },

      item: (id) => get().items[id],
      itemsFor: (machine, sessionId) =>
        Object.values(get().items)
          .filter((i) => i.machine === machine && i.sessionId === sessionId)
          .sort((a, b) => a.createdAt - b.createdAt),
      unresolved: () =>
        Object.values(get().items).filter(
          (i) => i.state === 'pending' || i.state === 'published',
        ),
    };
  });

  return store;
}

export async function loadPersistedOutbox(
  kv: KV,
  storageKey: string = OUTBOX_STORAGE_KEY,
): Promise<Record<string, OutboxItem>> {
  return hydrateOutbox(await kv.get(storageKey));
}
