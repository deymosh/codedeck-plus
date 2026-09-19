//! Resolve the shared codec conformance corpus (owned by `packages/protocol`,
//! also read by the TS side) to an ABSOLUTE path, so
//! `tests/codec_conformance.rs` carries no fragile `../../..` literal — just
//! `include_str!(env!("CODEDECK_PROTOCOL_CORPUS"))`.

use std::path::Path;

fn main() {
    // <workspace>/crates/protocol
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let corpus = Path::new(&manifest)
        .join("../../packages/protocol/fixtures/corpus.json")
        .canonicalize()
        .expect("packages/protocol/fixtures/corpus.json must exist");

    println!("cargo:rerun-if-changed={}", corpus.display());
    println!("cargo:rustc-env=CODEDECK_PROTOCOL_CORPUS={}", corpus.display());
}
