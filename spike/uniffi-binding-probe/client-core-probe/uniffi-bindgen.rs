// Binding generator entrypoint (uniffi proc-macro mode).
//   cargo run --bin uniffi-bindgen -- generate --library <cdylib> --language kotlin --out-dir <dir>
fn main() {
    uniffi::uniffi_bindgen_main()
}
