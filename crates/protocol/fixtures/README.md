# `fixtures/corpus.json` — the codec conformance corpus

Hand-curated wire examples for every protocol message, run by
`tests/codec_conformance.rs`. It pins the wire shape so a serde attribute
change that alters the JSON is caught, and it is the reference another
implementation of the protocol can test itself against.

- `phoneToBridge.valid` / `bridgeToPhone.valid` — each decodes, and
  `encode(decode(x))` re-decodes to an equal value (semantic round-trip).
- `phoneToBridge.rejected` / `bridgeToPhone.rejected` — each is a decode error.
- A **string** entry in either list is raw wire text rather than a JSON
  object: a packed payload (`~` + base64 of the raw deflate stream, see
  `packing.rs`). It is generated with the crate's own `pack`, not by hand, and
  is written verbatim (re-serializing it as a JSON string would hide it from
  the packing path). A rejected string fixture must fail *unpacking*.
  The malformed ones are: bad base64, a truncated deflate stream, a stream
  that inflates to non-UTF-8, and one that inflates past
  `MAX_UNPACKED_BYTES`.
- `forwardCompatible` — each still decodes: unknown fields are ignored, and
  an unknown value of an open vocabulary (entry type, tool, task and notice
  kind, MCP status, session state, install state, terminal end reason,
  terminal event kind, terminal via) decodes as its catch-all.
- Every message carries `"v": 12`, the protocol version the codec stamps
  and checks first; a message of another version, or none, is rejected.
- **Complete:** the test asserts the `valid` fixtures cover every message
  type, so adding a message type fails until it has a fixture here.

It is hand-curated on purpose: generated data cannot express the deliberate
edge cases (tristate keep/clear/set, empty `models` plus `error`, the two
`upload-file` shapes, a heartbeat with tombstones and `machineOffline`).

## Adding a message or field

1. Change the types in `crates/protocol/src/`.
2. Add or update the fixture(s) here.
3. `cargo test -p protocol` must pass.
