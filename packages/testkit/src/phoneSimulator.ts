/**
 * PhoneSimulator — a scriptable, protocol-level stand-in for the mobile app.
 *
 * Given a phone keypair, a bridge pubkey and an InMemoryRelay it behaves the
 * way the plan says the phone must (this file IS the executable client-side
 * contract):
 *
 * - Subscribes per traffic class: 30515 with NO since (replaceable — always
 *   fetch current), 4516 with `since = lastStoredSeen − 60s`, 24515 with NO
 *   since (ephemeral). Dedups by event id (relay replays on reconnect).
 * - NIP-44-decrypts and codec-validates EVERYTHING received; invalid payloads
 *   are recorded in `receivedInvalid` and dropped — never thrown, never
 *   applied.
 * - Maintains the machine/session view with merge semantics: absence NEVER
 *   deletes (marks `stale`); removal only via explicit `removedSessions`
 *   tombstones; `machineOffline` marks presence offline but keeps sessions.
 * - Keeps a local transcript store per session keyed by seq (insert-or-ignore;
 *   a seq arriving twice with DIFFERENT content is recorded in `seqConflicts`
 *   — that would mean the bridge renumbered, which the contract forbids).
 * - Implements the sync client side: applies sync-chunk entries, acks each
 *   chunk, and on sync-end re-requests whatever is still missing (bounded by
 *   `maxResyncAttempts`).
 * - Sends every phone→bridge command as a REAL NIP-44-encrypted kind-4515
 *   event (stamped with the sender's protocol version), so the bridge's real
 *   ingest path is exercised.
 *
 * Deterministic + awaitable: no internal real-time behavior beyond promise
 * scheduling; `await sim.until(cond)` polls a predicate with a timeout instead
 * of sleeping.
 */
import { finalizeEvent } from 'nostr-tools/pure';
import {
  COMMAND_KIND,
  COMMAND_EXPIRY_SECONDS,
  LIVE_KIND,
  RESPONSE_KIND,
  SESSION_LIST_KIND,
  PROTOCOL_VERSION,
  decodeBridgeToPhone,
  encodePhoneToBridge,
  missingRanges,
  normalizeRanges,
  type BridgeToPhoneMessage,
  type CreateSessionMessage,
  type EffortLevel,
  type OutputEntry,
  type PermissionMode,
  type PhoneToBridgeMessage,
  type RemoteSessionInfo,
  type SeqRange,
  type SessionListMessage,
  type SetCredentialsMessage,
  type SetProviderProfileMessage,
  type SyncEndMessage,
} from '@codedeck/protocol';
import { encryptTo, decryptFrom, keypairFromSecret, type Keypair } from '@codedeck/core';
import type { InMemoryRelay, RelayEvent, Subscription } from './inMemoryRelay';

export type Presence = 'live' | 'stale' | 'offline';

/** The simulator's view of one remote session. */
export interface SessionView {
  info: RemoteSessionInfo;
  presence: Presence;
}

export interface InvalidRecord {
  eventId: string;
  kind: number;
  stage: 'decrypt' | 'decode';
  error: string;
}

/** A seq that arrived twice with different content — bridge-side renumbering. */
export interface SeqConflict {
  sessionId: string;
  seq: number;
}

export interface SyncProgress {
  syncId: string;
  sessionId: string;
  /** The bridge's completeness target announced in sync-begin. */
  seqHigh: number;
  promisedRanges: SeqRange[];
  chunksReceived: number;
  end?: SyncEndMessage;
}

/** A permission card the bridge surfaced as a transcript system entry. */
export interface PermissionCardView {
  seq: number;
  requestId: string;
  toolName: string;
  content: string;
}

export interface PhoneSimulatorOptions {
  /** Phone secret key. */
  secretKey: Uint8Array;
  /** Bridge identity (hex pubkey) this phone is paired with. */
  bridgePubkey: string;
  relay: InMemoryRelay;
  /** Clock in ms — injectable for determinism. */
  now?: () => number;
  /** Re-request still-missing ranges on sync-end (the plan's client behavior).
   *  Default true. */
  autoResync?: boolean;
  /** Cap on consecutive automatic re-requests per session. Default 3. */
  maxResyncAttempts?: number;
  log?: (msg: string) => void;
}

