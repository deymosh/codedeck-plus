/**
 * Thin, hand-written facade over the generated bindings
 * (`nativeCoreTypes.generated.ts`, produced by `apps/mobile/src-tauri/
 * tests/gen_ts_bindings.rs` from client-runtime's `View`/`Intent`/`CoreEvent`
 * Rust types — see that test's own doc comment, and never hand-edit the
 * generated file itself).
 *
 * tauri-specta emits a `X_Serialize`/`X_Deserialize` pair (plus a
 * `X = X_Serialize | X_Deserialize` union under the bare name) for any type
 * whose dependency graph has a field that serializes and deserializes
 * asymmetrically — chiefly anything downstream of a
 * `#[serde(skip_serializing_if = ...)]` field, which several `protocol`
 * leaf types (`OutputEntry`, `ProviderProfileWrite`, …) carry. Every one of
 * these types crosses the wire in exactly ONE direction in this app: Views
 * are Rust-serialized and never deserialized back; `Intent` is constructed
 * here and deserialized Rust-side. Re-exporting the ambiguous two-phase
 * union under the bare name would force every read site to redundantly
 * narrow a case that can't actually occur (`intent.selectSession` would
 * type as "possibly absent" even though, on the `Intent` this app
 * constructs, a `selectSession` intent object always has it).
 *
 * This file changes no shape for the View/Intent/CoreEvent surface above —
 * it only names which half of an already-generated pair is the one this app
 * actually uses, the same way a human author would have picked a single
 * direction by hand before generation existed.
 *
 * The `PhoneToBridge`/`BridgeToPhone` message unions below are a DIFFERENT
 * case: `PhoneToBridge`/`BridgeToPhone` are internally tagged
 * (`#[serde(tag = "type", rename_all = "kebab-case")]` — the real wire JSON
 * is flat, `{"type":"input",...InputMsg fields}`, confirmed against
 * `packages/protocol/fixtures/corpus.json`'s own fixtures), but specta's
 * generated TS for that repr still nests each variant's payload under an
 * extra key matching the variant name (`{ input: { type: "input", ... } }`)
 * — confirmed directly: TypeScript accepts only the nested object literal
 * for `PhoneToBridge_Deserialize`, and rejects the real flat shape outright.
 * `crates/protocol`'s own inner message structs (`InputMsg`, `PairAckMsg`,
 * …) don't have this problem — they're plain structs, not enum variants —
 * so the union below is reconstructed from THOSE (each intersected with its
 * own literal `type` tag) instead of from the generated
 * `PhoneToBridge`/`BridgeToPhone` unions directly.
 */
export * from './nativeCoreTypes.generated';
export type {
  Intent_Deserialize as Intent,
  MachineView_Serialize as MachineView,
  MachinesView_Serialize as MachinesView,
  PendingSessionsView_Serialize as PendingSessionsView,
  TranscriptRowView_Serialize as TranscriptRowView,
  TranscriptRowsView_Serialize as TranscriptRowsView,
  UiView_Serialize as UiView,
  DeviceConfig_Deserialize as DeviceConfig,
} from './nativeCoreTypes.generated';

import type {
  OutputEntry_Serialize,
  RemoteSessionInfo_Serialize,
  UsageData_Serialize,
  UsageWindow,
  ProviderProfileInfo_Serialize,
  ProviderModel_Serialize,
  ProviderModel_Deserialize,
  PermissionMode,
  EffortLevel,
  SessionState,
  // PhoneToBridge variants (constructed here, dispatched to Rust — the
  // `_Deserialize` half, matching what Rust's serde accepts).
  InputMsg_Deserialize,
  QuestionInputMsg_Deserialize,
  PermissionResMsg_Deserialize,
  KeypressMsg_Deserialize,
  ModeChangeMsg_Deserialize,
  EffortChangeMsg_Deserialize,
  ModelChangeMsg_Deserialize,
  SyncRequestMsg_Deserialize,
  SyncAckMsg_Deserialize,
  CreateSessionMsg_Deserialize,
  BareMsg_Deserialize,
  SessionIdMsg_Deserialize,
  CreateFolderMsg_Deserialize,
  UploadImageMsg_Deserialize,
  SetCredentialsMsg_Deserialize,
  SetDeviceConfigMsg_Deserialize,
  PairRequestMsg_Deserialize,
  SetProviderProfileMsg_Deserialize,
  // BridgeToPhone variants (Rust-pushed, read here — the `_Serialize` half
  // where the type is split; a handful are symmetric and stay unsplit).
  SessionListMsg_Serialize,
  OutputMsg_Serialize,
  InputAckMsg,
  SyncBeginMsg,
  SyncChunkMsg_Serialize,
  SyncEndMsg,
  SessionPendingMsg,
  SessionReadyMsg_Serialize,
  SessionFailedMsg,
  InputFailedMsg_Serialize,
  CloseSessionAckMsg,
  SessionReplacedMsg_Serialize,
  ModeConfirmedMsg,
  EffortConfirmedMsg,
  ModelConfirmedMsg,
  FolderAckMsg_Serialize,
  UsageMsg_Serialize,
  GsdStateMsg,
  ModelsMsg_Serialize,
  CredentialsAckMsg_Serialize,
  DeviceConfigAckMsg_Serialize,
  PairAckMsg_Serialize,
  ProviderProfilesMsg_Serialize,
  ProviderProfileAckMsg_Serialize,
} from './nativeCoreTypes.generated';

