/**
 * Inbound command ingest: Nostr event → NIP-44 decrypt → codec validation →
 * typed dispatch. Invalid payloads are logged and dropped — this layer NEVER
 * throws into the subscription callback.
 *
 * Ported from codedeck-bridge-vscode/src/nostrRelay.ts:
 * - processedEventIds LRU dedup (cap 1000) — relay reconnections with
 *   overlapping `since` windows replay events.
 * - 300s staleness cutoff (relays that don't enforce `since`).
 * - `since` selection: persisted last-seen − 5s grace, else a 5-minute window.
 * - The authorless pairing-window filter: the only path by which a
 *   not-yet-paired phone can reach the bridge, open only while pairing.
 * Redesigned: JSON.parse+cast replaced by decodePhoneToBridge (zod), and the
 * giant switch now dispatches to an all-optional CommandHandlers interface.
 */
import type { Filter } from 'nostr-tools/filter';
import type { NostrEvent } from 'nostr-tools/core';
import {
  COMMAND_KIND,
  decodePhoneToBridge,
  type PhoneToBridgeMessage,
} from '@codedeck/protocol';
import { decryptFrom } from './crypto';

// --- Filter builders ---

/** Main commands subscription: stored commands from paired phones only. */
export function buildCommandsFilter(opts: {
  bridgePubkey: string;
  phonePubkeys: readonly string[];
  since: number;
}): Filter {
  return {
    kinds: [COMMAND_KIND],
    '#p': [opts.bridgePubkey],
    authors: [...opts.phonePubkeys],
    since: opts.since,
  };
}

/** `since` for a (re)connect: persisted last-seen timestamp with a 5s grace to
 *  bridge crash gaps, falling back to a 5-minute window (ported). */
export function sinceForConnect(
  lastSeenTimestamp: number,
  nowSec: number = Math.floor(Date.now() / 1000),
): number {
  return lastSeenTimestamp > 0 ? lastSeenTimestamp - 5 : nowSec - 300;
}

/**
 * Pairing-window subscription: intentionally NO `authors` filter — that's the
 * whole point. An as-yet-unpaired phone can only reach the bridge while this
 * time-boxed window is open; a one-time token (checked by the pair-request
 * handler) gates acceptance.
 */
export function buildPairingFilter(opts: {
  bridgePubkey: string;
  nowSec?: number;
}): Filter {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  return {
    kinds: [COMMAND_KIND],
    '#p': [opts.bridgePubkey],
    since: now - 5,
  };
}

// --- Typed dispatch ---

type Msg<K extends PhoneToBridgeMessage['type']> = Extract<PhoneToBridgeMessage, { type: K }>;

type Handler<K extends PhoneToBridgeMessage['type']> = (
  msg: Msg<K>,
  phonePubkeyHex: string,
) => void | Promise<void>;

/** One method per phone→bridge message type, all optional. Handlers may be
 *  async; rejections are caught and logged, never propagated. */
export interface CommandHandlers {
  onInput?: Handler<'input'>;
  onQuestionInput?: Handler<'question-input'>;
  onPermissionResponse?: Handler<'permission-res'>;
  onKeypress?: Handler<'keypress'>;
  onModeChange?: Handler<'mode'>;
  onEffortChange?: Handler<'effort'>;
  onModelChange?: Handler<'model'>;
  onSyncRequest?: Handler<'sync-request'>;
  onSyncAck?: Handler<'sync-ack'>;
  onCreateSession?: Handler<'create-session'>;
  onRefreshSessions?: Handler<'refresh-sessions'>;
  onCloseSession?: Handler<'close-session'>;
  onInterrupt?: Handler<'interrupt'>;
  onCreateFolder?: Handler<'create-folder'>;
  onUploadImage?: Handler<'upload-image'>;
  onUsageRequest?: Handler<'usage-request'>;
  onGsdRequest?: Handler<'gsd-request'>;
  onModelsRequest?: Handler<'models-request'>;
  onSetCredentials?: Handler<'set-credentials'>;
  onSetProviderProfile?: Handler<'set-provider-profile'>;
  onProviderProfilesRequest?: Handler<'provider-profiles-request'>;
  onSetDeviceConfig?: Handler<'set-device-config'>;
  onPairRequest?: Handler<'pair-request'>;
}

export interface CommandIngestOptions {
  secretKey: Uint8Array;
  handlers: CommandHandlers;
  /**
   * CDX-050: called for EVERY validly-decoded main-path command with the
   * sender's advertised capability strings (`caps`, `[]` when the command
   * carries none — pre-CDX-050 phones omit the field). Feeds the bridge's
   * phone-capability registry, which gates diff-entry emission.
   */
  onPhoneCaps?: (phonePubkeyHex: string, caps: readonly string[]) => void;
  /** When provided, main-path events whose author fails this check are dropped
   *  (the pairing path never consults it — unpaired phones are its point). */
  isPairedPhone?: (pubkeyHex: string) => boolean;
  log?: (msg: string) => void;
  /** Clock in ms — injectable for tests. */
  now?: () => number;
  /** Persisted cursor from a previous run (feeds sinceForConnect). */
  lastSeenTimestamp?: number;
  /**
   * Persisted dedup ids from a previous run. A restarted bridge resubscribes
   * with `since = lastSeen − 5s`, so already-processed commands inside that
   * grace window are REPLAYED by the relay — without seeding the dedup set they
   * would be re-executed (duplicate create-session, re-sent inputs). Found by
   * the CDX-008 restart contract test.
   */
  processedEventIds?: readonly string[];
}

