const COMMANDS: &[&str] = &[
    "start_service",
    "stop_service",
    "is_running",
    "update_state",
    "get_connectivity",
    "watch_connectivity",
    "unwatch_connectivity",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
