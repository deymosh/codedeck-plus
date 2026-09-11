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
 * This file changes no shape — it only names which half of an
 * already-generated pair is the one this app actually uses, the same way a
 * human author would have picked a single direction by hand before
 * generation existed.
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
} from './nativeCoreTypes.generated';
