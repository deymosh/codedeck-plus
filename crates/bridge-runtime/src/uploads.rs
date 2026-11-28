//! Files a phone attaches to a session — photos or anything else. Two forms:
//! - Blossom: the phone uploaded an AES-256-GCM-encrypted blob and sends its
//!   URL, sha256, key and iv; the bridge downloads it (https, or http to an
//!   onion service; through the Tor proxy when one is set; size capped),
//!   checks the hash,
//!   decrypts it (tag = last 16 bytes);
//! - chunked: the file arrives as base64 pieces, reassembled here; a
//!   partial upload idle for a minute is dropped.
//!
//! Either way the file lands in `<first root>/.codedeck/uploads` — inside
//! the workspace, where the agent can read it — and the session gets a
//! message naming the path. Every file ends in a [`Settled`], so the sender
//! hears whether it arrived. The key and iv are secrets and never logged.

use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine as _;
use bridge_core::FileOutcome;
use protocol::commands::{UploadFileBlossomMsg, UploadFileChunkMsg};
use sha2::{Digest, Sha256};

use crate::work::{is_onion_http, NostrHttp};

/// Enough for photos and ordinary documents; the cap keeps a hostile
/// message from making the bridge buffer arbitrarily much.
pub const MAX_UPLOAD_BYTES: usize = 25 * 1024 * 1024;
const ASSEMBLY_IDLE: Duration = Duration::from_secs(60);
const MAX_OPEN_UPLOADS: usize = 16;
/// The same file with the same words, sent again within this window, is a
/// resend (the phone could not confirm delivery) — not a new message.
const DEDUP_WINDOW: Duration = Duration::from_secs(10 * 60);
const DEDUP_CAP: usize = 200;

/// The session input for a saved file: an image is to be looked at, any
/// other file is named for the agent to open as it sees fit.
pub fn input_text(user_text: &str, path: &Path, mime: &str) -> String {
    let trimmed = user_text.trim();
    let path = path.display();
    let image = mime.starts_with("image/");
    match (trimmed.is_empty(), image) {
        (true, true) => format!("Please examine this image: {path}"),
        (true, false) => format!("Please look at the attached file: {path}"),
        (false, true) => format!("{trimmed}\n\n[Attached image: {path} — use the Read tool to view it]"),
        (false, false) => format!("{trimmed}\n\n[Attached file: {path}]"),
    }
}

/// The extension a file of `mime` usually has, for a name that has none.
fn extension_for(mime: &str) -> Option<&'static str> {
    Some(match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/heic" => "heic",
        "application/pdf" => "pdf",
        "application/zip" => "zip",
        "application/json" => "json",
        "text/plain" => "txt",
        "text/markdown" => "md",
        "text/csv" => "csv",
        _ => return None,
    })
}

/// Whether `name` ends in an extension (a short alphanumeric suffix).
fn has_extension(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(stem, ext)| {
        !stem.is_empty() && (1..=8).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_alphanumeric())
    })
}

/// Whether the bridge downloads from `url`: `https://` to a host, or
/// `http://` to an onion service.
fn is_blossom_url(url: &str) -> bool {
    url.strip_prefix("https://").is_some_and(|rest| !rest.is_empty() && !rest.starts_with('/')) || is_onion_http(url)
}

/// Download, verify and decrypt a Blossom upload — through the Tor proxy
/// when one is set (see [`NostrHttp`]).
pub async fn fetch_blossom(http: &NostrHttp, msg: &UploadFileBlossomMsg) -> Result<Vec<u8>, String> {
    // The URL is phone-supplied: https (or http to an onion service) only,
    // and the body capped regardless of the size the message claims — the
    // bridge is not a general HTTP client.
    if !is_blossom_url(&msg.url) {
        return Err("download refused: https (or http to a .onion) required".into());
    }
    let http = http.for_url(&msg.url).map_err(|e| format!("download refused: {e}"))?;
    if msg.size_bytes as usize > MAX_UPLOAD_BYTES {
        return Err(format!("download refused: {} bytes is over the {MAX_UPLOAD_BYTES}-byte cap", msg.size_bytes));
    }
    log::info!("[Uploads] Downloading {} ({} bytes)", msg.url, msg.size_bytes);
    let mut res = http.get(&msg.url).timeout(Duration::from_secs(60)).send().await.map_err(|e| format!("download failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("download failed: HTTP {}", res.status()));
    }
    let mut body = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("download failed: {e}"))? {
        if body.len() + chunk.len() > MAX_UPLOAD_BYTES {
            return Err(format!("download refused: the body is over the {MAX_UPLOAD_BYTES}-byte cap"));
        }
        body.extend_from_slice(&chunk);
    }
    decrypt_blob(&body, &msg.hash, &msg.key, &msg.iv)
}