/** One tagged wire message: the real flat shape (`{type, ...fields}`), not
 *  specta's nested-by-variant-name encoding (see this file's own doc
 *  comment above). */
type Msg<Tag extends string, T> = { type: Tag } & T;

/**
 * `OutputEntry.metadata` is genuinely untyped, bridge-supplied JSON (Rust's
 * own field comment) — `#[specta(type = specta_typescript::Unknown)]`
 * avoids a real stack-overflow bug from inline-expanding the recursive
 * `serde_json::Value` shape, but renders as bare `unknown`, which unlike the
 * old zod schema's `z.record(z.unknown())` doesn't allow the ad-hoc
 * `metadata.someField` reads every transcript row renderer does. Restoring
 * `Record<string, unknown>` here is a pure TS-side view (no Rust change,
 * still just as opaque value-wise) — every renderer already narrows or
 * optionally-chains past any actual missing key.
 */
export type OutputEntry = Omit<OutputEntry_Serialize, 'metadata'> & {
  metadata?: Record<string, unknown>;
};

/**
 * specta models EVERY `Option<T>` field as `T | null`, then additionally
 * optional (`| undefined`) when the field also carries
 * `#[serde(skip_serializing_if = "Option::is_none")]` — even though that
 * attribute means the field is only ever omitted, never actually
 * serialized as `null`. The old zod schemas modelled these fields as
 * `T | undefined` only (`.optional()`, not `.nullable()`), which is what
 * every consumer here is written against. Each override below lists
 * exactly the skip_serializing_if-gated fields of its Rust struct (see
 * `crates/protocol/src/common.rs`) — a field declared `Option<T>` WITHOUT
 * that attribute (`RemoteSessionInfo.title`, `UsageData.subscriptionType`)
 * is genuinely nullable on the wire and is deliberately left alone.
 */
export type RemoteSessionInfo = Omit<
  RemoteSessionInfo_Serialize,
  | 'permissionMode'
  | 'effortLevel'
  | 'model'
  | 'contextWindow'
  | 'contextPercentage'
  | 'committed'
  | 'state'
  | 'seqHigh'
  | 'providerId'
  | 'providerLabel'
> & {
  permissionMode?: PermissionMode;
  effortLevel?: EffortLevel;
  model?: string;
  contextWindow?: number;
  contextPercentage?: number;
  committed?: boolean;
  state?: SessionState;
  seqHigh?: number;
  providerId?: string;
  providerLabel?: string;
};

export type UsageData = Omit<
  UsageData_Serialize,
  'fiveHour' | 'sevenDay' | 'sevenDayOpus' | 'sevenDaySonnet' | 'sessionCostUsd'
> & {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  sevenDayOpus?: UsageWindow;
  sevenDaySonnet?: UsageWindow;
  sessionCostUsd?: number;
};

/** `ProviderModel` read from a view (nested in `ProviderProfileInfo.models`,
 *  Rust-pushed) vs. constructed here for `setProviderProfile` — same
 *  null-stripping either way, different specta phase per direction. */
type ProviderModelRead = Omit<ProviderModel_Serialize, 'label'> & { label?: string };
export type ProviderModel = Omit<ProviderModel_Deserialize, 'label'> & { label?: string };

export type ProviderProfileInfo = Omit<ProviderProfileInfo_Serialize, 'models' | 'defaultModel'> & {
  models: ProviderModelRead[];
  defaultModel?: string;
};

/** `protocol::commands::SeqRange` is a plain Rust type alias (`(u64, u64)`),
 *  not a nominal type specta can derive on — every field of this shape gets
 *  its own inline `[number, number]` tuple in the generated file instead of
 *  a shared named export. Declared once here for the handful of call sites
 *  that want the name. */
