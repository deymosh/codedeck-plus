//! Images a phone sends into a session. Two forms:
//! - Blossom: the phone uploaded an AES-256-GCM-encrypted blob and sends its
//!   URL, sha256, key and iv; the bridge downloads it (https only, size
//!   capped), checks the hash, decrypts it (tag = last 16 bytes);
//! - chunked: the image arrives as base64 pieces, reassembled here; a
//!   partial upload idle for a minute is dropped.
//!
//! Either way the file lands in `<first root>/.codedeck/uploads` — inside
//! the workspace, where the agent can read it — and the session gets a
//! message naming the path. The key and iv are secrets and never logged.

use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine as _;
use protocol::commands::{UploadImageBlossomMsg, UploadImageChunkMsg};
use sha2::{Digest, Sha256};

/// Phone photos are a few MB; the cap keeps a hostile message from making
/// the bridge buffer arbitrarily much.
pub const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const ASSEMBLY_IDLE: Duration = Duration::from_secs(60);
const MAX_OPEN_UPLOADS: usize = 16;
/// The same image with the same words, sent again within this window, is a
/// resend (the phone could not confirm delivery) — not a new message.
const DEDUP_WINDOW: Duration = Duration::from_secs(10 * 60);
const DEDUP_CAP: usize = 200;

/// The session input for a saved image.
pub fn input_text(user_text: &str, path: &Path) -> String {
    let trimmed = user_text.trim();
    let path = path.display();
    if trimmed.is_empty() {
        format!("Please examine this image: {path}")
    } else {
        format!("{trimmed}\n\n[Attached image: {path} — use the Read tool to view it]")
    }
}

