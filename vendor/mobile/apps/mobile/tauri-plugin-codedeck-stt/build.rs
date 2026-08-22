const COMMANDS: &[&str] = &["recognize_speech"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
