/**
 * BridgeApi — the typed request/response layer on @codedeck/protocol.
 *
 * Replaces the old app's 17 positional callbacks with:
 * - outbound: every command is encoded (egress-validated), NIP-44 encrypted,
 *   signed and published as a real kind-4515 event stamped with the sender's
 *   protocol version; `createFolder` shows the correlated request/response
 *   pattern (requestId → folder-ack promise with timeout).
 * - inbound: NIP-44 decrypt → codec.safeParse → typed dispatch to an
 *   all-optional handlers interface. Invalid payloads bump diagnostics
 *   counters, get logged, and are DROPPED — never a throw into the
 *   subscription callback, never state corruption, and decrypt failures are
 *   reported to the connection FSM as diagnostics (never fake disconnects).
 */
import { finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/core';
import {
  ALL_PHONE_CAPABILITIES,
  COMMAND_EXPIRY_SECONDS,
  COMMAND_KIND,
  PROTOCOL_VERSION,
  decodeBridgeToPhone,
  encodePhoneToBridge,
  type BridgeToPhoneMessage,
  type CreateSessionMessage,
  type DeviceConfig,
  type EffortLevel,
  type FolderAckMessage,
  type PermissionMode,
  type PhoneToBridgeMessage,
  type SetProviderProfileMessage,
  type UploadImageMessage,
} from '@codedeck/protocol';
import { decryptFrom, encryptTo, type Keypair } from '../crypto';
import type {
  Logger,
  PublishConfirmOptions,
  PublishResult,
  Timers,
} from '../ports';

export interface InvalidPayloadRecord {
  eventId: string;
  machine: string;
  kind: number;
  stage: 'decrypt' | 'decode';
  error: string;
}

export interface BridgeApiDiagnostics {
  decryptFailures: number;
  decodeFailures: number;
  /** Most recent invalid payloads (capped). */
  invalid: InvalidPayloadRecord[];
}

type Msg<K extends BridgeToPhoneMessage['type']> = Extract<BridgeToPhoneMessage, { type: K }>;
type Handler<K extends BridgeToPhoneMessage['type']> = (
  msg: Msg<K>,
  machinePubkeyHex: string,
) => void | Promise<void>;

/** One optional method per bridge→phone message type. */
export interface PhoneMessageHandlers {
  onSessions?: Handler<'sessions'>;
  onOutput?: Handler<'output'>;
  onInputAck?: Handler<'input-ack'>;
  onSyncBegin?: Handler<'sync-begin'>;
  onSyncChunk?: Handler<'sync-chunk'>;
  onSyncEnd?: Handler<'sync-end'>;
  onSessionPending?: Handler<'session-pending'>;
  onSessionReady?: Handler<'session-ready'>;
  onSessionFailed?: Handler<'session-failed'>;
  onInputFailed?: Handler<'input-failed'>;
  onCloseSessionAck?: Handler<'close-session-ack'>;
  onSessionReplaced?: Handler<'session-replaced'>;
  onModeConfirmed?: Handler<'mode-confirmed'>;
  onEffortConfirmed?: Handler<'effort-confirmed'>;
  onModelConfirmed?: Handler<'model-confirmed'>;
  onFolderAck?: Handler<'folder-ack'>;
  onUsage?: Handler<'usage'>;
  onGsdState?: Handler<'gsd-state'>;
  onModels?: Handler<'models'>;
  onCredentialsAck?: Handler<'credentials-ack'>;
  onDeviceConfigAck?: Handler<'device-config-ack'>;
  onPairAck?: Handler<'pair-ack'>;
  onProviderProfiles?: Handler<'provider-profiles'>;
  onProviderProfileAck?: Handler<'provider-profile-ack'>;
}

export interface BridgeApiDeps {
  identity(): Keypair;
  /** Paired machines + the active pairing candidate — anything else is dropped. */
  isKnownMachine(pubkeyHex: string): boolean;
  publish(event: NostrEvent): Promise<boolean>;
  /** Verdict-capable publish (CDX-086). OPTIONAL so hand-built test deps keep
   *  working; `sendConfirmed` maps the boolean when it is absent. */
  publishConfirmed?(event: NostrEvent, opts?: PublishConfirmOptions): Promise<PublishResult>;
  handlers: PhoneMessageHandlers;
  /** A payload from a known machine failed NIP-44 decrypt (→ FSM diagnostics /
   *  needsPairingCheck — NEVER a disconnect). */
  onDecryptFailure?(machinePubkeyHex: string): void;
  now(): number;
  timers: Timers;
  log?: Logger;
}

const INVALID_RECORDS_CAP = 100;
const FOLDER_ACK_TIMEOUT_MS = 15_000;

export class BridgeApi {
  readonly diagnostics: BridgeApiDiagnostics = {
    decryptFailures: 0,
    decodeFailures: 0,
    invalid: [],
  };

  private readonly pendingFolderAcks = new Map<
    string,
    { resolve(msg: FolderAckMessage): void; timer: unknown }
  >();
  private folderRequestCounter = 0;

  constructor(private readonly deps: BridgeApiDeps) {}

  // --- Outbound ---

  /**
   * Build ONE signed phone→bridge command event.
   *
   * Split out of `send` for CDX-086. It matters that a retry reuses the event
   * this returns rather than calling here again: a second call stamps a fresh
   * created_at and a fresh NIP-44 nonce, so the event id changes, the bridge's
   * id-based dedup cannot help, and an image gets injected twice.
   */
  private buildCommand(machinePubkey: string, msg: PhoneToBridgeMessage): NostrEvent {
    const me = this.deps.identity();
    // CDX-050: advertise renderable-feature caps on every command so the
    // bridge can gate entry kinds old phones would reject (diff cards).
    const stamped = {
      v: PROTOCOL_VERSION,
      caps: [...ALL_PHONE_CAPABILITIES],
      ...msg,
    } as PhoneToBridgeMessage;
    const createdAt = Math.floor(this.deps.now() / 1000);
    const event = finalizeEvent(
      {
        kind: COMMAND_KIND,
        created_at: createdAt,
        tags: [
          ['p', machinePubkey],
          ['expiration', String(createdAt + COMMAND_EXPIRY_SECONDS)],
        ],
        content: encryptTo(me.secretKey, machinePubkey, encodePhoneToBridge(stamped)),
      },
      me.secretKey,
    );
    return event;
  }

  /** Encode, encrypt, sign and publish one phone→bridge command. Resolves true
   *  when at least one relay accepted the event. */
  async send(machinePubkey: string, msg: PhoneToBridgeMessage): Promise<boolean> {
    try {
      return await this.deps.publish(this.buildCommand(machinePubkey, msg));
    } catch (err) {
      this.deps.log?.(`[BridgeApi] publish of ${msg.type} failed: ${err}`);
      return false;
    }
  }

  /**
   * As `send`, but reporting the publish VERDICT (CDX-086). Only the image path
   * needs this: it is the one caller that must not mistake a late relay OK for a
   * failure, because its remedy is re-uploading megabytes.
   */
  async sendConfirmed(
    machinePubkey: string,
    msg: PhoneToBridgeMessage,
    opts?: PublishConfirmOptions,
  ): Promise<PublishResult> {
    let event: NostrEvent;
    try {
      event = this.buildCommand(machinePubkey, msg);
    } catch (err) {
      this.deps.log?.(`[BridgeApi] could not build ${msg.type}: ${err}`);
      return { verdict: 'rejected', detail: String(err) };
    }
    try {
      if (this.deps.publishConfirmed) return await this.deps.publishConfirmed(event, opts);
      // Deps without the verdict-capable publish (hand-built test deps): the
      // boolean is all there is, and true means accepted for those transports.
      const ok = await this.deps.publish(event);
      return { verdict: ok ? 'accepted' : 'rejected' };
    } catch (err) {
      this.deps.log?.(`[BridgeApi] publish of ${msg.type} failed: ${err}`);
      return { verdict: 'rejected', detail: String(err) };
    }
  }

  input(machine: string, sessionId: string, text: string, inputId: string): Promise<boolean> {
    return this.send(machine, { type: 'input', sessionId, text, inputId });
  }

  createSession(
    machine: string,
    opts: Omit<CreateSessionMessage, 'type' | 'v' | 'caps'> = {},
  ): Promise<boolean> {
    return this.send(machine, { type: 'create-session', ...opts });
  }

  refreshSessions(machine: string): Promise<boolean> {
    return this.send(machine, { type: 'refresh-sessions' });
  }

  closeSession(machine: string, sessionId: string): Promise<boolean> {
    return this.send(machine, { type: 'close-session', sessionId });
  }

  interrupt(machine: string, sessionId: string): Promise<boolean> {
    return this.send(machine, { type: 'interrupt', sessionId });
  }

  permissionResponse(
    machine: string,
    sessionId: string,
    requestId: string,
    allow: boolean,
    modifier?: 'always' | 'never',
  ): Promise<boolean> {
    return this.send(machine, {
      type: 'permission-res',
      sessionId,
      requestId,
      allow,
      ...(modifier ? { modifier } : {}),
    });
  }

  /** Raw keypress for TUI-style prompts (plan approval, question selection). */
  keypress(
    machine: string,
    sessionId: string,
    key: string,
    context?: 'plan-approval' | 'question',
  ): Promise<boolean> {
    return this.send(machine, {
      type: 'keypress',
      sessionId,
      key,
      ...(context ? { context } : {}),
    });
  }

  /** Free-text (or multi-select comma-joined) answer to the active AskUserQuestion. */
  questionInput(
    machine: string,
    sessionId: string,
    text: string,
    optionCount: number,
  ): Promise<boolean> {
    return this.send(machine, { type: 'question-input', sessionId, text, optionCount });
  }

  modeChange(machine: string, sessionId: string, mode: PermissionMode): Promise<boolean> {
    return this.send(machine, { type: 'mode', sessionId, mode });
  }

  effortChange(machine: string, sessionId: string, level: EffortLevel): Promise<boolean> {
    return this.send(machine, { type: 'effort', sessionId, level });
  }

  modelChange(machine: string, sessionId: string, model: string): Promise<boolean> {
    return this.send(machine, { type: 'model', sessionId, model });
  }

  /** Image via Blossom (Phase 5, CDX-029): the blob is already uploaded
   *  encrypted; this publishes the hash + key/iv reference for the bridge to
   *  download + decrypt. */
  uploadImageBlossom(
    machine: string,
    payload: Omit<Extract<UploadImageMessage, { hash: string }>, 'type' | 'v' | 'caps'>,
    opts?: PublishConfirmOptions,
  ): Promise<PublishResult> {
    return this.sendConfirmed(machine, { type: 'upload-image', ...payload }, opts);
  }

  /** Legacy relay-chunk image transport — the fallback when Blossom fails. */
  uploadImageChunk(
    machine: string,
    payload: Omit<Extract<UploadImageMessage, { chunkIndex: number }>, 'type' | 'v' | 'caps'>,
    opts?: PublishConfirmOptions,
  ): Promise<PublishResult> {
    return this.sendConfirmed(machine, { type: 'upload-image', ...payload }, opts);
  }

  usageRequest(machine: string, sessionId: string): Promise<boolean> {
    return this.send(machine, { type: 'usage-request', sessionId });
  }

  gsdRequest(machine: string, sessionId: string): Promise<boolean> {
    return this.send(machine, { type: 'gsd-request', sessionId });
  }

  modelsRequest(machine: string): Promise<boolean> {
    return this.send(machine, { type: 'models-request' });
  }

  /** Store credentials on the bridge host (CDX-011): explicit null DELETES a
   *  credential, undefined leaves it alone (ported semantics). The bridge
   *  answers with a credentials-ack (routed into uiStore.credentialsStatus).
   *  Values are secrets — this method must never log them. */
  setCredentials(
    machine: string,
    creds: { anthropicApiKey?: string | null; githubPat?: string | null },
  ): Promise<boolean> {
    return this.send(machine, {
      type: 'set-credentials',
      ...(creds.anthropicApiKey !== undefined ? { anthropicApiKey: creds.anthropicApiKey } : {}),
      ...(creds.githubPat !== undefined ? { githubPat: creds.githubPat } : {}),
    });
  }

  /** Upsert or delete one custom provider profile stored bridge-side (CDX-062;
   *  `profile: null` deletes it). Same secret discipline as setCredentials —
   *  send-and-forget, the token is never logged and never echoed back
   *  (bridge→phone traffic carries `hasToken` only). Callers gate on the
   *  bridge's 'custom-providers' heartbeat capability — an old bridge's zod
   *  would reject the unknown message. Answered with provider-profile-ack,
   *  then a redacted provider-profiles broadcast. */
  setProviderProfile(
    machine: string,
    profileId: string,
    profile: SetProviderProfileMessage['profile'],
  ): Promise<boolean> {
    return this.send(machine, { type: 'set-provider-profile', profileId, profile });
  }

  /** Ask for the bridge's redacted stored-profile list (CDX-062). Cap-gated by
   *  callers like setProviderProfile above. */
  requestProviderProfiles(machine: string): Promise<boolean> {
    return this.send(machine, { type: 'provider-profiles-request' });
  }

  /** Test-device config (Phase 5d): tells the bridge which device the
   *  autonomous test loop targets over the mesh. A 'test-target' phone reports
   *  its REAL mesh identity (meshIp + meshPubkey) so the bridge authorizes the
   *  right key on the nvpn roster and derives the adb serial. */
  setDeviceConfig(machine: string, config: DeviceConfig): Promise<boolean> {
    return this.send(machine, { type: 'set-device-config', config });
  }

  /** Correlated request/response: resolves with the folder-ack (or a synthetic
   *  failed ack on timeout — the caller always gets an answer). */
  createFolder(
    machine: string,
    path: string,
    root?: string,
    timeoutMs: number = FOLDER_ACK_TIMEOUT_MS,
  ): Promise<FolderAckMessage> {
    const requestId = `folder-${++this.folderRequestCounter}-${Math.floor(this.deps.now())}`;
    return new Promise<FolderAckMessage>((resolve) => {
      const timer = this.deps.timers.set(() => {
        this.pendingFolderAcks.delete(requestId);
        resolve({ type: 'folder-ack', requestId, success: false, error: 'timeout' });
      }, timeoutMs);
      this.pendingFolderAcks.set(requestId, { resolve, timer });
      void this.send(machine, {
        type: 'create-folder',
        path,
        requestId,
        ...(root ? { root } : {}),
      });
    });
  }

  // --- Inbound ---

  /** Ingest one relay event. Never throws. */
  ingest(event: NostrEvent): void {
    const machine = event.pubkey;
    if (!this.deps.isKnownMachine(machine)) {
      this.deps.log?.(`[BridgeApi] event from unknown pubkey ${machine.slice(0, 8)}… dropped`);
      return;
    }

    const me = this.deps.identity();
    let plaintext: string;
    try {
      plaintext = decryptFrom(me.secretKey, machine, event.content);
    } catch (err) {
      this.recordInvalid({
        eventId: event.id,
        machine,
        kind: event.kind,
        stage: 'decrypt',
        error: String(err),
      });
      this.diagnostics.decryptFailures++;
      this.deps.onDecryptFailure?.(machine);
      return;
    }

    const decoded = decodeBridgeToPhone(plaintext);
    if (!decoded.ok) {
      this.recordInvalid({
        eventId: event.id,
        machine,
        kind: event.kind,
        stage: 'decode',
        error: decoded.error,
      });
      this.diagnostics.decodeFailures++;
      return;
    }

    this.dispatch(decoded.msg, machine);
  }

  /** Exhaustive over the union — an unrouted message type is a compile error. */
  private dispatch(msg: BridgeToPhoneMessage, machine: string): void {
    const h = this.deps.handlers;
    switch (msg.type) {
      case 'sessions': return this.invoke('onSessions', h.onSessions, msg, machine);
      case 'output': return this.invoke('onOutput', h.onOutput, msg, machine);
      case 'input-ack': return this.invoke('onInputAck', h.onInputAck, msg, machine);
      case 'sync-begin': return this.invoke('onSyncBegin', h.onSyncBegin, msg, machine);
      case 'sync-chunk': return this.invoke('onSyncChunk', h.onSyncChunk, msg, machine);
      case 'sync-end': return this.invoke('onSyncEnd', h.onSyncEnd, msg, machine);
      case 'session-pending': return this.invoke('onSessionPending', h.onSessionPending, msg, machine);
      case 'session-ready': return this.invoke('onSessionReady', h.onSessionReady, msg, machine);
      case 'session-failed': return this.invoke('onSessionFailed', h.onSessionFailed, msg, machine);
      case 'input-failed': return this.invoke('onInputFailed', h.onInputFailed, msg, machine);
      case 'close-session-ack': return this.invoke('onCloseSessionAck', h.onCloseSessionAck, msg, machine);
      case 'session-replaced': return this.invoke('onSessionReplaced', h.onSessionReplaced, msg, machine);
      case 'mode-confirmed': return this.invoke('onModeConfirmed', h.onModeConfirmed, msg, machine);
      case 'effort-confirmed': return this.invoke('onEffortConfirmed', h.onEffortConfirmed, msg, machine);
      case 'model-confirmed': return this.invoke('onModelConfirmed', h.onModelConfirmed, msg, machine);
      case 'folder-ack': {
        const pending = this.pendingFolderAcks.get(msg.requestId);
        if (pending) {
          this.pendingFolderAcks.delete(msg.requestId);
          this.deps.timers.clear(pending.timer);
          pending.resolve(msg);
        }
        return this.invoke('onFolderAck', h.onFolderAck, msg, machine);
      }
      case 'usage': return this.invoke('onUsage', h.onUsage, msg, machine);
      case 'gsd-state': return this.invoke('onGsdState', h.onGsdState, msg, machine);
      case 'models': return this.invoke('onModels', h.onModels, msg, machine);
      case 'credentials-ack': return this.invoke('onCredentialsAck', h.onCredentialsAck, msg, machine);
      case 'device-config-ack': return this.invoke('onDeviceConfigAck', h.onDeviceConfigAck, msg, machine);
      case 'pair-ack': return this.invoke('onPairAck', h.onPairAck, msg, machine);
      case 'provider-profiles': return this.invoke('onProviderProfiles', h.onProviderProfiles, msg, machine);
      case 'provider-profile-ack': return this.invoke('onProviderProfileAck', h.onProviderProfileAck, msg, machine);
      default: {
        const exhaustive: never = msg;
        this.deps.log?.(`[BridgeApi] unhandled message type ${(exhaustive as { type: string }).type}`);
      }
    }
  }

  /** Call a handler, containing both sync throws and async rejections. */
  private invoke<M>(
    name: string,
    handler: ((msg: M, machinePubkeyHex: string) => void | Promise<void>) | undefined,
    msg: M,
    machine: string,
  ): void {
    if (!handler) return;
    try {
      Promise.resolve(handler(msg, machine)).catch((err) => {
        this.deps.log?.(`[BridgeApi] ${name} handler error: ${err}`);
      });
    } catch (err) {
      this.deps.log?.(`[BridgeApi] ${name} handler error: ${err}`);
    }
  }

  private recordInvalid(record: InvalidPayloadRecord): void {
    this.diagnostics.invalid.push(record);
    if (this.diagnostics.invalid.length > INVALID_RECORDS_CAP) {
      this.diagnostics.invalid.shift();
    }
    this.deps.log?.(
      `[BridgeApi] invalid payload (${record.stage}) from ${record.machine.slice(0, 8)}…: ${record.error}`,
    );
  }
}
