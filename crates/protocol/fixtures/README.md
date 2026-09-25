# `fixtures/corpus.json` — the codec conformance corpus

Hand-curated wire examples for every protocol message, run by
`tests/codec_conformance.rs`. It pins the wire shape so a serde attribute
change that alters the JSON is caught, and it is the reference another
implementation of the protocol can test itself against.

- `phoneToBridge.valid` / `bridgeToPhone.valid` — each decodes, and
  `encode(decode(x))` re-decodes to an equal value (semantic round-trip).
- `phoneToBridge.rejected` / `bridgeToPhone.rejected` — each is a decode error.
- `forwardCompatible` — each still decodes (unknown fields are ignored).
- **Complete:** the test asserts the `valid` fixtures cover every message
  type, so adding a message type fails until it has a fixture here.

It is hand-curated on purpose: generated data cannot express the deliberate
edge cases (tristate keep/clear/set, empty `models` plus `error`, the two
`upload-image` shapes, a heartbeat with tombstones and `machineOffline`).

## Adding a message or field

1. Change the types in `crates/protocol/src/`.
2. Add or update the fixture(s) here.
3. `cargo test -p protocol` must pass.
