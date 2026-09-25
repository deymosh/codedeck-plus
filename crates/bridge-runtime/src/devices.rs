//! Device tools for device-test sessions: a closed set of adb operations the
//! agent can call (as the `codedeck` host tools), reaching the test phone
//! over the mesh.
//!
//! Security: every call is an argv array (never a shell string on this
//! machine), the serial is validated before any call, values that reach the
//! device's own shell are restricted to safe characters, logcat is scoped to
//! the app under test and scrubbed of secret shapes, and the port sweep that
//! recovers a rotated Wireless Debugging port only ever targets the mesh
//! range (10.44.0.0/16).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use agent_protocol::HostToolSpec;
use base64::Engine as _;
use protocol::common::{EntryBody, NoticeKind, OutputEntry};
use regex::Regex;
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::process::Command;

const ADB_TIMEOUT: Duration = Duration::from_secs(30);
const PORT_SCAN_BUDGET: Duration = Duration::from_secs(25);
/// A device tool's text result is capped before it goes to the agent.
const RESULT_CAP: usize = 60_000;
/// Screenshots are downscaled to this long edge before they ride the relay.
const SCREENSHOT_MAX_EDGE: u32 = 720;

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("valid regex"))
}

/// Scrub common secret shapes (bearer tokens, JWTs, nsecs, key=value
/// secrets, long hex) from text before it leaves the machine.
pub fn redact_secrets(text: &str) -> String {
    static BEARER: OnceLock<Regex> = OnceLock::new();
    static JWT: OnceLock<Regex> = OnceLock::new();
    static NSEC: OnceLock<Regex> = OnceLock::new();
    static KV: OnceLock<Regex> = OnceLock::new();
    static HEX: OnceLock<Regex> = OnceLock::new();
    let t = re(&BEARER, r"(?i)\bBearer\s+[A-Za-z0-9._\-]+").replace_all(text, "Bearer [REDACTED]");
    let t = re(&JWT, r"\beyJ[A-Za-z0-9._-]{10,}").replace_all(&t, "[REDACTED_JWT]");
    let t = re(&NSEC, r"(?i)\bnsec1[02-9ac-hj-np-z]{20,}").replace_all(&t, "[REDACTED_NSEC]");
    let t = re(&KV, r#"(?i)([A-Za-z]*(?:api[_-]?key|secret|token|password|passwd|pwd|authorization|auth))\s*[=:]\s*["']?[^\s"'&]+"#)
        .replace_all(&t, "$1=[REDACTED]");
    re(&HEX, r"\b[A-Fa-f0-9]{64,}\b").replace_all(&t, "[REDACTED_HEX]").into_owned()
}

/// A mesh IP:port, or a bare device serial.
pub fn valid_serial(serial: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    re(&RE, r"^[A-Za-z0-9][A-Za-z0-9.:_-]{2,63}$").is_match(serial)
}

pub fn is_mesh_host(host: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    re(&RE, r"^10\.44\.\d{1,3}\.\d{1,3}$").is_match(host)
}

fn split_host_port(serial: &str) -> Option<(String, u16)> {
    let (host, port) = serial.rsplit_once(':')?;
    let ipv4 = host.split('.').count() == 4 && host.split('.').all(|o| o.parse::<u8>().is_ok());
    (ipv4 || host.starts_with('[')).then_some(())?;
    Some((host.to_string(), port.parse().ok()?))
}

/// What the agent sees: the tools, their descriptions and argument schemas.
pub fn tool_specs() -> Vec<HostToolSpec> {
    let serial = json!({"type": "string", "description": "the device serial (mesh IP:port)"});
    let spec = |name: &str, description: &str, properties: Value, required: &[&str]| HostToolSpec {
        name: name.into(),
        description: description.into(),
        input_schema: json!({"type": "object", "properties": properties, "required": required}),
    };
    vec![
        spec("connect", "Connect adb to the test device over the mesh (serial = mesh IP:port).", json!({"serial": serial}), &["serial"]),
        spec("list", "List adb devices currently visible to the laptop.", json!({}), &[]),
        spec(
            "install",
            "Install (reinstall) an APK on the test device.",
            json!({"serial": serial, "apkPath": {"type": "string"}}),
            &["serial", "apkPath"],
        ),
        spec(
            "launch",
            "Launch an app on the test device by package id (optional explicit activity).",
            json!({"serial": serial, "pkg": {"type": "string"}, "activity": {"type": "string"}}),
            &["serial", "pkg"],
        ),
        spec(
            "logcat",
            "Fetch the last N lines of logcat (default 200, max 2000). Pass pkg (the app-under-test package id) to scope output to that app only — strongly preferred, so other apps' logs and secrets never leave the device. Output is secret-redacted regardless.",
            json!({"serial": serial, "lines": {"type": "number"}, "pkg": {"type": "string"}}),
            &["serial"],
        ),
        spec(
            "ui_dump",
            "Dump the current UI hierarchy as XML (small; use for assertions instead of screenshots).",
            json!({"serial": serial}),
            &["serial"],
        ),
        spec(
            "screenshot",
            "Capture a screenshot of the test device and deliver it to the phone for the human to see.",
            json!({"serial": serial}),
            &["serial"],
        ),
        spec(
            "tap",
            "Tap the screen at pixel coordinates (x, y).",
            json!({"serial": serial, "x": {"type": "number"}, "y": {"type": "number"}}),
            &["serial", "x", "y"],
        ),
        spec(
            "type_text",
            "Type text into the focused field.",
            json!({"serial": serial, "text": {"type": "string"}}),
            &["serial", "text"],
        ),
        spec(
            "key",
            "Send a key event (e.g. KEYCODE_BACK, KEYCODE_ENTER, KEYCODE_HOME).",
            json!({"serial": serial, "keycode": {"type": "string"}}),
            &["serial", "keycode"],
        ),
    ]
}

pub struct Outcome {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

impl Outcome {
    fn fail(msg: impl Into<String>) -> Self {
        Self { ok: false, stdout: String::new(), stderr: msg.into() }
    }

    /// The tool result text.
    pub fn text(&self) -> String {
        let body = if self.ok {
            if self.stdout.is_empty() { "(ok)".to_string() } else { self.stdout.clone() }
        } else {
            format!("ERROR: {}", if self.stderr.is_empty() { "failed" } else { &self.stderr })
        };
        body.chars().take(RESULT_CAP).collect()
    }
}

/// A finished tool call: the text for the agent, and for a screenshot the
/// entry for the session's transcript.
pub struct ToolResult {
    pub text: String,
    pub is_error: bool,
    pub entry: Option<OutputEntry>,
}

pub struct Devices {
    adb: PathBuf,
    artifacts: PathBuf,
    /// The last port that worked per mesh host: recovery after a Wireless
    /// Debugging toggle is fast in the common case.
    last_good: HashMap<String, u16>,
}

impl Devices {
    pub fn new(adb: Option<String>, home: &Path) -> Self {
        let adb = adb.map(PathBuf::from).unwrap_or_else(|| home.join("Android/Sdk/platform-tools/adb"));
        Self { adb, artifacts: std::env::temp_dir().join("codedeck-device-artifacts"), last_good: HashMap::new() }
    }

    async fn exec(&self, args: &[&str]) -> (Outcome, Vec<u8>) {
        let run = Command::new(&self.adb).args(args).kill_on_drop(true).output();
        match tokio::time::timeout(ADB_TIMEOUT, run).await {
            Ok(Ok(out)) => (
                Outcome {
                    ok: out.status.success(),
                    stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
                    stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
                },
                out.stdout,
            ),
            Ok(Err(e)) => (Outcome::fail(format!("adb failed to run ({}): {e}", self.adb.display())), Vec::new()),
            Err(_) => (Outcome::fail("adb timed out"), Vec::new()),
        }
    }

    async fn adb(&self, serial: &str, args: &[&str]) -> Outcome {
        let mut all = vec!["-s", serial];
        all.extend_from_slice(args);
        self.exec(&all).await.0
    }

    async fn online(&self, serial: &str) -> bool {
        let (r, _) = self.exec(&["devices"]).await;
        r.ok && r.stdout.lines().any(|l| {
            (l.starts_with(&format!("{serial}\t")) || l.starts_with(&format!("{serial} ")))
                && l.split_whitespace().any(|w| w == "device")
                && !l.contains("offline")
                && !l.contains("unauthorized")
        })
    }

    async fn probe(host: &str, port: u16, timeout: Duration) -> bool {
        matches!(tokio::time::timeout(timeout, TcpStream::connect((host, port))).await, Ok(Ok(_)))
    }

    /// Find the rotated Wireless Debugging port on a mesh host: the last
    /// known one first, then the band adbd has been seen in, then the rest of
    /// the ephemeral range — in parallel batches, within a time budget.
    async fn discover_port(&self, host: &str, last: Option<u16>) -> Option<u16> {
        if !is_mesh_host(host) {
            return None;
        }
        if let Some(p) = last.filter(|p| *p > 0) {
            if Self::probe(host, p, Duration::from_millis(1200)).await {
                return Some(p);
            }
        }
        let deadline = Instant::now() + PORT_SCAN_BUDGET;
        for (lo, hi) in [(35000u16, 46000u16), (30000, 35000), (46000, 61000)] {
            let mut start = lo;
            while start <= hi {
                if Instant::now() > deadline {
                    return None;
                }
                let end = start.saturating_add(95).min(hi);
                let probes = (start..=end).map(|p| {
                    let host = host.to_string();
                    async move { Self::probe(&host, p, Duration::from_millis(1200)).await.then_some(p) }
                });
                if let Some(found) = futures_join_first(probes).await {
                    return Some(found);
                }
                start = end.saturating_add(1);
                if end == hi {
                    break;
                }
            }
        }
        None
    }

    /// Connect to `serial`, recovering a dropped connection or a rotated
    /// port. The serial that is actually online.
    async fn ensure_connected(&mut self, serial: &str) -> Result<String, String> {
        if self.online(serial).await {
            return Ok(serial.to_string());
        }
        let _ = self.exec(&["disconnect", serial]).await;
        let _ = self.exec(&["connect", serial]).await;
        if self.online(serial).await {
            return Ok(serial.to_string());
        }
        let Some((host, port)) = split_host_port(serial) else {
            return Err(format!("device {serial} not reachable and no host:port to recover"));
        };
        let last = self.last_good.get(&host).copied().or(Some(port));
        for candidate in [self.discover_port(&host, last).await, (port > 0).then_some(port)].into_iter().flatten() {
            let endpoint = format!("{host}:{candidate}");
            for attempt in 0..3u64 {
                let _ = self.exec(&["disconnect", &endpoint]).await;
                let _ = self.exec(&["connect", &endpoint]).await;
                for _ in 0..3 {
                    if self.online(&endpoint).await {
                        self.last_good.insert(host.clone(), candidate);
                        return Ok(endpoint);
                    }
                    tokio::time::sleep(Duration::from_millis(800)).await;
                }
                tokio::time::sleep(Duration::from_millis(500 * (attempt + 1))).await;
            }
        }
        Err(format!(
            "device {serial} unreachable: Wireless Debugging may be off (open CodeDeck → Settings → Mesh on the phone to re-enable) or the mesh is down."
        ))
    }

    /// Run on a connected device, reconnecting once on a connection-class failure.
    async fn with_device(&mut self, serial: &str, args: &[&str]) -> Outcome {
        static FAIL: OnceLock<Regex> = OnceLock::new();
        let fail = re(&FAIL, r"(?i)no devices|device offline|not found|connection refused|cannot connect|failed to connect|closed|protocol fault|device unauthorized");
        let live = match self.ensure_connected(serial).await {
            Ok(s) => s,
            Err(e) => return Outcome::fail(e),
        };
        let r = self.adb(&live, args).await;
        if r.ok || !fail.is_match(&r.stderr) {
            return r;
        }
        match self.ensure_connected(serial).await {
            Ok(again) => self.adb(&again, args).await,
            Err(_) => r,
        }
    }

    /// Run one tool call.
    pub async fn run(&mut self, tool: &str, args: &Value) -> ToolResult {
        let s = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or_default().trim().to_string();
        let result = |o: Outcome| ToolResult { text: o.text(), is_error: !o.ok, entry: None };
        if tool == "list" {
            return result(self.exec(&["devices", "-l"]).await.0);
        }
        let serial = s("serial");
        if !valid_serial(&serial) {
            return result(Outcome::fail(format!("invalid device serial: {serial:?}")));
        }
        match tool {
            "connect" => result(match self.ensure_connected(&serial).await {
                Ok(live) => Outcome { ok: true, stdout: format!("connected to {live}"), stderr: String::new() },
                Err(e) => Outcome::fail(e),
            }),
            "install" => {
                let apk = s("apkPath");
                if apk.is_empty() || !Path::new(&apk).exists() {
                    return result(Outcome::fail(format!("APK not found: {apk}")));
                }
                result(self.with_device(&serial, &["install", "-r", "-d", &apk]).await)
            }
            "launch" => {
                static PKG: OnceLock<Regex> = OnceLock::new();
                static ACT: OnceLock<Regex> = OnceLock::new();
                let pkg = s("pkg");
                let activity = s("activity");
                if !re(&PKG, r"^[A-Za-z0-9_.]+$").is_match(&pkg) {
                    return result(Outcome::fail(format!("invalid package: {pkg}")));
                }
                if !activity.is_empty() && !re(&ACT, r"^[A-Za-z0-9_./]+$").is_match(&activity) {
                    return result(Outcome::fail(format!("invalid activity: {activity}")));
                }
                if !activity.is_empty() {
                    let component = format!("{pkg}/{activity}");
                    let r = self.with_device(&serial, &["shell", "am", "start", "-n", &component]).await;
                    if r.ok && !r.stdout.contains("does not exist") && !r.stdout.contains("Error type 3") {
                        return result(r);
                    }
                }
                // Launch the package's LAUNCHER activity without naming it.
                result(self.with_device(&serial, &["shell", "monkey", "-p", &pkg, "-c", "android.intent.category.LAUNCHER", "1"]).await)
            }
            "logcat" => {
                let lines = args.get("lines").and_then(Value::as_f64).unwrap_or(200.0).clamp(1.0, 2000.0) as u32;
                let pkg = s("pkg");
                let mut pid = String::new();
                if !pkg.is_empty() && pkg.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.') {
                    pid = self.with_device(&serial, &["shell", "pidof", &pkg]).await.stdout.split_whitespace().next().unwrap_or("").to_string();
                }
                let n = lines.to_string();
                let mut cmd = vec!["logcat", "-d", "-t", n.as_str()];
                if !pid.is_empty() {
                    cmd.extend(["--pid", pid.as_str()]);
                }
                let mut o = self.with_device(&serial, &cmd).await;
                o.stdout = redact_secrets(&o.stdout);
                result(o)
            }
            "ui_dump" => result(self.with_device(&serial, &["exec-out", "uiautomator", "dump", "/dev/tty"]).await),
            "tap" => match (args.get("x").and_then(Value::as_f64), args.get("y").and_then(Value::as_f64)) {
                (Some(x), Some(y)) if x.is_finite() && y.is_finite() => {
                    let (x, y) = ((x.round() as i64).to_string(), (y.round() as i64).to_string());
                    result(self.with_device(&serial, &["shell", "input", "tap", &x, &y]).await)
                }
                _ => result(Outcome::fail("tap requires numeric x,y")),
            },
            "type_text" => {
                // `adb shell` joins its argv into one string for the DEVICE's
                // shell, so metacharacters are refused rather than quoted.
                let text = s("text");
                if !text.chars().all(|c| c.is_ascii_alphanumeric() || " ._@:/+,=-".contains(c)) {
                    return result(Outcome::fail("type_text rejects shell metacharacters (device-side sh injection)"));
                }
                let escaped = text.replace(' ', "%s");
                result(self.with_device(&serial, &["shell", "input", "text", &escaped]).await)
            }
            "key" => {
                let key = s("keycode");
                if key.is_empty() || !key.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_') {
                    return result(Outcome::fail(format!("invalid keycode: {key}")));
                }
                result(self.with_device(&serial, &["shell", "input", "keyevent", &key]).await)
            }
            "screenshot" => self.screenshot(&serial).await,
            other => result(Outcome::fail(format!("unknown device tool '{other}'"))),
        }
    }

    async fn screenshot(&mut self, serial: &str) -> ToolResult {
        let live = match self.ensure_connected(serial).await {
            Ok(s) => s,
            Err(e) => return ToolResult { text: format!("ERROR: {e}"), is_error: true, entry: None },
        };
        let (r, bytes) = self.exec(&["-s", &live, "exec-out", "screencap", "-p"]).await;
        if !r.ok || bytes.is_empty() {
            return ToolResult { text: format!("ERROR: screencap failed: {}", r.stderr), is_error: true, entry: None };
        }
        let entry = screenshot_entry(&bytes, &live);
        let kb = entry.1 / 1024;
        let _ = std::fs::create_dir_all(&self.artifacts);
        ToolResult { text: format!("Screenshot captured. delivered to phone ({kb} KB)"), is_error: false, entry: Some(entry.0) }
    }
}

