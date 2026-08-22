/**
 * In-memory Nostr relay for contract tests: faithful to the semantics the
 * CodeDeck system relies on — storage classes per kind (regular / replaceable /
 * addressable / ephemeral), NIP-40 expiration, `since`/`kinds`/`authors`/`#p`
 * filters, and live broadcast to open subscriptions. No sockets, no crypto —
 * events are plain objects; NIP-44 is exercised separately.
 */

export interface RelayEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface RelayFilter {
  ids?: string[];
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
  [tag: `#${string}`]: string[] | undefined;
}

export interface Subscription {
  close(): void;
}

type Listener = (event: RelayEvent) => void;

const isEphemeralKind = (k: number) => k >= 20000 && k < 30000;
const isReplaceableKind = (k: number) => (k >= 10000 && k < 20000) || k === 0 || k === 3;
const isAddressableKind = (k: number) => k >= 30000 && k < 40000;

function expiration(event: RelayEvent): number | null {
  const raw = event.tags.find(([n]) => n === 'expiration')?.[1];
  if (raw === undefined) return null;
  const ts = Number(raw);
  return Number.isFinite(ts) && ts > 0 ? Math.floor(ts) : null;
}

function matches(filter: RelayFilter, event: RelayEvent): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#') || !Array.isArray(values)) continue;
    const tagName = key.slice(1);
    const tagValues = event.tags.filter(([n]) => n === tagName).map(([, v]) => v);
    if (!values.some((v) => tagValues.includes(v))) return false;
  }
  return true;
}

export interface InMemoryRelayOptions {
  /** Injectable clock (seconds) so tests control NIP-40 expiry deterministically. */
  now?: () => number;
}

export class InMemoryRelay {
  #stored: RelayEvent[] = [];
  #subs = new Map<number, { filters: RelayFilter[]; listener: Listener }>();
  #nextSubId = 1;
  #now: () => number;
  /** Counters tests can assert on (e.g. "no full refetch happened"). */
  publishCount = 0;

  constructor(options: InMemoryRelayOptions = {}) {
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Publish as a client would. Returns false when the relay refuses the event
   *  (already expired on arrival — mirrors the real relay's NIP-40 handling). */
  publish(event: RelayEvent): boolean {
    this.publishCount++;
    const exp = expiration(event);
    if (exp !== null && exp <= this.#now()) return false;

    if (isEphemeralKind(event.kind)) {
      this.#broadcast(event);
      return true;
    }

    if (isReplaceableKind(event.kind)) {
      this.#replace(event, (e) => e.kind === event.kind && e.pubkey === event.pubkey);
    } else if (isAddressableKind(event.kind)) {
      const d = event.tags.find(([n]) => n === 'd')?.[1] ?? '';
      this.#replace(
        event,
        (e) =>
          e.kind === event.kind &&
          e.pubkey === event.pubkey &&
          (e.tags.find(([n]) => n === 'd')?.[1] ?? '') === d,
      );
    } else {
      this.#stored.push(event);
    }
    this.#broadcast(event);
    return true;
  }

  #replace(event: RelayEvent, sameSlot: (e: RelayEvent) => boolean): void {
    const existing = this.#stored.filter(sameSlot);
    const newest = existing.reduce<RelayEvent | null>(
      (a, b) => (a === null || b.created_at > a.created_at ? b : a),
      null,
    );
    if (newest && newest.created_at > event.created_at) return; // older replaceable is dropped
    this.#stored = this.#stored.filter((e) => !sameSlot(e));
    this.#stored.push(event);
  }

  #live(): RelayEvent[] {
    const now = this.#now();
    return this.#stored.filter((e) => {
      const exp = expiration(e);
      return exp === null || exp > now;
    });
  }

  /** Stored events matching the filters (EOSE snapshot), newest first. */
  query(filters: RelayFilter[]): RelayEvent[] {
    const seen = new Set<string>();
    const out: RelayEvent[] = [];
    for (const filter of filters) {
      const matched = this.#live()
        .filter((e) => matches(filter, e))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, filter.limit ?? Infinity);
      for (const e of matched) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          out.push(e);
        }
      }
    }
    return out;
  }

  /** Subscribe: `onEvent` fires for the EOSE snapshot, then `onEose`, then live
   *  events as they are published (including ephemeral). */
  subscribe(
    filters: RelayFilter[],
    onEvent: Listener,
    onEose?: () => void,
  ): Subscription {
    for (const e of this.query(filters)) onEvent(e);
    onEose?.();
    const id = this.#nextSubId++;
    this.#subs.set(id, { filters, listener: onEvent });
    return { close: () => void this.#subs.delete(id) };
  }

  #broadcast(event: RelayEvent): void {
    for (const { filters, listener } of [...this.#subs.values()]) {
      if (filters.some((f) => matches(f, event))) listener(event);
    }
  }

  /** NIP-40 purge, as the real relay's alarm does. Returns removed count. */
  purgeExpired(): number {
    const before = this.#stored.length;
    this.#stored = this.#live();
    return before - this.#stored.length;
  }

  /** Test hook: everything currently stored (including expired-but-unpurged). */
  dump(): RelayEvent[] {
    return [...this.#stored];
  }
}