/// Check the ciphertext's sha256 against `hash_hex`, then decrypt it.
pub fn decrypt_blob(blob: &[u8], hash_hex: &str, key_hex: &str, iv_hex: &str) -> Result<Vec<u8>, String> {
    let hash = hex::encode(Sha256::digest(blob));
    if !hash.eq_ignore_ascii_case(hash_hex) {
        return Err(format!("hash mismatch: expected {hash_hex}, got {hash}"));
    }
    let key = hex::decode(key_hex).map_err(|_| "invalid key")?;
    let iv = hex::decode(iv_hex).map_err(|_| "invalid iv")?;
    if key.len() != 32 || iv.len() != 12 {
        return Err("invalid key or iv length".into());
    }
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "invalid key")?;
    cipher.decrypt(Nonce::from_slice(&iv), blob).map_err(|_| "decryption failed (wrong key or tampered data)".into())
}

struct Upload {
    session_id: String,
    input_id: Option<String>,
    filename: String,
    mime_type: String,
    text: String,
    total: u64,
    parts: BTreeMap<u64, String>,
    last: Instant,
}

/// Where uploads go, chunk assembly, and the resend guard.
pub struct Uploads {
    dir: PathBuf,
    uploads: BTreeMap<String, Upload>,
    injected: VecDeque<(String, Instant)>,
}

/// A file that is done with, for the engine's [`Input::FileSettled`].
///
/// [`Input::FileSettled`]: bridge_core::Input::FileSettled
#[derive(Debug, PartialEq, Eq)]
pub struct Settled {
    pub session_id: String,
    pub input_id: Option<String>,
    pub outcome: FileOutcome,
}

impl Settled {
    pub fn into_input(self) -> bridge_core::Input {
        bridge_core::Input::FileSettled { session_id: self.session_id, input_id: self.input_id, outcome: self.outcome }
    }

    fn failed(session_id: &str, input_id: &Option<String>, detail: impl Into<String>) -> Self {
        Self { session_id: session_id.to_string(), input_id: input_id.clone(), outcome: FileOutcome::Failed(detail.into()) }
    }
}

/// What a file is known by to this resend guard: the upload (or blob) and
/// the words sent with it. A file with its sender's id has none here — the
/// engine guards it by that id, and only once it reached the session.
fn resend_key(session_id: &str, input_id: Option<&str>, fallback: &str, text: &str) -> Option<String> {
    input_id.is_none().then(|| format!("{session_id}|{fallback}|{}", &hex::encode(Sha256::digest(text.as_bytes()))[..16]))
}

impl Uploads {
    pub fn new(first_root: &Path) -> Self {
        Self { dir: first_root.join(".codedeck").join("uploads"), uploads: BTreeMap::new(), injected: VecDeque::new() }
    }