/// Resolve the first `Some` of a batch of probes, running them concurrently.
async fn futures_join_first<F>(probes: impl Iterator<Item = F>) -> Option<u16>
where
    F: std::future::Future<Output = Option<u16>> + 'static,
{
    let mut set = tokio::task::JoinSet::new();
    for p in probes {
        set.spawn_local(p);
    }
    while let Some(done) = set.join_next().await {
        if let Ok(Some(port)) = done {
            set.abort_all();
            return Some(port);
        }
    }
    None
}

/// A screenshot notice for the transcript: the PNG downscaled to a
/// [`SCREENSHOT_MAX_EDGE`] long edge (the transfer, not the capture, is the
/// slow part on a weak link) as a data URI. With its size in bytes.
pub fn screenshot_entry(png: &[u8], serial: &str) -> (OutputEntry, usize) {
    let (bytes, width, height) = match image::load_from_memory_with_format(png, image::ImageFormat::Png) {
        Ok(img) => {
            let img = if img.width().max(img.height()) > SCREENSHOT_MAX_EDGE {
                img.resize(SCREENSHOT_MAX_EDGE, SCREENSHOT_MAX_EDGE, image::imageops::FilterType::Nearest)
            } else {
                img
            };
            let mut out = std::io::Cursor::new(Vec::new());
            match img.write_to(&mut out, image::ImageFormat::Png) {
                Ok(()) => (out.into_inner(), img.width(), img.height()),
                Err(_) => (png.to_vec(), 0, 0),
            }
        }
        // Undecodable: send the capture as it is (larger, still viewable).
        Err(_) => (png.to_vec(), 0, 0),
    };
    let uri = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes));
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let mut entry = OutputEntry::new(
        bridge_core::time::iso(now),
        EntryBody::Notice { kind: NoticeKind::Screenshot, text: format!("Screenshot of {serial} ({width}x{height})") },
    );
    entry.agent_extras = Some(json!({"imageDataUri": uri, "imageWidth": width, "imageHeight": height, "deviceSerial": serial}));
    (entry, bytes.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_scrubbed() {
        let out = redact_secrets("Authorization: Bearer abc.def-123 api_key=sk_live_1 nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqq token: 'xyz'");
        assert!(!out.contains("abc.def") && !out.contains("sk_live_1") && !out.contains("xyz"), "{out}");
        assert!(out.contains("[REDACTED_NSEC]"));
        assert_eq!(redact_secrets(&"ab".repeat(40)), "[REDACTED_HEX]");
    }

    #[test]
    fn serials_and_the_mesh_range_are_strict() {
        assert!(valid_serial("10.44.1.2:5555") && valid_serial("emulator-5554"));
        assert!(!valid_serial("-s evil") && !valid_serial("a;rm") && !valid_serial("ab"));
        assert!(is_mesh_host("10.44.3.4") && !is_mesh_host("127.0.0.1") && !is_mesh_host("10.45.0.1"));
        assert_eq!(split_host_port("10.44.1.2:0"), Some(("10.44.1.2".into(), 0)));
        assert_eq!(split_host_port("emulator-5554"), None);
    }

    #[test]
    fn the_agent_sees_ten_tools_with_object_schemas() {
        let specs = tool_specs();
        assert_eq!(specs.len(), 10);
        assert!(specs.iter().all(|s| s.input_schema["type"] == "object"));
    }

    #[tokio::test]
    async fn arguments_are_validated_before_adb_runs() {
        let mut d = Devices { adb: PathBuf::from("/nonexistent/adb"), artifacts: std::env::temp_dir(), last_good: HashMap::new() };
        let r = d.run("tap", &json!({"serial": "a;b"})).await;
        assert!(r.is_error && r.text.contains("invalid device serial"));
        let r = d.run("type_text", &json!({"serial": "10.44.1.2:5555", "text": "a; reboot"})).await;
        assert!(r.is_error && r.text.contains("metacharacters"));
        let r = d.run("key", &json!({"serial": "10.44.1.2:5555", "keycode": "BACK; x"})).await;
        assert!(r.is_error && r.text.contains("invalid keycode"));
        let r = d.run("launch", &json!({"serial": "10.44.1.2:5555", "pkg": "com.x;y"})).await;
        assert!(r.is_error && r.text.contains("invalid package"));
    }

    #[test]
    fn a_screenshot_is_downscaled_into_a_notice() {
        let img = image::RgbaImage::from_pixel(1440, 3120, image::Rgba([10, 20, 30, 255]));
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img).write_to(&mut png, image::ImageFormat::Png).unwrap();
        let (entry, size) = screenshot_entry(&png.into_inner(), "10.44.1.2:5555");
        let extras = entry.agent_extras.unwrap();
        assert_eq!(extras["imageHeight"], 720);
        assert!(extras["imageDataUri"].as_str().unwrap().starts_with("data:image/png;base64,"));
        assert!(size > 0);
        assert!(matches!(entry.body, EntryBody::Notice { kind: NoticeKind::Screenshot, .. }));
    }
}
