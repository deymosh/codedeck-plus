//! Mesh onboarding through the local `nvpn` CLI (nostr-vpn), and applying a
//! phone's device config.
//!
//! Onboarding is nvpn's manual-join flow: the pairing QR carries the active
//! network id and this machine's admin device id (both public); the phone
//! joins with them; when it reports its mesh pubkey in `set-device-config`,
//! the bridge authorizes it and publishes the signed roster
//! (`add-device --publish` — without `--publish` the change never reaches
//! the phone). Every call is best effort; without nvpn, pairing still works.

use std::path::{Path, PathBuf};
use std::time::Duration;

use protocol::common::{DeviceConfig, DeviceRole};
use serde_json::Value;
use tokio::process::Command;

use crate::state::StateFile;

/// What the pairing QR needs to let the phone join the mesh.
pub struct Onboarding {
    pub network_id: String,
    pub admin_device_id: String,
}

pub struct Mesh {
    nvpn: Option<PathBuf>,
}

fn valid_pubkey(pk: &str) -> bool {
    (pk.len() == 64 && pk.chars().all(|c| c.is_ascii_hexdigit()))
        || (pk.starts_with("npub1") && pk.len() > 11 && pk[5..].chars().all(|c| "023456789acdefghjklmnpqrstuvwxyz".contains(c)))
}

impl Mesh {
    /// `nvpn` from config/env, else its usual install locations. Disabled
    /// (every call a no-op) when it is not found or turned off.
    pub fn new(explicit: Option<String>, enabled: bool, home: &Path) -> Self {
        if !enabled {
            log::info!("[Mesh] Mesh admin disabled by config — pairing QRs carry no mesh join info");
            return Self { nvpn: None };
        }
        let candidates = [
            explicit.map(PathBuf::from),
            Some(home.join(".cargo/bin/nvpn")),
            Some(home.join(".local/bin/nvpn")),
            Some(PathBuf::from("/usr/local/bin/nvpn")),
            Some(PathBuf::from("/usr/bin/nvpn")),
        ];
        let nvpn = candidates.into_iter().flatten().find(|p| p.exists());
        if nvpn.is_none() {
            log::info!("[Mesh] nvpn not found — mesh onboarding off (install the nostr-vpn CLI or set CODEDECK_NVPN_PATH)");
        }
        Self { nvpn }
    }

    pub fn available(&self) -> bool {
        self.nvpn.is_some()
    }

    async fn run(&self, args: &[&str], timeout: Duration) -> Option<(bool, String, String)> {
        let nvpn = self.nvpn.as_ref()?;
        let out = tokio::time::timeout(timeout, Command::new(nvpn).args(args).kill_on_drop(true).output()).await.ok()?.ok()?;
        Some((out.status.success(), String::from_utf8_lossy(&out.stdout).trim().to_string(), String::from_utf8_lossy(&out.stderr).trim().to_string()))
    }

    async fn status(&self) -> Option<Value> {
        let (ok, stdout, _) = self.run(&["status", "--json"], Duration::from_secs(15)).await?;
        ok.then(|| serde_json::from_str(&stdout).ok()).flatten()
    }

    pub async fn onboarding(&self) -> Option<Onboarding> {
        let status = self.status().await?;
        let network_id = status.get("network_id")?.as_str().filter(|s| !s.is_empty())?.to_string();
        let admin_device_id = status.get("device_id")?.as_str().filter(|s| s.starts_with("npub1"))?.to_string();
        Some(Onboarding { network_id, admin_device_id })
    }

    async fn daemon_running(&self) -> bool {
        self.status().await.and_then(|s| s.pointer("/daemon/running").and_then(Value::as_bool)).unwrap_or(false)
    }

    /// Authorize a device on the active network and publish the roster. The
    /// operator-facing outcome.
    async fn add_device(&self, pubkey: &str, label: &str) -> String {
        if !valid_pubkey(pubkey) {
            return format!("Couldn't authorize \"{label}\" on the mesh: invalid pubkey.");
        }
        match self.run(&["add-device", "--device", pubkey, "--publish", "--json"], Duration::from_secs(45)).await {
            Some((true, _, _)) if self.daemon_running().await => format!("Test device \"{label}\" authorized on the mesh."),
            Some((true, _, _)) => format!(
                "Mesh roster updated for \"{label}\", but the nvpn service isn't running — start it on this machine to finish authorizing the device."
            ),
            Some((false, out, err)) if format!("{err}\n{out}").to_lowercase().contains("active network is not administered by this device") => format!(
                "Couldn't authorize \"{label}\" on the mesh: this machine is not an admin of the active nvpn network. Run the pairing from the network's admin machine, or make this device an admin."
            ),
            _ => format!("Couldn't authorize \"{label}\" on the mesh (is an nvpn network active?)."),
        }
    }