    /// Take one chunk. What settled: this upload, once every chunk is in or
    /// as soon as it is refused. An upload that went idle is dropped without
    /// an answer: its sender's own wait has ended it, and a retry of it under
    /// the same id must not hear the old attempt's failure.
    pub fn chunk(&mut self, msg: UploadFileChunkMsg) -> Vec<Settled> {
        let mut settled = Vec::new();
        self.uploads.retain(|id, u| {
            let fresh = u.last.elapsed() < ASSEMBLY_IDLE;
            if !fresh {
                log::warn!("[Uploads] Upload {id} timed out ({}/{} chunks)", u.parts.len(), u.total);
            }
            fresh
        });
        if msg.total_chunks == 0 || msg.chunk_index >= msg.total_chunks {
            log::warn!("[Uploads] Chunk {} out of range for upload {} — skipped", msg.chunk_index, msg.upload_id);
            let detail = format!("piece {} of {} is out of range", msg.chunk_index, msg.total_chunks);
            settled.push(Settled::failed(&msg.session_id, &msg.input_id, detail));
            return settled;
        }
        if !self.uploads.contains_key(&msg.upload_id) && self.uploads.len() >= MAX_OPEN_UPLOADS {
            log::warn!("[Uploads] Too many uploads in progress — {} dropped", msg.upload_id);
            settled.push(Settled::failed(&msg.session_id, &msg.input_id, "too many files are arriving at once"));
            return settled;
        }
        let upload = self.uploads.entry(msg.upload_id.clone()).or_insert_with(|| Upload {
            session_id: msg.session_id.clone(),
            input_id: None,
            filename: msg.filename.clone(),
            mime_type: msg.mime_type.clone(),
            text: msg.text.clone(),
            total: msg.total_chunks,
            parts: BTreeMap::new(),
            last: Instant::now(),
        });
        // Idle-based: a slow phone that keeps sending never times out.
        upload.last = Instant::now();
        if upload.input_id.is_none() {
            upload.input_id = msg.input_id.clone();
        }
        if msg.chunk_index == 0 && !msg.text.is_empty() {
            upload.text = msg.text.clone();
        }
        let size: usize = upload.parts.values().map(String::len).sum::<usize>() + msg.base64_data.len();
        if size > MAX_UPLOAD_BYTES * 4 / 3 + 4 {
            log::warn!("[Uploads] Upload {} is over the size cap — dropped", msg.upload_id);
            let upload = self.uploads.remove(&msg.upload_id).expect("present");
            settled.push(Settled::failed(&upload.session_id, &upload.input_id, format!("the file is over the {MAX_UPLOAD_BYTES}-byte cap")));
            return settled;
        }
        upload.parts.insert(msg.chunk_index, msg.base64_data);
        if (upload.parts.len() as u64) < upload.total {
            return settled;
        }
        let upload = self.uploads.remove(&msg.upload_id).expect("present");
        let joined: String = upload.parts.into_values().collect();
        let outcome = match base64::engine::general_purpose::STANDARD.decode(joined.as_bytes()) {
            Ok(data) => {
                let key = resend_key(&upload.session_id, upload.input_id.as_deref(), &format!("upload:{}", msg.upload_id), &upload.text);
                self.finish(&upload.filename, &upload.mime_type, &upload.text, &data, key)
            }
            Err(err) => {
                log::warn!("[Uploads] Upload {} is not valid base64: {err}", msg.upload_id);
                FileOutcome::Failed("the file's data is not valid base64".into())
            }
        };
        settled.push(Settled { session_id: upload.session_id, input_id: upload.input_id, outcome });
        settled
    }

    /// A downloaded and decrypted Blossom file, saved.
    pub fn blossom(&mut self, msg: &UploadFileBlossomMsg, data: &[u8]) -> Settled {
        let key = resend_key(&msg.session_id, msg.input_id.as_deref(), &msg.hash, &msg.text);
        let outcome = self.finish(&msg.filename, &msg.mime_type, &msg.text, data, key);
        Settled { session_id: msg.session_id.clone(), input_id: msg.input_id.clone(), outcome }
    }

    /// Save a decoded file, unless `key` was delivered already.
    fn finish(&mut self, filename: &str, mime: &str, text: &str, data: &[u8], key: Option<String>) -> FileOutcome {
        self.injected.retain(|(_, at)| at.elapsed() < DEDUP_WINDOW);
        if key.as_ref().is_some_and(|key| self.injected.iter().any(|(k, _)| k == key)) {
            log::info!("[Uploads] A resend of a file already delivered — not delivered again");
            return FileOutcome::AlreadyDelivered;
        }
        let path = match self.write(filename, mime, data) {
            Ok(path) => path,
            Err(err) => {
                log::error!("[Uploads] Could not save a file: {err}");
                return FileOutcome::Failed(format!("the bridge could not save it: {err}"));
            }
        };
        log::info!("[Uploads] Saved {} ({} bytes)", path.display(), data.len());
        if let Some(key) = key {
            self.injected.push_back((key, Instant::now()));
            while self.injected.len() > DEDUP_CAP {
                self.injected.pop_front();
            }
        }
        FileOutcome::Ready(input_text(text, &path, mime))
    }

