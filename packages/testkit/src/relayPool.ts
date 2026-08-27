/**
 * InMemoryRelayPool — a BridgeCorePool backed by the InMemoryRelay, so a REAL
 * BridgeCore talks to a REAL (in-memory) relay in contract tests: its publishes
 * land in relay storage/broadcast, and its command subscription is built from
 * the same `buildFilter()` callback the production BridgePool uses.
 */
import type { NostrEvent } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import type { BridgeCorePool, BridgePoolCallbacks, BridgePoolOptions, PoolFactory } from '@codedeck/core';
import type { InMemoryRelay, RelayFilter, Subscription } from './inMemoryRelay';

export class InMemoryRelayPool implements BridgeCorePool {
  readonly relays = ['wss://in-memory.test'] as const;
  disposed = false;

  private sub: Subscription | null = null;

  constructor(
    private readonly relay: InMemoryRelay,
    private readonly cb: BridgePoolCallbacks,
  ) {}

  connect(): void {
    this.sub?.close();
    this.sub = null;
    const filter = this.cb.buildFilter();
    if (!filter) return; // no paired phones yet — same skip as the real pool
    this.sub = this.relay.subscribe(
      [filter as RelayFilter],
      (event) => this.cb.onEvent(event as NostrEvent),
    );
    this.cb.onStatus?.('connected');
  }

  resubscribe(): void {
    this.connect();
  }

  dispose(): void {
    this.sub?.close();
    this.sub = null;
    this.disposed = true;
  }

  publish(event: NostrEvent): Promise<string>[] {
    const accepted = this.relay.publish(event);
    return [
      accepted
        ? Promise.resolve('ok')
        : Promise.reject(new Error('relay refused event (expired or content too large)')),
    ];
  }

  notePublishSuccess(): void {}

  /** Extra caller-owned subscription (the authorless pairing-window filter). */
  openSubscription(
    filter: Filter,
    params: {
      onevent: (event: NostrEvent) => void;
      oneose?: () => void;
      onclose?: (reasons: unknown) => void;
    },
  ): { close(): void } {
    const sub = this.relay.subscribe(
      [filter as RelayFilter],
      (event) => params.onevent(event as NostrEvent),
      params.oneose,
    );
    return {
      close: () => {
        sub.close();
        params.onclose?.('closed by caller');
      },
    };
  }
}

/** A BridgeCore `poolFactory` bound to one InMemoryRelay. */
export function inMemoryPoolFactory(relay: InMemoryRelay): PoolFactory {
  return (_options: BridgePoolOptions, callbacks: BridgePoolCallbacks) =>
    new InMemoryRelayPool(relay, callbacks);
}