    /// A phone's mesh IP derived from its pubkey — only right when its mesh
    /// key is its pairing key; used when the phone did not report its IP.
    async fn derive_ip(&self, pubkey: &str) -> Option<String> {
        if !valid_pubkey(pubkey) {
            return None;
        }
        let (ok, stdout, _) = self.run(&["ip", "--device", pubkey, "--peer", "--json"], Duration::from_secs(15)).await?;
        let v: Value = ok.then(|| serde_json::from_str(&stdout).ok()).flatten()?;
        let first = v.as_array().and_then(|a| a.first().cloned()).unwrap_or(v);
        let ip = first.as_str()?.split('/').next()?.trim().to_string();
        crate::devices::is_mesh_host(&ip).then_some(ip)
    }

    /// Apply a phone's device config: for a test target, authorize its mesh
    /// key and work out its adb serial; then store the config per phone and
    /// in `<first root>/.codedeck/device-config.json`, where a test session
    /// reads it. The mesh-only fields are not stored. Returns what to tell
    /// the operator, if anything.
    pub async fn apply(
        &self,
        state: &StateFile,
        first_root: &Path,
        phone: &str,
        mut config: DeviceConfig,
    ) -> Result<Option<String>, String> {
        let mut notice = None;
        if config.role == Some(DeviceRole::TestTarget) {
            let label = if config.label.is_empty() { "phone".to_string() } else { config.label.clone() };
            // The phone's mesh engine has its own key; the pairing key is
            // only a fallback and is right only if the two coincide.
            let mesh_key = config.mesh_pubkey.clone().unwrap_or_else(|| phone.to_string());
            if self.available() {
                notice = Some(self.add_device(&mesh_key, &label).await);
            }
            if config.serial.is_none() {
                config.serial = match config.mesh_ip.as_deref().filter(|ip| crate::devices::is_mesh_host(ip)) {
                    // Port 0: the device tools sweep for the live port at connect time.
                    Some(ip) => Some(format!("{ip}:0")),
                    None => self.derive_ip(&mesh_key).await.map(|ip| format!("{ip}:0")),
                };
            }
        }
        config.mesh_ip = None;
        config.mesh_pubkey = None;
        let json = serde_json::to_string_pretty(&config).expect("config serializes");
        state.set(&format!("deviceConfig.{phone}"), &json)?;
        let dir = first_root.join(".codedeck");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("device-config.json"), &json).map_err(|e| e.to_string())?;
        log::info!(
            "[Mesh] Device config saved: {} ({}, role {:?})",
            config.label,
            config.serial.as_deref().unwrap_or("no serial"),
            config.role
        );
        Ok(notice)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::common::AppUnderTest;

    #[test]
    fn pubkeys_are_hex_or_npub_only() {
        assert!(valid_pubkey(&"a".repeat(64)));
        assert!(valid_pubkey("npub1qy07k9ngrqf7f35ed609vhq6ta2zham62t0ak3aaznscjl92vfysv3mghs"));
        assert!(!valid_pubkey("--publish"));
        assert!(!valid_pubkey("npub1ABC"));
    }

    #[tokio::test]
    async fn a_test_target_gets_its_serial_from_the_reported_mesh_ip_and_mesh_fields_are_not_stored() {
        let dir = tempfile::tempdir().unwrap();
        let state = StateFile::open(dir.path()).unwrap();
        let mesh = Mesh { nvpn: None };
        let config = DeviceConfig {
            label: "Pixel".into(),
            role: Some(DeviceRole::TestTarget),
            serial: None,
            mesh_ip: Some("10.44.9.8".into()),
            mesh_pubkey: Some("b".repeat(64)),
            app_under_test: AppUnderTest::Kubo,
            custom_package: None,
            custom_build_cmd: None,
            project_dir: None,
        };
        assert_eq!(mesh.apply(&state, dir.path(), "phonepk", config).await.unwrap(), None);
        let stored = state.get("deviceConfig.phonepk").unwrap();
        assert!(stored.contains("10.44.9.8:0") && !stored.contains("meshIp") && !stored.contains("meshPubkey"));
        assert!(std::fs::read_to_string(dir.path().join(".codedeck/device-config.json")).unwrap().contains("10.44.9.8:0"));
    }
}