export class PhoneSimulator {
  readonly keypair: Keypair;
  readonly bridgePubkey: string;

  /** Every valid decoded message, in arrival order. */
  readonly received: BridgeToPhoneMessage[] = [];
  /** Every event that failed decrypt or codec validation (the contract: record + drop). */
  readonly receivedInvalid: InvalidRecord[] = [];
  /** Seqs that arrived twice with different content (forbidden renumbering). */
  readonly seqConflicts: SeqConflict[] = [];
  /** Chunks deliberately dropped via `dropNextSyncChunks` (simulated wire loss). */
  readonly droppedChunks: Array<{ syncId: string; range: SeqRange }> = [];
  /** All syncs observed, keyed by syncId. */
  readonly syncs = new Map<string, SyncProgress>();

  /** Set to N to silently drop the next N sync-chunks (no apply, no ack). */
  dropNextSyncChunks = 0;
  /** Targeted wire loss: drop every sync-chunk this predicate matches (checked
   *  after the numeric counter). Clear by setting back to null. */
  dropChunkIf: ((chunk: { syncId: string; range: SeqRange }) => boolean) | null = null;

  /** How many session-list heartbeats have been applied. */
  sessionListCount = 0;
  machineName: string | null = null;
  machineOffline = false;
  capabilities: string[] = [];
  folders: string[] = [];
  /** CDX-031: absolute workspace roots from the heartbeat, `--workspace` order. */
  roots: string[] = [];
  /** The raw last-applied session list message. */
  lastSessionList: SessionListMessage | null = null;

  private readonly relay: InMemoryRelay;
  private readonly now: () => number;
  private readonly autoResync: boolean;
  private readonly maxResyncAttempts: number;
  private readonly logFn?: (msg: string) => void;

  private subs: Subscription[] = [];
  private _connected = false;
  private readonly seenEventIds = new Set<string>();
  /** created_at high-water mark over STORED kinds — drives the 4516 since filter. */
  private lastStoredSeen = 0;

  private readonly sessions = new Map<string, SessionView>();
  private readonly transcripts = new Map<string, Map<number, OutputEntry>>();
  private readonly resyncAttempts = new Map<string, number>();

  constructor(options: PhoneSimulatorOptions) {
    this.keypair = keypairFromSecret(options.secretKey);
    this.bridgePubkey = options.bridgePubkey;
    this.relay = options.relay;
    this.now = options.now ?? Date.now;
    this.autoResync = options.autoResync ?? true;
    this.maxResyncAttempts = options.maxResyncAttempts ?? 3;
    this.logFn = options.log;
  }

  get connected(): boolean {
    return this._connected;
  }

  // --- Connection (per-traffic-class subscriptions, per the plan) ---

  connect(): void {
    if (this._connected) return;
    this._connected = true;
    const base = {
      authors: [this.bridgePubkey],
      '#p': [this.keypair.pubkeyHex],
    };
    this.subs = [
      // Session-list heartbeat: replaceable — always fetch current, NO since.
      this.relay.subscribe(
        [{ ...base, kinds: [SESSION_LIST_KIND] }],
        (event) => this.handleEvent(event),
      ),
      // Stored responses: low-frequency, since = lastStoredSeen − 60s.
      this.relay.subscribe(
        [{
          ...base,
          kinds: [RESPONSE_KIND],
          ...(this.lastStoredSeen > 0 ? { since: this.lastStoredSeen - 60 } : {}),
        }],
        (event) => this.handleEvent(event),
      ),
      // Ephemeral live output: NO since (relays never store it anyway).
      this.relay.subscribe(
        [{ ...base, kinds: [LIVE_KIND] }],
        (event) => this.handleEvent(event),
      ),
    ];
  }

  disconnect(): void {
    for (const sub of this.subs) sub.close();
    this.subs = [];
    this._connected = false;
  }

  // --- Ingest (decrypt → validate → apply; never throws) ---