export type SeqRange = [number, number];

export type PhoneToBridgeMessage =
  | Msg<'input', InputMsg_Deserialize>
  | Msg<'question-input', QuestionInputMsg_Deserialize>
  | Msg<'permission-res', PermissionResMsg_Deserialize>
  | Msg<'keypress', KeypressMsg_Deserialize>
  | Msg<'mode', ModeChangeMsg_Deserialize>
  | Msg<'effort', EffortChangeMsg_Deserialize>
  | Msg<'model', ModelChangeMsg_Deserialize>
  | Msg<'sync-request', SyncRequestMsg_Deserialize>
  | Msg<'sync-ack', SyncAckMsg_Deserialize>
  | Msg<'create-session', CreateSessionMsg_Deserialize>
  | Msg<'refresh-sessions', BareMsg_Deserialize>
  | Msg<'close-session', SessionIdMsg_Deserialize>
  | Msg<'interrupt', SessionIdMsg_Deserialize>
  | Msg<'create-folder', CreateFolderMsg_Deserialize>
  | Msg<'upload-image', UploadImageMsg_Deserialize>
  | Msg<'usage-request', SessionIdMsg_Deserialize>
  | Msg<'gsd-request', SessionIdMsg_Deserialize>
  | Msg<'models-request', BareMsg_Deserialize>
  | Msg<'set-credentials', SetCredentialsMsg_Deserialize>
  | Msg<'set-device-config', SetDeviceConfigMsg_Deserialize>
  | Msg<'pair-request', PairRequestMsg_Deserialize>
  | Msg<'set-provider-profile', SetProviderProfileMsg_Deserialize>
  | Msg<'provider-profiles-request', BareMsg_Deserialize>;

export type BridgeToPhoneMessage =
  | Msg<'sessions', SessionListMsg_Serialize>
  | Msg<'output', OutputMsg_Serialize>
  | Msg<'input-ack', InputAckMsg>
  | Msg<'sync-begin', SyncBeginMsg>
  | Msg<'sync-chunk', SyncChunkMsg_Serialize>
  | Msg<'sync-end', SyncEndMsg>
  | Msg<'session-pending', SessionPendingMsg>
  | Msg<'session-ready', SessionReadyMsg_Serialize>
  | Msg<'session-failed', SessionFailedMsg>
  | Msg<'input-failed', InputFailedMsg_Serialize>
  | Msg<'close-session-ack', CloseSessionAckMsg>
  | Msg<'session-replaced', SessionReplacedMsg_Serialize>
  | Msg<'mode-confirmed', ModeConfirmedMsg>
  | Msg<'effort-confirmed', EffortConfirmedMsg>
  | Msg<'model-confirmed', ModelConfirmedMsg>
  | Msg<'folder-ack', FolderAckMsg_Serialize>
  | Msg<'usage', UsageMsg_Serialize>
  | Msg<'gsd-state', GsdStateMsg>
  | Msg<'models', ModelsMsg_Serialize>
  | Msg<'credentials-ack', CredentialsAckMsg_Serialize>
  | Msg<'device-config-ack', DeviceConfigAckMsg_Serialize>
  | Msg<'pair-ack', PairAckMsg_Serialize>
  | Msg<'provider-profiles', ProviderProfilesMsg_Serialize>
  | Msg<'provider-profile-ack', ProviderProfileAckMsg_Serialize>;

// Individual message shapes a handful of files name directly rather than
// narrowing the full union — same `Msg<>` construction, one variant each.
export type CreateSessionMessage = Msg<'create-session', CreateSessionMsg_Deserialize>;
export type FolderAckMessage = Msg<'folder-ack', FolderAckMsg_Serialize>;
export type UploadImageMessage = Msg<'upload-image', UploadImageMsg_Deserialize>;
export type SetProviderProfileMessage = Msg<'set-provider-profile', SetProviderProfileMsg_Deserialize>;
export type PairAckMessage = Msg<'pair-ack', PairAckMsg_Serialize>;
export type ModelsMessage = Msg<'models', ModelsMsg_Serialize>;
export type ProviderProfilesMessage = Msg<'provider-profiles', ProviderProfilesMsg_Serialize>;
export type SessionListMessage = Msg<'sessions', SessionListMsg_Serialize>;
export type SyncBeginMessage = Msg<'sync-begin', SyncBeginMsg>;
export type SyncChunkMessage = Msg<'sync-chunk', SyncChunkMsg_Serialize>;
export type SyncEndMessage = Msg<'sync-end', SyncEndMsg>;
