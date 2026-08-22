/**
 * Outbound publishing: BridgeToPhoneMessage → per-phone NIP-44-encrypted Nostr
 * events, routed to the right storage class (v10 kind split).
 *
 * Ported from codedeck-bridge-vscode/src/nostrRelay.ts:
 * - getNextTimestamp(): monotonic created_at so replaceable events never regress.
 * - "replaced:" / "newer event" relay rejections treated as publish success.
 * - 5s per-relay publish timeout.
 * Redesigned: one policy function (kindForMessage) instead of per-callsite
 * kind/expiry choices, and egress validation via encodeBridgeToPhone.
 */
import { finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/core';
import {
  SESSION_LIST_KIND,
  RESPONSE_KIND,
  LIVE_KIND,
  RESPONSE_EXPIRY_SECONDS,
  encodeBridgeToPhone,
  type BridgeToPhoneMessage,
} from '@codedeck/protocol';
import { encryptTo } from './crypto';

/** Where a message rides: which kind, and whether it self-expires (NIP-40). */
export interface PublishPolicy {
  kind: number;
  expirySeconds?: number;
}

/**
 * Storage-class policy (see protocol kinds.ts):
 * - `sessions` → SESSION_LIST_KIND: NIP-33 replaceable heartbeat (d = machine
 *   name), relay keeps exactly one, no expiry.
 * - `output` / `usage` / `gsd-state` → LIVE_KIND: ephemeral, relays broadcast
 *   but never store; loss is recoverable (sync / re-request).
 * - Everything else → RESPONSE_KIND, stored with a 1h NIP-40 expiry so a
 *   briefly-offline phone still receives it.
 *
 * The switch is exhaustive over the union — adding a message type without
 * routing it is a compile error (see the `never` default).
 */
export function kindForMessage(msg: BridgeToPhoneMessage): PublishPolicy {
  switch (msg.type) {
    case 'sessions':
      return { kind: SESSION_LIST_KIND };
    case 'output':
    case 'usage':
    case 'gsd-state':
      return { kind: LIVE_KIND };
    case 'input-ack':
    case 'sync-begin':
    case 'sync-chunk':
    case 'sync-end':
    case 'session-pending':
    case 'session-ready':
    case 'session-failed':
    case 'input-failed':
    case 'close-session-ack':
    case 'session-replaced':
    case 'mode-confirmed':
    case 'effort-confirmed':
    case 'model-confirmed':
    case 'folder-ack':
    case 'models':
    case 'credentials-ack':
    case 'device-config-ack':
    case 'pair-ack':
    case 'provider-profiles':
    case 'provider-profile-ack':
      return { kind: RESPONSE_KIND, expirySeconds: RESPONSE_EXPIRY_SECONDS };
    default: {
      const exhaustive: never = msg;
      throw new Error(`kindForMessage: unrouted message type ${(exhaustive as { type: string }).type}`);
    }
  }
}

/** The slice of BridgePool the publisher needs — injectable for tests. */
export interface PublishTransport {
  /** One promise per relay, in `relays` order. */
  publish(event: NostrEvent): Promise<string>[];
  readonly relays: readonly string[];
  /** Called when at least one relay accepted a publish (resets reconnect backoff). */
  notePublishSuccess?(): void;
}

export interface PublisherOptions {
  secretKey: Uint8Array;
  /** NIP-33 d-tag of the session list. */
  machineName: string;
  transport: PublishTransport;
  log?: (msg: string) => void;
  /** Clock in ms — injectable for tests. */
  now?: () => number;
}

export class Publisher {
  private readonly secretKey: Uint8Array;
  private readonly machineName: string;
  private readonly transport: PublishTransport;
  private readonly logFn?: (msg: string) => void;
  private readonly now: () => number;

  // --- Monotonic timestamp ---
  // Ensures each event has a strictly newer created_at than the previous one,
  // preventing "replaced: have newer event" rejections when replaceable events
  // are published in the same second.
  private lastTimestamp = 0;

  private static readonly RELAY_PUBLISH_TIMEOUT_MS = 5_000;

  constructor(options: PublisherOptions) {
    this.secretKey = options.secretKey;
    this.machineName = options.machineName;
    this.transport = options.transport;
    this.logFn = options.log;
    this.now = options.now ?? Date.now;
  }

  /** Get a monotonically increasing created_at (ported getNextTimestamp). */
  getNextTimestamp(): number {
    const now = Math.floor(this.now() / 1000);
    this.lastTimestamp = Math.max(now, this.lastTimestamp + 1);
    return this.lastTimestamp;
  }

  /**
   * Publish one message to each phone in `phones` (hex pubkeys): validated via
   * encodeBridgeToPhone, NIP-44 encrypted per phone, tagged per the old wire
   * shape, kind/expiry from kindForMessage. Returns true if at least one relay
   * accepted at least one event.
   */
  async publishToPhones(
    msg: BridgeToPhoneMessage,
    phones: readonly string[],
  ): Promise<boolean> {
    if (phones.length === 0) { return false; }

    const json = encodeBridgeToPhone(msg); // egress validation — fail loudly at the sender
    const policy = kindForMessage(msg);
    const createdAt = this.getNextTimestamp();
    let anySuccess = false;

    for (const phone of phones) {
      try {
        const ciphertext = encryptTo(this.secretKey, phone, json);
        const event = finalizeEvent({
          kind: policy.kind,
          created_at: createdAt,
          tags: this.buildTags(msg, phone, policy, createdAt),
          content: ciphertext,
        }, this.secretKey);

        const outcomes = await this.settleWithTimeout(this.transport.publish(event));
        for (let i = 0; i < outcomes.length; i++) {
          const outcome = outcomes[i];
          const relay = this.transport.relays[i] ?? `relay#${i}`;
          if (!outcome) { continue; }
          if (outcome.status === 'fulfilled') {
            anySuccess = true;
          } else {
            const reason = outcome.reason;
            const errMsg = reason instanceof Error ? reason.message : String(reason);
            if (errMsg.includes('replaced') || errMsg.includes('newer event')) {
              // Relay already has this event (or a newer version) — treat as success.
              this.log(`[Publisher] Relay ${relay}: publish OK (relay already has event: ${errMsg})`);
              anySuccess = true;
            } else {
              this.log(`[Publisher] Relay ${relay}: publish FAILED: ${errMsg}`);
            }
          }
        }
      } catch (err) {
        this.log(`[Publisher] Failed to publish ${msg.type} to ${phone.slice(0, 8)}…: ${err}`);
      }
    }

    if (anySuccess) { this.transport.notePublishSuccess?.(); }
    return anySuccess;
  }

  /** Tag shapes ported from the old bridge (session list / output / history events). */
  private buildTags(
    msg: BridgeToPhoneMessage,
    phonePubkeyHex: string,
    policy: PublishPolicy,
    createdAt: number,
  ): string[][] {
    const tags: string[][] = [['p', phonePubkeyHex]];
    if (msg.type === 'sessions') {
      tags.push(['d', this.machineName]); // NIP-33: identifier for replaceable event
    } else if (msg.type === 'output') {
      tags.push(['s', msg.sessionId]);      // session tag for filtering
      tags.push(['seq', String(msg.seq)]);  // sequence number for ordering
    } else if (msg.type === 'sync-begin' || msg.type === 'sync-chunk' || msg.type === 'sync-end') {
      tags.push(['s', msg.sessionId]);      // session tag for filtering
    }
    if (policy.expirySeconds !== undefined) {
      tags.push(['expiration', String(createdAt + policy.expirySeconds)]); // NIP-40
    }
    return tags;
  }

  /** Settle all per-relay publishes, treating anything past 5s as rejected. */
  private async settleWithTimeout(
    results: Promise<string>[],
  ): Promise<PromiseSettledResult<string>[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<PromiseSettledResult<string>[]>((resolve) => {
      timer = setTimeout(() => {
        resolve(results.map(() => ({
          status: 'rejected' as const,
          reason: new Error('relay publish timeout'),
        })));
      }, Publisher.RELAY_PUBLISH_TIMEOUT_MS);
    });
    try {
      return await Promise.race([Promise.allSettled(results), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private log(msg: string): void {
    this.logFn?.(msg);
  }
}