  private handleEvent(event: RelayEvent): void {
    if (this.seenEventIds.has(event.id)) return;
    this.seenEventIds.add(event.id);

    if (event.kind === RESPONSE_KIND || event.kind === SESSION_LIST_KIND) {
      if (event.created_at > this.lastStoredSeen) this.lastStoredSeen = event.created_at;
    }

    let plaintext: string;
    try {
      plaintext = decryptFrom(this.keypair.secretKey, this.bridgePubkey, event.content);
    } catch (err) {
      this.receivedInvalid.push({
        eventId: event.id, kind: event.kind, stage: 'decrypt', error: String(err),
      });
      return;
    }

    const decoded = decodeBridgeToPhone(plaintext);
    if (!decoded.ok) {
      this.receivedInvalid.push({
        eventId: event.id, kind: event.kind, stage: 'decode', error: decoded.error,
      });
      return;
    }

    this.apply(decoded.msg);
  }

  private apply(msg: BridgeToPhoneMessage): void {
    // Scripted wire loss: a dropped chunk never reaches the app layer at all.
    if (msg.type === 'sync-chunk' && this.shouldDropChunk(msg.syncId, msg.range)) {
      this.droppedChunks.push({ syncId: msg.syncId, range: msg.range });
      this.log(`[Sim] dropped sync-chunk [${msg.range[0]},${msg.range[1]}] (${msg.syncId})`);
      return;
    }

    this.received.push(msg);

    switch (msg.type) {
      case 'sessions':
        this.applySessionList(msg);
        return;
      case 'output':
        this.applyEntry(msg.sessionId, msg.seq, msg.entry);
        return;
      case 'sync-begin':
        this.syncs.set(msg.syncId, {
          syncId: msg.syncId,
          sessionId: msg.sessionId,
          seqHigh: msg.seqHigh,
          promisedRanges: msg.ranges,
          chunksReceived: 0,
        });
        return;
      case 'sync-chunk': {
        for (const { seq, entry } of msg.entries) {
          this.applyEntry(msg.sessionId, seq, entry);
        }
        const progress = this.syncs.get(msg.syncId);
        if (progress) progress.chunksReceived++;
        this.send({ type: 'sync-ack', syncId: msg.syncId, range: msg.range });
        return;
      }
      case 'sync-end': {
        const progress = this.syncs.get(msg.syncId);
        if (progress) progress.end = msg;
        this.maybeResync(msg.sessionId, progress?.seqHigh ?? 0);
        return;
      }
      default:
        return; // recorded in `received` — enough for assertions
    }
  }

  private shouldDropChunk(syncId: string, range: SeqRange): boolean {
    if (this.dropNextSyncChunks > 0) {
      this.dropNextSyncChunks--;
      return true;
    }
    return this.dropChunkIf?.({ syncId, range }) ?? false;
  }

  /**
   * Session-list merge, per the plan's contract:
   * - listed sessions are upserted (presence live, or offline on machineOffline)
   * - ABSENCE NEVER DELETES — a previously-known session missing from the
   *   incoming list is kept and marked `stale`
   * - removal happens ONLY via explicit `removedSessions` tombstones
   */
  private applySessionList(msg: SessionListMessage): void {
    const presence: Presence = msg.machineOffline ? 'offline' : 'live';
    const incoming = new Set<string>();
    for (const info of msg.sessions) {
      incoming.add(info.id);
      this.sessions.set(info.id, { info, presence });
    }
    for (const [id, view] of this.sessions) {
      if (!incoming.has(id)) {
        view.presence = msg.machineOffline ? 'offline' : 'stale';
      }
    }
    for (const id of msg.removedSessions ?? []) {
      this.sessions.delete(id);
    }
    this.machineName = msg.machine;
    this.machineOffline = !!msg.machineOffline;
    this.capabilities = [...(msg.capabilities ?? [])];
    this.folders = [...(msg.folders ?? [])];
    this.roots = [...(msg.roots ?? [])];
    this.lastSessionList = msg;
    this.sessionListCount++;
  }

