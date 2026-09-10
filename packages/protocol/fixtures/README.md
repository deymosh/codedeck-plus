# `fixtures/corpus.json` — the shared codec conformance corpus

The executable half of "one source of truth" for the wire. `packages/protocol`
(zod) is the **normative spec**; `crates/client-core::wire` is a Rust mirror of
it. This corpus is what keeps them from drifting.

## Consumed by

| Side | Test | Runner |
|---|---|---|
| TS | `packages/protocol/src/__tests__/fixtures.test.ts` | `pnpm test` (CI `verify` job) |
| Rust | `crates/client-core/tests/codec_conformance.rs` | `cargo test` (CI `cargo` job — `core` path filter includes `fixtures/**`) |

Both run the **identical assertions on the identical bytes**:

- `phoneToBridge.valid` / `bridgeToPhone.valid` — each decodes, and
  `encode(decode(x))` re-decodes to an equal value (semantic round-trip).
- `phoneToBridge.rejected` / `bridgeToPhone.rejected` — each is a decode error.
- `forwardCompatible` — each still decodes (unknown fields are ignored, matching
  zod's default strip and serde's default behaviour).

A schema change mirrored on only one side fails CI there.

## How it stays complete and correct

- **Correct:** every `valid` entry is run through the real `decode*` (= zod
  `safeParse` / serde), so a fixture that isn't actually valid per the spec
  fails the test. Same for `rejected`.
- **Complete:** `fixtures.test.ts` introspects `phoneToBridgeSchema` /
  `bridgeToPhoneSchema` for the full set of `type` literals and asserts the
  corpus covers every one (and names no unknown type). Add a message type to
  the union → this test fails until the corpus has a fixture for it.

It is **hand-curated on purpose** — a random generator (`zod-mock` &c.) produces
non-deterministic, non-representative data and can't express the deliberate
edge cases (tristate keep/clear/set, empty `models` + `error`, the two
`upload-image` shapes, a heartbeat with tombstones + `machineOffline`).

## Adding a message / field

1. Change the zod schema in `packages/protocol/src/schemas/`.
2. Mirror it in `crates/client-core/src/wire/`.
3. Add / update the fixture(s) here.
4. `pnpm --filter @codedeck/protocol test` and
   `cargo test -p client-core` must both pass.
