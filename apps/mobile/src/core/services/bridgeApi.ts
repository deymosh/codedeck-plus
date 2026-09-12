/**
 * `BridgeApiLike` — the shared shape `PhoneCore.api` is typed against.
 *
 * The concrete implementation (encode → egress-validate → NIP-44 encrypt →
 * sign → publish a kind-4515 event outbound; decrypt → decode → typed
 * dispatch inbound, oversize-message reassembly, the `createFolder`
 * correlated request/response) is Rust's job now
 * (`client_core::bridge_api`, `client_runtime::Core`'s `Router`) —
 * `createNativeBridgeApi.ts` is the implementation, dispatching the matching
 * `Intent` instead of building the wire command by hand. Only the shared
 * TYPE survives here.
 */
import type { NostrEvent } from 'nostr-tools/core';
import type {
  BridgeToPhoneMessage,
  CreateSessionMessage,
  DeviceConfig,
  EffortLevel,
  FolderAckMessage,
  PermissionMode,
  PhoneToBridgeMessage,
  SetProviderProfileMessage,
  UploadImageMessage,
} from '../nativeCoreTypes';
import type { PublishConfirmOptions, PublishResult } from '../ports';

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

/**
 * `BridgeApi`'s full public surface (see git history for the retired local
 * implementation) — everything a screen, a test, or the F1 in-process-
 * runtime branch could reach through `PhoneCore.api`, except `sendConfirmed`
 * (confirmed by search: it was only ever called from inside `bridgeApi.ts`
 * itself, by `uploadImageBlossom`/`uploadImageChunk`'s own bodies).
 * `createNativeBridgeApi`'s implementations of the never-called-in-native-
 * mode ones (`input`, `ingest`, `dispatchDecoded`, `diagnostics`) are no-ops:
 * Rust's own `Router` owns every inbound message and the outbox lifecycle
 * `input` used to drive under full F2b native mode.
 *
 * `createFolder`/`uploadImageBlossom`/`uploadImageChunk` are the three
 * genuine gaps — see each one's own doc below for why `createNativeBridgeApi`
 * rejects rather than shims them.
 */
export interface BridgeApiLike {
  readonly diagnostics: BridgeApiDiagnostics;
  /** The one generic escape hatch UI still uses directly (permission/plan/
   *  question cards) — every real call site sends `permission-res`,
   *  `keypress`, or `question-input`, each with its own `Intent` already. */
  send(machinePubkey: string, msg: PhoneToBridgeMessage): Promise<boolean>;
  input(machine: string, sessionId: string, text: string, inputId: string): Promise<boolean>;
  /** Decrypt + decode one relay event and dispatch it — the WebView
   *  transport's own inbound path. Not called under full F2b native mode
   *  (Rust decrypts/decodes/dispatches internally); tests still call it
   *  directly to simulate an incoming event. */
  ingest(event: NostrEvent): void;
  /** F1 in-process-runtime inbound routing (`main.tsx`) — a no-op under full
   *  F2b native mode, where Rust's `Router` never hands anything back here. */
  dispatchDecoded(msg: BridgeToPhoneMessage, machinePubkeyHex: string): void;
  createSession(
    machine: string,
    opts?: Omit<CreateSessionMessage, 'type' | 'v' | 'caps'>,
  ): Promise<boolean>;
  refreshSessions(machine: string): Promise<boolean>;
  closeSession(machine: string, sessionId: string): Promise<boolean>;
  interrupt(machine: string, sessionId: string): Promise<boolean>;
  permissionResponse(
    machine: string,
    sessionId: string,
    requestId: string,
    allow: boolean,
    modifier?: 'always' | 'never',
  ): Promise<boolean>;
  keypress(
    machine: string,
    sessionId: string,
    key: string,
    context?: 'plan-approval' | 'question',
  ): Promise<boolean>;
  questionInput(machine: string, sessionId: string, text: string, optionCount: number): Promise<boolean>;
  modeChange(machine: string, sessionId: string, mode: PermissionMode): Promise<boolean>;
  effortChange(machine: string, sessionId: string, level: EffortLevel): Promise<boolean>;
  modelChange(machine: string, sessionId: string, model: string): Promise<boolean>;
  usageRequest(machine: string, sessionId: string): Promise<boolean>;
  gsdRequest(machine: string, sessionId: string): Promise<boolean>;
  modelsRequest(machine: string): Promise<boolean>;
  setCredentials(
    machine: string,
    creds: { anthropicApiKey?: string | null; githubPat?: string | null },
  ): Promise<boolean>;
  setProviderProfile(
    machine: string,
    profileId: string,
    profile: SetProviderProfileMessage['profile'],
  ): Promise<boolean>;
  requestProviderProfiles(machine: string): Promise<boolean>;
  setDeviceConfig(machine: string, config: DeviceConfig): Promise<boolean>;
  /** Correlated request/response (folder-ack) — no Rust Intent or CoreEvent
   *  exists for this yet (a real gap, not an oversight this file papers
   *  over). `createNativeBridgeApi` rejects rather than pretending to
   *  support it. */
  createFolder(
    machine: string,
    path: string,
    root?: string,
    timeoutMs?: number,
  ): Promise<FolderAckMessage>;
  /** Image upload's two-stage shape (blossom-first, chunk-fallback) is
   *  entirely re-implemented as ONE step inside `Intent::SendSessionImage`
   *  Rust-side — these two callbacks cannot be shimmed like-for-like without
   *  either double-uploading or silently no-op'ing the fallback callers
   *  expect to be able to invoke independently. `createNativeBridgeApi`
   *  rejects both; the native call site needs its own
   *  `dispatch({ sendSessionImage })` path, not a drop-in replacement here. */
  uploadImageBlossom(
    machine: string,
    payload: Omit<Extract<UploadImageMessage, { hash: string }>, 'type' | 'v' | 'caps'>,
    opts?: PublishConfirmOptions,
  ): Promise<PublishResult>;
  uploadImageChunk(
    machine: string,
    payload: Omit<Extract<UploadImageMessage, { chunkIndex: number }>, 'type' | 'v' | 'caps'>,
    opts?: PublishConfirmOptions,
  ): Promise<PublishResult>;
}
