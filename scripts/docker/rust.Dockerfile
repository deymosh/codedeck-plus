# The Rust image `./codedeck` checks the crates in: a stock Rust toolchain
# with clippy, and nothing else. The cargo registry and the target directory
# live in named volumes, so a rerun only recompiles what changed.
#
# Built by `./codedeck` (check_rust); the build context is this directory.
FROM rust:1-bookworm
RUN rustup component add clippy
