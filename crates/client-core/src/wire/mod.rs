//! The wire contract — a mirror of `packages/protocol` (which stays the
//! normative zod spec). Increment order: `kinds` + `capabilities` first, then
//! the codec + message schemas + the shared `fixtures/` conformance corpus.

pub mod capabilities;
pub mod kinds;