    /// Saved under a timestamp and the file's own (sanitized) name, which
    /// keeps its extension; a name without one gets the extension its MIME
    /// type usually has, when that is known.
    fn write(&self, filename: &str, mime: &str, data: &[u8]) -> std::io::Result<PathBuf> {
        fs::create_dir_all(&self.dir)?;
        let safe: String = filename.chars().map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' }).collect();
        let safe = if safe.trim_matches(['.', '_']).is_empty() { "file".to_string() } else { safe };
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        let name = match extension_for(mime) {
            Some(ext) if !has_extension(&safe) => format!("{stamp}-{safe}.{ext}"),
            _ => format!("{stamp}-{safe}"),
        };
        let path = self.dir.join(name);
        fs::write(&path, data)?;
        Ok(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(id: &str, i: u64, n: u64, data: &str, text: &str) -> UploadFileChunkMsg {
        UploadFileChunkMsg {
            session_id: "s".into(),
            upload_id: id.into(),
            filename: "../photo name.png".into(),
            mime_type: "image/png".into(),
            base64_data: data.into(),
            text: text.into(),
            chunk_index: i,
            total_chunks: n,
            input_id: None,
        }
    }

    fn with_id(mut msg: UploadFileChunkMsg, input_id: &str) -> UploadFileChunkMsg {
        msg.input_id = Some(input_id.into());
        msg
    }

    /// The one file that settled, and how.
    fn one(mut settled: Vec<Settled>) -> Settled {
        assert_eq!(settled.len(), 1, "{settled:?}");
        settled.remove(0)
    }

    fn failure(settled: &Settled) -> &str {
        match &settled.outcome {
            FileOutcome::Failed(detail) => detail,
            other => panic!("not a failure: {other:?}"),
        }
    }

    #[test]
    fn chunks_reassemble_in_any_order_into_a_safe_file_name() {
        let dir = tempfile::tempdir().unwrap();
        let mut uploads = Uploads::new(dir.path());
        let b64 = base64::engine::general_purpose::STANDARD.encode(b"PNGDATA-123");
        let (a, b) = b64.split_at(6);
        assert!(uploads.chunk(with_id(chunk("u1", 1, 2, b, ""), "f1")).is_empty());
        let settled = one(uploads.chunk(with_id(chunk("u1", 0, 2, a, "what is this?"), "f1")));
        assert_eq!((settled.session_id.as_str(), settled.input_id.as_deref()), ("s", Some("f1")));
        let FileOutcome::Ready(text) = settled.outcome else { panic!("{:?}", settled.outcome) };
        assert!(text.starts_with("what is this?\n\n[Attached image: ") && text.contains("-.._photo_name.png"));
        let path = text.split("image: ").nth(1).unwrap().split(" —").next().unwrap();
        assert!(Path::new(path).starts_with(dir.path().join(".codedeck/uploads")));
        assert_eq!(fs::read(path).unwrap(), b"PNGDATA-123");
    }

    #[test]
    fn without_an_id_a_resend_is_the_same_upload_with_the_same_words() {
        let dir = tempfile::tempdir().unwrap();
        let mut uploads = Uploads::new(dir.path());
        let send = |uploads: &mut Uploads, upload: &str, text: &str, id: Option<&str>| {
            let mut msg = chunk(upload, 0, 1, "eA==", text);
            msg.input_id = id.map(str::to_string);
            one(uploads.chunk(msg)).outcome
        };
        // With an id the engine decides, once the file reached the session:
        // here it is saved each time.
        assert!(matches!(send(&mut uploads, "u1", "hi", Some("f1")), FileOutcome::Ready(_)));
        assert!(matches!(send(&mut uploads, "u1", "hi", Some("f1")), FileOutcome::Ready(_)));
        assert!(matches!(send(&mut uploads, "u4", "hi", None), FileOutcome::Ready(_)));
        assert_eq!(send(&mut uploads, "u4", "hi", None), FileOutcome::AlreadyDelivered);
        assert!(matches!(send(&mut uploads, "u4", "another question", None), FileOutcome::Ready(_)));
    }

    #[test]
    fn a_refused_upload_says_why_under_its_id() {
        let dir = tempfile::tempdir().unwrap();
        let mut uploads = Uploads::new(dir.path());
        let settled = one(uploads.chunk(with_id(chunk("u", 3, 2, "AA", ""), "f1")));
        assert_eq!(settled.input_id.as_deref(), Some("f1"));
        assert!(failure(&settled).contains("out of range"));
        assert!(uploads.uploads.is_empty());

        assert!(failure(&one(uploads.chunk(chunk("bad", 0, 1, "not base64!", "")))).contains("base64"));

        // Two of these are over the cap in base64 characters (4/3 of it).
        let big = "A".repeat(MAX_UPLOAD_BYTES * 3 / 4);
        assert!(uploads.chunk(with_id(chunk("big", 0, 3, &big, ""), "f2")).is_empty());
        let settled = one(uploads.chunk(with_id(chunk("big", 1, 3, &big, ""), "f2")));
        assert_eq!(settled.input_id.as_deref(), Some("f2"));
        assert!(failure(&settled).contains("cap"));
        assert!(uploads.uploads.is_empty(), "a refused upload is not kept");
    }

    #[test]
    fn an_upload_that_went_idle_is_dropped_without_an_answer() {
        let dir = tempfile::tempdir().unwrap();
        let mut uploads = Uploads::new(dir.path());
        assert!(uploads.chunk(with_id(chunk("old", 0, 2, "AA", ""), "f1")).is_empty());
        let Some(then) = Instant::now().checked_sub(ASSEMBLY_IDLE) else { return };
        uploads.uploads.get_mut("old").unwrap().last = then;
        // Its retry, under the same id, hears nothing of the old attempt.
        assert!(uploads.chunk(with_id(chunk("new", 0, 2, "AA", ""), "f1")).is_empty());
        assert!(uploads.uploads.contains_key("new") && !uploads.uploads.contains_key("old"));
    }

    #[test]
    fn blossom_urls_are_https_or_http_to_an_onion() {
        for ok in ["https://blossom.example/abc", "https://abcdef.onion/abc", "http://abcdef.onion:3000/abc"] {
            assert!(is_blossom_url(ok), "{ok}");
        }
        for refused in ["http://blossom.example/abc", "http://evil.onion.example.com/abc", "http://.onion/abc", "https:///abc", "ftp://x/abc"] {
            assert!(!is_blossom_url(refused), "{refused}");
        }
    }

    #[test]
    fn a_blob_must_match_its_hash_and_key() {
        let key = [7u8; 32];
        let iv = [9u8; 12];
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let blob = cipher.encrypt(Nonce::from_slice(&iv), b"image bytes".as_ref()).unwrap();
        let hash = hex::encode(Sha256::digest(&blob));
        assert_eq!(decrypt_blob(&blob, &hash, &hex::encode(key), &hex::encode(iv)).unwrap(), b"image bytes");
        assert!(decrypt_blob(&blob, &"0".repeat(64), &hex::encode(key), &hex::encode(iv)).unwrap_err().contains("hash mismatch"));
        assert!(decrypt_blob(&blob, &hash, &hex::encode([1u8; 32]), &hex::encode(iv)).unwrap_err().contains("decryption failed"));
    }

    #[test]
    fn an_image_is_to_be_looked_at_and_any_other_file_is_named() {
        assert_eq!(input_text("  ", Path::new("/w/x.png"), "image/png"), "Please examine this image: /w/x.png");
        assert_eq!(input_text("", Path::new("/w/a.pdf"), "application/pdf"), "Please look at the attached file: /w/a.pdf");
        assert_eq!(input_text("summarise", Path::new("/w/a.pdf"), "application/pdf"), "summarise\n\n[Attached file: /w/a.pdf]");
    }

    #[test]
    fn a_file_keeps_its_own_extension_and_gets_one_only_when_it_has_none() {
        let dir = tempfile::tempdir().unwrap();
        let uploads = Uploads::new(dir.path());
        let name = |filename: &str, mime: &str| {
            uploads.write(filename, mime, b"x").unwrap().file_name().unwrap().to_string_lossy().split_once('-').unwrap().1.to_string()
        };
        assert_eq!(name("report.pdf", "application/pdf"), "report.pdf");
        assert_eq!(name("notes.md", "application/octet-stream"), "notes.md");
        assert_eq!(name("scan", "application/pdf"), "scan.pdf");
        assert_eq!(name("blob", "application/x-unknown"), "blob");
        assert_eq!(name("photo.heic", "image/heic"), "photo.heic");
        assert_eq!(name("..", "text/plain"), "file.txt");
    }
}