export class CommandIngest {
  private readonly secretKey: Uint8Array;
  private readonly handlers: CommandHandlers;
  private readonly onPhoneCaps?: (phonePubkeyHex: string, caps: readonly string[]) => void;
  private readonly isPairedPhone?: (pubkeyHex: string) => boolean;
  private readonly logFn?: (msg: string) => void;
  private readonly now: () => number;

  // --- Event deduplication ---
  // Recently processed nostr event IDs, insertion-ordered; oldest evicted at
  // the cap. Prevents replayed events (overlapping `since` windows) from
  // triggering duplicate side effects like spawning multiple sessions.
  private readonly processedEventIds = new Set<string>();
  private static readonly MAX_PROCESSED_EVENT_IDS = 1000;

  /** Safety net: ignore events this much older than now, in case relays don't
   *  enforce `since` (ported). */
  private static readonly MAX_EVENT_AGE_SECONDS = 300;

  // Most recent event timestamp we processed — persisted by the host and used
  // as `since` on reconnect to bridge crash gaps.
  private _lastSeenTimestamp: number;

  constructor(options: CommandIngestOptions) {
    this.secretKey = options.secretKey;
    this.handlers = options.handlers;
    this.onPhoneCaps = options.onPhoneCaps;
    this.isPairedPhone = options.isPairedPhone;
    this.logFn = options.log;
    this.now = options.now ?? Date.now;
    this._lastSeenTimestamp = options.lastSeenTimestamp ?? 0;
    for (const id of (options.processedEventIds ?? []).slice(-CommandIngest.MAX_PROCESSED_EVENT_IDS)) {
      this.processedEventIds.add(id);
    }
  }

  /** Timestamp of the last processed event (for persistence). */
  get lastSeenTimestamp(): number {
    return this._lastSeenTimestamp;
  }

  /** Snapshot of the dedup ids, oldest first (for persistence alongside the cursor). */
  processedIds(): string[] {
    return [...this.processedEventIds];
  }

  /** Handle an event from the main (paired-authors) subscription. Never throws. */
  handleEvent(event: NostrEvent): void {
    const nowSec = Math.floor(this.now() / 1000);
    if (event.created_at < nowSec - CommandIngest.MAX_EVENT_AGE_SECONDS) {
      this.log(`[Ingest] Ignoring stale event (${nowSec - event.created_at}s old)`);
      return;
    }

    // CDX-013: authorization BEFORE dedup bookkeeping — events from unknown
    // pubkeys must not consume LRU slots (a flood could evict legitimate ids
    // and open a replay window).
    if (this.isPairedPhone && !this.isPairedPhone(event.pubkey)) {
      this.log(`[Ingest] Ignoring event from unknown pubkey: ${event.pubkey.slice(0, 8)}...`);
      return;
    }

    if (!this.markProcessed(event.id)) { return; } // duplicate

    let plaintext: string;
    try {
      plaintext = decryptFrom(this.secretKey, event.pubkey, event.content);
    } catch (err) {
      this.log(`[Ingest] Failed to decrypt event ${event.id.slice(0, 8)}...: ${err}`);
      return;
    }

    const decoded = decodePhoneToBridge(plaintext);
    if (!decoded.ok) {
      this.log(`[Ingest] Dropping invalid payload from ${event.pubkey.slice(0, 8)}...: ${decoded.error}`);
      return;
    }

    // Track last-seen event timestamp for the crash-recovery since filter.
    if (event.created_at > this._lastSeenTimestamp) {
      this._lastSeenTimestamp = event.created_at;
    }

    this.log(`[Ingest] Received ${decoded.msg.type} from ${event.pubkey.slice(0, 8)}...`);
    // CDX-050: record the sender's advertised capabilities on every valid
    // command — a phone that omits `caps` is recorded as [] (pre-CDX-050),
    // which keeps diff-entry emission off for mixed fleets.
    try {
      this.onPhoneCaps?.(event.pubkey, decoded.msg.caps ?? []);
    } catch (err) {
      this.log(`[Ingest] onPhoneCaps error: ${err}`);
    }
    this.dispatch(decoded.msg, event.pubkey);
  }