/// Download, verify and decrypt a Blossom image.
pub async fn fetch_blossom(http: &reqwest::Client, msg: &UploadImageBlossomMsg) -> Result<Vec<u8>, String> {
    // The URL is phone-supplied: https only, and the body capped regardless
    // of the size the message claims — the bridge is not a general HTTP client.
    if !msg.url.starts_with("https://") {
        return Err("download refused: https required".into());
    }
    if msg.size_bytes as usize > MAX_IMAGE_BYTES {
        return Err(format!("download refused: {} bytes is over the {MAX_IMAGE_BYTES}-byte cap", msg.size_bytes));
    }
    log::info!("[Images] Downloading {} ({} bytes)", msg.url, msg.size_bytes);
    let mut res = http.get(&msg.url).timeout(Duration::from_secs(60)).send().await.map_err(|e| format!("download failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("download failed: HTTP {}", res.status()));
    }
    let mut body = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("download failed: {e}"))? {
        if body.len() + chunk.len() > MAX_IMAGE_BYTES {
            return Err(format!("download refused: the body is over the {MAX_IMAGE_BYTES}-byte cap"));
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
    filename: String,
    mime_type: String,
    text: String,
    total: u64,
    parts: BTreeMap<u64, String>,
    last: Instant,
}

/// Where uploads go, chunk assembly, and the resend guard.
pub struct Images {
    dir: PathBuf,
    uploads: BTreeMap<String, Upload>,
    injected: VecDeque<(String, Instant)>,
}

/// A finished image: which session gets which message.
pub type Delivery = (String, String);

impl Images {
    pub fn new(first_root: &Path) -> Self {
        Self { dir: first_root.join(".codedeck").join("uploads"), uploads: BTreeMap::new(), injected: VecDeque::new() }
    }

    /// Take one chunk; the delivery once every chunk is in.
    pub fn chunk(&mut self, msg: UploadImageChunkMsg) -> Option<Delivery> {
        self.uploads.retain(|id, u| {
            let fresh = u.last.elapsed() < ASSEMBLY_IDLE;
            if !fresh {
                log::warn!("[Images] Upload {id} timed out ({}/{} chunks)", u.parts.len(), u.total);
            }
            fresh
        });
        if msg.total_chunks == 0 || msg.chunk_index >= msg.total_chunks {
            log::warn!("[Images] Chunk {} out of range for upload {} — skipped", msg.chunk_index, msg.upload_id);
            return None;
        }
        if !self.uploads.contains_key(&msg.upload_id) && self.uploads.len() >= MAX_OPEN_UPLOADS {
            log::warn!("[Images] Too many uploads in progress — {} dropped", msg.upload_id);
            return None;
        }
        let upload = self.uploads.entry(msg.upload_id.clone()).or_insert_with(|| Upload {
            session_id: msg.session_id.clone(),
            filename: msg.filename.clone(),
            mime_type: msg.mime_type.clone(),
            text: msg.text.clone(),
            total: msg.total_chunks,
            parts: BTreeMap::new(),
            last: Instant::now(),
        });
        // Idle-based: a slow phone that keeps sending never times out.
        upload.last = Instant::now();
        if msg.chunk_index == 0 && !msg.text.is_empty() {
            upload.text = msg.text.clone();
        }
        let size: usize = upload.parts.values().map(String::len).sum::<usize>() + msg.base64_data.len();
        if size > MAX_IMAGE_BYTES * 4 / 3 + 4 {
            log::warn!("[Images] Upload {} is over the size cap — dropped", msg.upload_id);
            self.uploads.remove(&msg.upload_id);
            return None;
        }
        upload.parts.insert(msg.chunk_index, msg.base64_data);
        if (upload.parts.len() as u64) < upload.total {
            return None;
        }
        let upload = self.uploads.remove(&msg.upload_id).expect("present");
        let joined: String = upload.parts.into_values().collect();
        let data = match base64::engine::general_purpose::STANDARD.decode(joined.as_bytes()) {
            Ok(data) => data,
            Err(err) => {
                log::warn!("[Images] Upload {} is not valid base64: {err}", msg.upload_id);
                return None;
            }
        };
        self.finish(&upload.session_id, &upload.filename, &upload.mime_type, &upload.text, &data, &format!("upload:{}", msg.upload_id))
    }

    /// Save a decoded image and build its delivery (None: write failed, or a
    /// resend of one already delivered).
    pub fn finish(&mut self, session_id: &str, filename: &str, mime: &str, text: &str, data: &[u8], identity: &str) -> Option<Delivery> {
        let key = format!("{session_id}|{identity}|{}", &hex::encode(Sha256::digest(text.as_bytes()))[..16]);
        self.injected.retain(|(_, at)| at.elapsed() < DEDUP_WINDOW);
        if self.injected.iter().any(|(k, _)| *k == key) {
            log::info!("[Images] A resend of an image already delivered to {session_id} — ignored");
            return None;
        }
        let path = match self.write(filename, mime, data) {
            Ok(path) => path,
            Err(err) => {
                log::error!("[Images] Could not save an image: {err}");
                return None;
            }
        };
        log::info!("[Images] Saved {} ({} bytes)", path.display(), data.len());
        self.injected.push_back((key, Instant::now()));
        while self.injected.len() > DEDUP_CAP {
            self.injected.pop_front();
        }
        Some((session_id.to_string(), input_text(text, &path)))
    }

    fn write(&self, filename: &str, mime: &str, data: &[u8]) -> std::io::Result<PathBuf> {
        fs::create_dir_all(&self.dir)?;
        let safe: String = filename.chars().map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' }).collect();
        let ext = if mime == "image/png" { ".png" } else { ".jpg" };
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        let name = if safe.to_lowercase().ends_with(ext) { format!("{stamp}-{safe}") } else { format!("{stamp}-{safe}{ext}") };
        let path = self.dir.join(name);
        fs::write(&path, data)?;
        Ok(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(id: &str, i: u64, n: u64, data: &str, text: &str) -> UploadImageChunkMsg {
        UploadImageChunkMsg {
            version: Default::default(),
            session_id: "s".into(),
            upload_id: id.into(),
            filename: "../photo name.png".into(),
            mime_type: "image/png".into(),
            base64_data: data.into(),
            text: text.into(),
            chunk_index: i,
            total_chunks: n,
        }
    }

    #[test]
    fn chunks_reassemble_in_any_order_into_a_safe_file_name() {
        let dir = tempfile::tempdir().unwrap();
        let mut images = Images::new(dir.path());
        let b64 = base64::engine::general_purpose::STANDARD.encode(b"PNGDATA-123");
        let (a, b) = b64.split_at(6);
        assert!(images.chunk(chunk("u1", 1, 2, b, "")).is_none());
        let (session, text) = images.chunk(chunk("u1", 0, 2, a, "what is this?")).unwrap();
        assert_eq!(session, "s");
        assert!(text.starts_with("what is this?\n\n[Attached image: ") && text.contains("-.._photo_name.png"));
        let path = text.split("image: ").nth(1).unwrap().split(" —").next().unwrap();
        assert!(Path::new(path).starts_with(dir.path().join(".codedeck/uploads")));
        assert_eq!(fs::read(path).unwrap(), b"PNGDATA-123");
    }

    #[test]
    fn a_resend_of_the_same_image_and_words_is_delivered_once() {
        let dir = tempfile::tempdir().unwrap();
        let mut images = Images::new(dir.path());
        assert!(images.finish("s", "a.jpg", "image/jpeg", "hi", b"x", "hash1").is_some());
        assert!(images.finish("s", "a.jpg", "image/jpeg", "hi", b"x", "hash1").is_none());
        assert!(images.finish("s", "a.jpg", "image/jpeg", "another question", b"x", "hash1").is_some());
    }

    #[test]
    fn out_of_range_chunks_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let mut images = Images::new(dir.path());
        assert!(images.chunk(chunk("u", 3, 2, "AA", "")).is_none());
        assert!(images.uploads.is_empty());
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
    fn plain_images_ask_to_be_examined() {
        assert_eq!(input_text("  ", Path::new("/w/x.png")), "Please examine this image: /w/x.png");
    }
}
