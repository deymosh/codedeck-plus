/**
 * PhoneNostrClient — the phone's socket layer, behind the PhoneTransport port.
 *
 * Per-traffic-class subscriptions exactly per the plan (this is what
 * structurally kills bug A's since-filter starvation):
 * - 30515 session-list heartbeat: NO since (replaceable — always fetch current)
 * - 4516 stored responses: since = lastStoredSeen − 60s (low-frequency only;
 *   live output can never advance this cursor past the heartbeat)
 * - 24515 ephemeral live output: NO since (relays never store it)
 *
 * Generation guard (the epoch pattern from @codedeck/core's BridgePool,
 * CDB-037, re-implemented here — the phone must not import core): every
 * (re)connect bumps `epoch`; callbacks from superseded subscriptions are
 * ignored, so a deliberate teardown (resubscribe after pairing, relay change,
 * nostr-tools pool.destroy firing onclose) never masquerades as a lost
 * connection and never feeds the FSM a fake socket-close.
 */
import type { NostrEvent } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import {
  LIVE_KIND,
  RESPONSE_KIND,
  SESSION_LIST_KIND,
} from '@codedeck/protocol';
import type {
  Logger,
  PhoneTransport,
  PublishConfirmOptions,
  PublishResult,
  TransportSubscription,
} from '../ports';

/** since-filter grace below the stored-seen cursor (overlap beats gaps; the
 *  event-id dedup below absorbs the replays). */
export const STORED_SINCE_GRACE_SECONDS = 60;

const SEEN_IDS_CAP = 2000;

/** The three per-class filters. Pure — unit-tested directly. */
export function buildPhoneFilters(opts: {
  phonePubkey: string;
  authors: readonly string[];
  /** created_at high-water mark over STORED kinds (seconds); 0 = never seen. */
  lastStoredSeen: number;
}): Filter[] {
  const base = {
    authors: [...opts.authors],
    '#p': [opts.phonePubkey],
  };
  return [
    // Replaceable heartbeat: always fetch current — NEVER a since filter.
    { ...base, kinds: [SESSION_LIST_KIND] },
    // Stored responses: low-frequency, resume from the stored cursor.
    {
      ...base,
      kinds: [RESPONSE_KIND],
      ...(opts.lastStoredSeen > 0
        ? { since: opts.lastStoredSeen - STORED_SINCE_GRACE_SECONDS }
        : {}),
    },
    // Ephemeral live output: nothing stored to resume from.
    { ...base, kinds: [LIVE_KIND] },
  ];
}

export interface NostrClientDeps {
  transport: PhoneTransport;
  /** The phone's pubkey (the `#p` filter). */
  phonePubkey: string;
  /** Bridge pubkeys to subscribe to: paired machines + any pairing candidate. */
  authors(): string[];
  onEvent(event: NostrEvent): void;
  /** All subscriptions of the current epoch reached EOSE. */
  onSocketOpen(): void;
  /** The current epoch's subscription died on its own (never fired for
   *  deliberate teardown — the epoch guard filters those). */
  onSocketClose(reason?: unknown): void;
  /** Persisted created_at high-water mark over stored kinds (seconds). */
  lastStoredSeen(): number;
  noteStoredSeen(ts: number): void;
  log?: Logger;
}

export class PhoneNostrClient {
  private epoch = 0;
  private subs: TransportSubscription[] = [];
  private connectedEpoch: number | null = null;
  private readonly seenIds = new Set<string>();

  constructor(private readonly deps: NostrClientDeps) {}

  get isConnected(): boolean {
    return this.connectedEpoch === this.epoch && this.subs.length > 0;
  }

  /** (Re)subscribe under a fresh epoch. Idempotent; a previous epoch's
   *  teardown is silent by construction. */
  connect(): void {
    this.teardown();
    const epoch = ++this.epoch;

    const authors = this.deps.authors();
    if (authors.length === 0) {
      // Nothing to subscribe to yet (unpaired phone). Report open so the FSM
      // is honest — the pairing flow resubscribes once a candidate exists.
      this.deps.log?.('[NostrClient] no machines to subscribe to — open (vacuous)');
      this.connectedEpoch = epoch;
      this.deps.onSocketOpen();
      return;
    }

    const filters = buildPhoneFilters({
      phonePubkey: this.deps.phonePubkey,
      authors,
      lastStoredSeen: this.deps.lastStoredSeen(),
    });

    let eoseCount = 0;
    this.subs = filters.map((filter) =>
      this.deps.transport.subscribe(filter, {
        onEvent: (event) => {
          if (epoch !== this.epoch) return; // superseded subscription
          this.handleEvent(event);
        },
        onEose: () => {
          if (epoch !== this.epoch) return;
          eoseCount++;
          if (eoseCount === filters.length) {
            this.connectedEpoch = epoch;
            this.deps.onSocketOpen();
          }
        },
        onClose: (reason) => {
          if (epoch !== this.epoch) {
            this.deps.log?.(`[NostrClient] ignoring close of superseded subscription (epoch ${epoch})`);
            return;
          }
          // One class subscription dying means the socket is bad — tear the
          // epoch down and report ONE close to the FSM.
          this.deps.log?.(`[NostrClient] subscription closed: ${JSON.stringify(reason ?? null)}`);
          this.teardown();
          this.deps.onSocketClose(reason);
        },
      }),
    );
  }

  /** Deliberate teardown — never surfaces as socket-close. */
  disconnect(): void {
    this.teardown();
    this.epoch++;
  }

  /** Rebuild subscriptions (a machine was added/removed, relays changed). */
  resubscribe(): void {
    this.connect();
  }

  /** Point the transport at a new relay list and resubscribe. */
  setRelays(urls: readonly string[]): void {
    this.deps.transport.setRelays?.(urls);
    if (this.isConnected) this.resubscribe();
  }

  publish(event: NostrEvent): Promise<boolean> {
    return this.deps.transport.publish(event);
  }

  /**
   * CDX-086: publish and report the verdict. Transports without
   * `publishConfirmed` (the in-memory test ones) fall back to the boolean, where
   * true means accepted — those transports have no relay and no timeout, so
   * there is no "unconfirmed" state for them to be in.
   */
  publishConfirmed(event: NostrEvent, opts?: PublishConfirmOptions): Promise<PublishResult> {
    const transport = this.deps.transport;
    if (transport.publishConfirmed) return transport.publishConfirmed(event, opts);
    return transport
      .publish(event)
      .then((ok): PublishResult => ({ verdict: ok ? 'accepted' : 'rejected' }));
  }

  private teardown(): void {
    this.epoch++; // orphan in-flight callbacks BEFORE closing (CDB-037 order)
    const subs = this.subs;
    this.subs = [];
    this.connectedEpoch = null;
    for (const sub of subs) {
      try {
        sub.close();
      } catch (err) {
        this.deps.log?.(`[NostrClient] subscription close failed: ${err}`);
      }
    }
  }

  private handleEvent(event: NostrEvent): void {
    // Relays replay stored events on reconnect (overlapping since windows).
    if (this.seenIds.has(event.id)) return;
    this.seenIds.add(event.id);
    if (this.seenIds.size > SEEN_IDS_CAP) {
      const first = this.seenIds.values().next().value;
      if (first !== undefined) this.seenIds.delete(first);
    }

    if (event.kind === RESPONSE_KIND || event.kind === SESSION_LIST_KIND) {
      if (event.created_at > this.deps.lastStoredSeen()) {
        this.deps.noteStoredSeen(event.created_at);
      }
    }

    this.deps.onEvent(event);
  }
}
