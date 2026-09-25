// The UniFFI bindings generator, built from this crate (library mode — reads a
// cdylib's embedded metadata, no `.udl` file):
//   cargo run --bin uniffi-bindgen -- generate --library <cdylib> --language kotlin --no-format --out-dir <dir>
// `./codedeck gen-android-bindings` runs it.
fn main() {
    uniffi::uniffi_bindgen_main()
}
