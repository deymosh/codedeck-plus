// Mesh plugin commands. `mesh_action` is the generic passthrough to the engine's dispatchJson
// (used for invite import, network create/join, settings); the others are convenience wrappers.
const COMMANDS: &[&str] = &[
    "join_mesh",
    "leave_mesh",
    "mesh_status",
    "mesh_action",
    "open_wireless_debugging",
    "prepare_adb",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