  /** Insert-or-ignore by seq; content mismatch on an existing seq = renumbering. */
  private applyEntry(sessionId: string, seq: number, entry: OutputEntry): void {
    let transcript = this.transcripts.get(sessionId);
    if (!transcript) {
      transcript = new Map();
      this.transcripts.set(sessionId, transcript);
    }
    const existing = transcript.get(seq);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(entry)) {
        this.seqConflicts.push({ sessionId, seq });
      }
      return;
    }
    transcript.set(seq, entry);
  }

  /** On sync-end: re-request whatever is still missing (bounded). */
  private maybeResync(sessionId: string, syncSeqHigh: number): void {
    const target = Math.max(syncSeqHigh, this.sessions.get(sessionId)?.info.seqHigh ?? 0);
    if (target === 0) return;
    const missing = missingRanges(this.haveRanges(sessionId), 1, target);
    if (missing.length === 0) {
      this.resyncAttempts.delete(sessionId);
      return;
    }
    if (!this.autoResync) return;
    const attempts = this.resyncAttempts.get(sessionId) ?? 0;
    if (attempts >= this.maxResyncAttempts) {
      this.log(`[Sim] resync cap reached for ${sessionId} — still missing ${JSON.stringify(missing)}`);
      return;
    }
    this.resyncAttempts.set(sessionId, attempts + 1);
    this.log(`[Sim] re-requesting missing ranges ${JSON.stringify(missing)} for ${sessionId}`);
    this.syncNow(sessionId);
  }

  // --- Sending commands (real encrypted kind-4515 events) ---

  /** Encode, encrypt, sign, and publish one phone→bridge command. */
  send(msg: PhoneToBridgeMessage): RelayEvent {
    const stamped = { v: PROTOCOL_VERSION, ...msg } as PhoneToBridgeMessage;
    const createdAt = Math.floor(this.now() / 1000);
    const event = finalizeEvent(
      {
        kind: COMMAND_KIND,
        created_at: createdAt,
        tags: [
          ['p', this.bridgePubkey],
          ['expiration', String(createdAt + COMMAND_EXPIRY_SECONDS)],
        ],
        content: encryptTo(
          this.keypair.secretKey,
          this.bridgePubkey,
          encodePhoneToBridge(stamped),
        ),
      },
      this.keypair.secretKey,
    );
    this.relay.publish(event);
    return event;
  }

  /**
   * Send a pair-request — the phone side of the pairing-window flow. `token`
   * comes from the pairing URL the bridge presented (QR scan / pasted link).
   * The bridge answers with a pair-ack (recorded in `received`).
   */
  pair(token: string, label = 'Sim Phone'): void {
    this.send({
      type: 'pair-request',
      npub: this.keypair.npub,
      pubkeyHex: this.keypair.pubkeyHex,
      label,
      token,
    });
  }

  createSession(opts: Omit<CreateSessionMessage, 'type' | 'v' | 'caps'> = {}): void {
    this.send({ type: 'create-session', ...opts });
  }

  input(sessionId: string, text: string, inputId?: string): void {
    this.send({ type: 'input', sessionId, text, ...(inputId ? { inputId } : {}) });
  }

  questionInput(sessionId: string, text: string, optionCount = 0): void {
    this.send({ type: 'question-input', sessionId, text, optionCount });
  }

  permissionResponse(
    sessionId: string,
    requestId: string,
    allow: boolean,
    modifier?: 'always' | 'never',
  ): void {
    this.send({
      type: 'permission-res', sessionId, requestId, allow,
      ...(modifier ? { modifier } : {}),
    });
  }

  keypress(sessionId: string, key: string, context?: 'plan-approval' | 'question'): void {
    this.send({ type: 'keypress', sessionId, key, ...(context ? { context } : {}) });
  }

  /** Approve the pending plan: '1' = acceptEdits, '2' = manual, '3' = revise. */
  approvePlan(sessionId: string, key: '1' | '2' | '3' = '1'): void {
    this.keypress(sessionId, key, 'plan-approval');
  }

  setMode(sessionId: string, mode: PermissionMode): void {
    this.send({ type: 'mode', sessionId, mode });
  }

  setEffort(sessionId: string, level: EffortLevel): void {
    this.send({ type: 'effort', sessionId, level });
  }

  setModel(sessionId: string, model: string): void {
    this.send({ type: 'model', sessionId, model });
  }

  interrupt(sessionId: string): void {
    this.send({ type: 'interrupt', sessionId });
  }

  closeSession(sessionId: string): void {
    this.send({ type: 'close-session', sessionId });
  }

  /** Pull-to-refresh equivalent: ask for a fresh session-list heartbeat. */
  refreshSessions(): void {
    this.send({ type: 'refresh-sessions' });
  }

  createFolder(path: string, requestId: string, root?: string): void {
    this.send({ type: 'create-folder', path, requestId, ...(root ? { root } : {}) });
  }

  requestModels(): void {
    this.send({ type: 'models-request' });
  }

  /** Store credentials on the bridge (tri-state per field: undefined = keep,
   *  null = delete, string = set). Answered with a credentials-ack. */
  setCredentials(opts: Omit<SetCredentialsMessage, 'type' | 'v' | 'caps'>): void {
    this.send({ type: 'set-credentials', ...opts });
  }

  /** CDX-062: upsert (or delete, with `profile: null`) one custom provider
   *  profile on the bridge. authToken tri-state: undefined = keep, null =
   *  delete, string = set. Answered with a provider-profile-ack; the bridge
   *  then broadcasts a fresh redacted provider-profiles list. */
  setProviderProfile(
    profileId: string,
    profile: SetProviderProfileMessage['profile'],
  ): void {
    this.send({ type: 'set-provider-profile', profileId, profile });
  }

  /** CDX-062: ask the bridge for its redacted stored-profile list. */
  requestProviderProfiles(): void {
    this.send({ type: 'provider-profiles-request' });
  }

  requestUsage(sessionId: string): void {
    this.send({ type: 'usage-request', sessionId });
  }

  requestGsd(sessionId: string): void {
    this.send({ type: 'gsd-request', sessionId });
  }

  /** Send a sync-request carrying this phone's actual haveRanges. */
  syncNow(sessionId: string): void {
    this.send({ type: 'sync-request', sessionId, haveRanges: this.haveRanges(sessionId) });
  }

  // --- Assertion helpers ---

  /** All valid received messages of one type, in arrival order. */
  receivedOfType<T extends BridgeToPhoneMessage['type']>(
    type: T,
  ): Array<Extract<BridgeToPhoneMessage, { type: T }>> {
    return this.received.filter(
      (m): m is Extract<BridgeToPhoneMessage, { type: T }> => m.type === type,
    );
  }

  sessionList(): SessionView[] {
    return [...this.sessions.values()];
  }

  session(sessionId: string): SessionView | undefined {
    return this.sessions.get(sessionId);
  }

  /** Sorted seqs held locally for a session. */
  transcriptSeqs(sessionId: string): number[] {
    return [...(this.transcripts.get(sessionId)?.keys() ?? [])].sort((a, b) => a - b);
  }

  /** Sorted {seq, entry} pairs held locally for a session. */
  transcriptEntries(sessionId: string): Array<{ seq: number; entry: OutputEntry }> {
    const transcript = this.transcripts.get(sessionId);
    if (!transcript) return [];
    return [...transcript.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([seq, entry]) => ({ seq, entry }));
  }

  /** Canonical covered ranges for a session (what a sync-request would carry). */
  haveRanges(sessionId: string): SeqRange[] {
    return normalizeRanges(this.transcriptSeqs(sessionId).map((seq): SeqRange => [seq, seq]));
  }

  /** True when the local transcript covers 1..max with no gaps
   *  (and max === expectedHigh when given). */
  hasContiguousTranscript(sessionId: string, expectedHigh?: number): boolean {
    const seqs = this.transcriptSeqs(sessionId);
    if (seqs.length === 0) return expectedHigh === undefined || expectedHigh === 0;
    const high = seqs[seqs.length - 1]!;
    if (expectedHigh !== undefined && high !== expectedHigh) return false;
    return seqs.length === high && seqs[0] === 1;
  }

  /** Permission cards surfaced in a session's transcript (system entries with
   *  `special: 'permission_request'`), oldest first. */
  permissionCards(sessionId: string): PermissionCardView[] {
    return this.transcriptEntries(sessionId)
      .filter(({ entry }) => entry.metadata?.special === 'permission_request')
      .map(({ seq, entry }) => ({
        seq,
        requestId: String(entry.metadata?.tool_use_id ?? ''),
        toolName: String(entry.metadata?.tool_name ?? ''),
        content: entry.content,
      }));
  }

  /**
   * Await a predicate without sleeping arbitrary amounts: polls every 2ms and
   * rejects with `label` after `timeoutMs` (default 2s).
   */
  async until(
    cond: () => boolean,
    opts: { timeoutMs?: number; label?: string } = {},
  ): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 2000;
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`PhoneSimulator.until timed out after ${timeoutMs}ms${opts.label ? `: ${opts.label}` : ''}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  private log(msg: string): void {
    this.logFn?.(msg);
  }
}