  /**
   * Handle an event from the authorless pairing-window subscription. The open
   * filter attracts junk we can't decrypt — dropped silently. Only
   * `pair-request` is dispatched from this path; token validation is the
   * onPairRequest handler's job.
   */
  handlePairingEvent(event: NostrEvent): void {
    // CDX-013: same staleness cutoff as the main path. The relay-side `since`
    // filter usually enforces this, but a hostile/buggy relay could replay old
    // events — the token check downstream would still refuse them; this keeps
    // them out of the decrypt + dedup machinery entirely.
    const nowSec = Math.floor(this.now() / 1000);
    if (event.created_at < nowSec - CommandIngest.MAX_EVENT_AGE_SECONDS) {
      return;
    }

    let plaintext: string;
    try {
      plaintext = decryptFrom(this.secretKey, event.pubkey, event.content);
    } catch {
      return; // not for us / not decryptable — ignore silently
    }

    // Dedup AFTER decrypt: junk on the authorless window must not consume LRU
    // slots shared with the main command path (CDX-013).
    if (!this.markProcessed(event.id)) { return; } // duplicate

    const decoded = decodePhoneToBridge(plaintext);
    if (!decoded.ok) { return; }
    if (decoded.msg.type !== 'pair-request') { return; }

    this.log(`[Ingest] Valid pair-request from "${decoded.msg.label}" (${event.pubkey.slice(0, 8)}...)`);
    this.invoke('onPairRequest', this.handlers.onPairRequest, decoded.msg, event.pubkey);
  }

  /** Record an event id in the dedup LRU. Returns false when already seen. */
  private markProcessed(id: string): boolean {
    if (this.processedEventIds.has(id)) { return false; }
    this.processedEventIds.add(id);
    if (this.processedEventIds.size > CommandIngest.MAX_PROCESSED_EVENT_IDS) {
      const first = this.processedEventIds.values().next().value;
      if (first !== undefined) { this.processedEventIds.delete(first); }
    }
    return true;
  }

  /** Exhaustive over the union — an unrouted message type is a compile error. */
  private dispatch(msg: PhoneToBridgeMessage, pubkey: string): void {
    switch (msg.type) {
      case 'input': return this.invoke('onInput', this.handlers.onInput, msg, pubkey);
      case 'question-input': return this.invoke('onQuestionInput', this.handlers.onQuestionInput, msg, pubkey);
      case 'permission-res': return this.invoke('onPermissionResponse', this.handlers.onPermissionResponse, msg, pubkey);
      case 'keypress': return this.invoke('onKeypress', this.handlers.onKeypress, msg, pubkey);
      case 'mode': return this.invoke('onModeChange', this.handlers.onModeChange, msg, pubkey);
      case 'effort': return this.invoke('onEffortChange', this.handlers.onEffortChange, msg, pubkey);
      case 'model': return this.invoke('onModelChange', this.handlers.onModelChange, msg, pubkey);
      case 'sync-request': return this.invoke('onSyncRequest', this.handlers.onSyncRequest, msg, pubkey);
      case 'sync-ack': return this.invoke('onSyncAck', this.handlers.onSyncAck, msg, pubkey);
      case 'create-session': return this.invoke('onCreateSession', this.handlers.onCreateSession, msg, pubkey);
      case 'refresh-sessions': return this.invoke('onRefreshSessions', this.handlers.onRefreshSessions, msg, pubkey);
      case 'close-session': return this.invoke('onCloseSession', this.handlers.onCloseSession, msg, pubkey);
      case 'interrupt': return this.invoke('onInterrupt', this.handlers.onInterrupt, msg, pubkey);
      case 'create-folder': return this.invoke('onCreateFolder', this.handlers.onCreateFolder, msg, pubkey);
      case 'upload-image': return this.invoke('onUploadImage', this.handlers.onUploadImage, msg, pubkey);
      case 'usage-request': return this.invoke('onUsageRequest', this.handlers.onUsageRequest, msg, pubkey);
      case 'gsd-request': return this.invoke('onGsdRequest', this.handlers.onGsdRequest, msg, pubkey);
      case 'models-request': return this.invoke('onModelsRequest', this.handlers.onModelsRequest, msg, pubkey);
      case 'set-credentials': return this.invoke('onSetCredentials', this.handlers.onSetCredentials, msg, pubkey);
      case 'set-provider-profile': return this.invoke('onSetProviderProfile', this.handlers.onSetProviderProfile, msg, pubkey);
      case 'provider-profiles-request': return this.invoke('onProviderProfilesRequest', this.handlers.onProviderProfilesRequest, msg, pubkey);
      case 'set-device-config': return this.invoke('onSetDeviceConfig', this.handlers.onSetDeviceConfig, msg, pubkey);
      case 'pair-request': return this.invoke('onPairRequest', this.handlers.onPairRequest, msg, pubkey);
      default: {
        const exhaustive: never = msg;
        this.log(`[Ingest] Ignoring unhandled message type: ${(exhaustive as { type: string }).type}`);
      }
    }
  }

  /** Call a handler, containing both sync throws and async rejections. */
  private invoke<M>(
    name: string,
    handler: ((msg: M, phonePubkeyHex: string) => void | Promise<void>) | undefined,
    msg: M,
    pubkey: string,
  ): void {
    if (!handler) { return; }
    try {
      Promise.resolve(handler(msg, pubkey)).catch((err) => {
        this.log(`[Ingest] ${name} handler error: ${err}`);
      });
    } catch (err) {
      this.log(`[Ingest] ${name} handler error: ${err}`);
    }
  }

  private log(msg: string): void {
    this.logFn?.(msg);
  }
}
