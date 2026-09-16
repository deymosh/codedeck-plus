// Binding generator entrypoint (UniFFI library mode — reads the already-built
// cdylib's embedded metadata, no `.udl` file):
//   cargo run --bin uniffi-bindgen -- generate --library <cdylib> --language kotlin --out-dir <dir>
// See spike/uniffi-binding-probe/client-core-probe/uniffi-bindgen.rs, which
// this mirrors exactly.
fn main() {
    uniffi::uniffi_bindgen_main()
}
