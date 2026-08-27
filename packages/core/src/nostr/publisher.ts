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
import { randomBytes } from 'node:crypto';
import { finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/core';
import {
  SESSION_LIST_KIND,
  RESPONSE_KIND,
  LIVE_KIND,
  RESPONSE_EXPIRY_SECONDS,
  MAX_EVENT_CONTENT_BYTES,
  encodeBridgeToPhone,
  frameEncodedMessage,
  utf8Size,
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
  /** Per-relay publish timeout in ms (default 5s). Tor's extra circuit/relay
   *  round-trip time can exceed the direct-connection default, so callers
   *  routing through a SOCKS proxy should pass a larger budget. */
  publishTimeoutMs?: number;
  /** Fragment-group id generator for oversize messages (see chunking.ts).
   *  Default: 16 random bytes hex. Injectable for deterministic tests. */
  makeChunkId?: () => string;
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

  static readonly DEFAULT_RELAY_PUBLISH_TIMEOUT_MS = 5_000;

  private readonly publishTimeoutMs: number;
  private readonly makeChunkId: () => string;

  constructor(options: PublisherOptions) {
    this.secretKey = options.secretKey;
    this.machineName = options.machineName;
    this.transport = options.transport;
    this.logFn = options.log;
    this.now = options.now ?? Date.now;
    this.publishTimeoutMs = options.publishTimeoutMs ?? Publisher.DEFAULT_RELAY_PUBLISH_TIMEOUT_MS;
    this.makeChunkId = options.makeChunkId ?? (() => randomBytes(16).toString('hex'));
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

    // Fragmentation (chunking.ts): a message whose encoded JSON would blow the
    // relay's 65535-byte content cap once NIP-44-encrypted (a large model reply
    // is one such OutputEntry) is split into N `chunk` envelopes here, BELOW the
    // semantic layer. `frames.length === 1` is the untouched common path — same
    // bytes, same tags. All fragments share `createdAt`, so ordering vs. the
    // next `seq` is unchanged, and every fragment inherits `policy.kind`, so a
    // chunked `sync-chunk` still rides RESPONSE_KIND (stored) for catch-up.
    const frames = frameEncodedMessage(json, this.makeChunkId);
    if (frames.length > 1) {
      this.log(
        `[Publisher] ${msg.type} encodes to ${utf8Size(json)}B — over the single-event cap; ` +
          `publishing as ${frames.length} chunks`,
      );
    }

    let anySuccess = false;
    for (const phone of phones) {
      let phoneOk = true;
      for (let f = 0; f < frames.length; f++) {
        const frame = frames[f]!;
        const tags =
          frames.length === 1
            ? this.buildTags(msg, phone, policy, createdAt)
            : this.buildChunkTags(phone, policy, createdAt);
        const delivered = await this.publishOne(msg.type, phone, frame, policy.kind, createdAt, tags);
        if (!delivered) { phoneOk = false; }
      }
      if (phoneOk) { anySuccess = true; }
    }

    if (anySuccess) { this.transport.notePublishSuccess?.(); }
    return anySuccess;
  }

  /**
   * Encrypt one already-encoded payload (a whole small message, or one `chunk`
   * fragment of a large one) to `phone`, sign the event, publish it, and report
   * whether at least one relay accepted it. "replaced:" / "newer event"
   * rejections count as acceptance (the relay already has it). Never throws.
   */
  private async publishOne(
    msgType: string,
    phone: string,
    payload: string,
    kind: number,
    createdAt: number,
    tags: string[][],
  ): Promise<boolean> {
    try {
      const ciphertext = encryptTo(this.secretKey, phone, payload);
      if (utf8Size(ciphertext) > MAX_EVENT_CONTENT_BYTES) {
        // Framing guarantees this cannot happen; if it ever does, fail loud
        // here rather than let the relay reject an opaque oversize event.
        this.log(
          `[Publisher] BUG: ${msgType} fragment for ${phone.slice(0, 8)}… encrypted to ` +
            `${utf8Size(ciphertext)}B > ${MAX_EVENT_CONTENT_BYTES} — dropping`,
        );
        return false;
      }
      const event = finalizeEvent({ kind, created_at: createdAt, tags, content: ciphertext }, this.secretKey);

      const outcomes = await this.settleWithTimeout(this.transport.publish(event));
      let accepted = false;
      for (let i = 0; i < outcomes.length; i++) {
        const outcome = outcomes[i];
        const relay = this.transport.relays[i] ?? `relay#${i}`;
        if (!outcome) { continue; }
        if (outcome.status === 'fulfilled') {
          accepted = true;
        } else {
          const reason = outcome.reason;
          const errMsg = reason instanceof Error ? reason.message : String(reason);
          if (errMsg.includes('replaced') || errMsg.includes('newer event')) {
            this.log(`[Publisher] Relay ${relay}: publish OK (relay already has event: ${errMsg})`);
            accepted = true;
          } else {
            this.log(`[Publisher] Relay ${relay}: publish FAILED: ${errMsg}`);
          }
        }
      }
      return accepted;
    } catch (err) {
      this.log(`[Publisher] Failed to publish ${msgType} to ${phone.slice(0, 8)}…: ${err}`);
      return false;
    }
  }

  /** Tags for a `chunk` fragment event: addressing + (for stored kinds) the
   *  NIP-40 expiry. Deliberately no `s`/`seq` — a fragment has no seq of its
   *  own; the reassembled message carries all semantics. */
  private buildChunkTags(
    phonePubkeyHex: string,
    policy: PublishPolicy,
    createdAt: number,
  ): string[][] {
    const tags: string[][] = [['p', phonePubkeyHex]];
    if (policy.expirySeconds !== undefined) {
      tags.push(['expiration', String(createdAt + policy.expirySeconds)]);
    }
    return tags;
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

  /** Settle all per-relay publishes, treating anything past the timeout as rejected. */
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
      }, this.publishTimeoutMs);
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
