//! DM image attachments (CDX-011) — the AES-256-GCM blob crypto and the
//! BUD-01/02 Blossom upload/download. Port of the deferred half of
//! `apps/mobile/src/core/dmAttachments.ts`; the wire-format parse/build lives
//! in `client_core::dm_attachments`.
//!
//! The blob on the server is the ciphertext; the key + iv travel only inside
//! the NIP-44/NIP-59 encrypted DM (as the `key=… iv=…` line
//! `client_core::dm_attachments::build_image_ref` emits). HTTP is a port
//! (`HttpFetch`) so the platform binds real networking; tests fake it.

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Key, Nonce};
use client_core::crypto::{bytes_to_hex, hex_to_bytes, Keypair};
use client_core::dm_attachments::{EncryptedImageRef, BLOSSOM_AUTH_KIND, DEFAULT_BLOSSOM_SERVER};
use nostr::{EventBuilder, JsonUtil, Keys, Kind, Tag, Timestamp};
use sha2::{Digest, Sha256};

use crate::deadline::{remaining_budget, StageError};
use crate::ports::LocalBoxFuture;

// --- crypto -------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedImage {
    pub encrypted: Vec<u8>,
    /// AES-256 key, 64 lower-hex.
    pub key_hex: String,
    /// AES-GCM IV, 24 lower-hex (12 bytes).
    pub iv_hex: String,
    /// SHA-256 of the ENCRYPTED payload — the Blossom blob id.
    pub sha256_hex: String,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    bytes_to_hex(&Sha256::digest(bytes))
}

/// AES-256-GCM encrypt raw image bytes with a fresh random key + 12-byte nonce.
/// Output layout (ciphertext ‖ 16-byte tag) matches WebCrypto's `AES-GCM`.
pub fn encrypt_image(raw: &[u8]) -> EncryptedImage {
    let key = Aes256Gcm::generate_key(OsRng);
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let cipher = Aes256Gcm::new(&key);
    let encrypted = cipher
        .encrypt(&nonce, raw)
        .expect("AES-GCM encrypt of an in-memory buffer never fails");
    EncryptedImage {
        sha256_hex: sha256_hex(&encrypted),
        encrypted,
        key_hex: bytes_to_hex(&key),
        iv_hex: bytes_to_hex(&nonce),
    }
}

/// Decrypt a downloaded blob with the key + iv from the message ref.
pub fn decrypt_image(encrypted: &[u8], key_hex: &str, iv_hex: &str) -> Result<Vec<u8>, StageError> {
    let key_bytes = hex_to_bytes(key_hex).map_err(|_| StageError::Failed("bad key hex".into()))?;
    let iv_bytes = hex_to_bytes(iv_hex).map_err(|_| StageError::Failed("bad iv hex".into()))?;
    if key_bytes.len() != 32 || iv_bytes.len() != 12 {
        return Err(StageError::Failed("wrong key/iv length".into()));
    }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    cipher
        .decrypt(Nonce::from_slice(&iv_bytes), encrypted)
        .map_err(|_| StageError::Failed("attachment decrypt failed".into()))
}

// --- HTTP port --------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

/// The Blossom transport seam. Production: `@tauri-apps/plugin-http` / OkHttp.
/// Tests: a closure. Every method may resolve an error string — the caller
/// converts that into a `StageError::Failed`.
pub trait HttpFetch {
    fn put(
        &self,
        url: &str,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    ) -> LocalBoxFuture<'_, Result<HttpResponse, String>>;
    fn get(&self, url: &str) -> LocalBoxFuture<'_, Result<HttpResponse, String>>;
}

/// An [`HttpFetch`] that fails every request — the default before a platform
/// binds real networking (image attachments simply error until then).
pub struct NoHttpFetch;
impl HttpFetch for NoHttpFetch {
    fn put(
        &self,
        _url: &str,
        _headers: Vec<(String, String)>,
        _body: Vec<u8>,
    ) -> LocalBoxFuture<'_, Result<HttpResponse, String>> {
        Box::pin(async { Err("no HTTP transport configured".to_string()) })
    }
    fn get(&self, _url: &str) -> LocalBoxFuture<'_, Result<HttpResponse, String>> {
        Box::pin(async { Err("no HTTP transport configured".to_string()) })
    }
}

// --- upload / download ----------------------------------------------------

/// Generous per attempt (a multi-MB body on mobile data); a false trip costs a
/// retry. The total budget bounds all attempts + backoff together.
pub const BLOSSOM_ATTEMPT_TIMEOUT_MS: u64 = 45_000;
pub const BLOSSOM_TOTAL_BUDGET_MS: u64 = 60_000;
/// Don't start an attempt that cannot plausibly finish.
pub const BLOSSOM_RETRY_FLOOR_MS: u64 = 10_000;
const RETRYABLE_STATUSES: [u16; 5] = [502, 520, 522, 523, 524];
const MAX_RETRIES: u32 = 2;

pub struct UploadOptions<'a> {
    pub server: Option<&'a str>,
    pub now_ms: u64,
    pub budget_ms: u64,
}

impl UploadOptions<'_> {
    pub fn at(now_ms: u64) -> Self {
        Self {
            server: None,
            now_ms,
            budget_ms: BLOSSOM_TOTAL_BUDGET_MS,
        }
    }
}

/// Encrypt + upload one image; returns the ref for
/// `client_core::dm_attachments::build_image_ref`. `Err(StageError)` on
/// definitive failure (the UI shows it and keeps the pending attachment for a
/// retry). The BUD-02 auth event is signed with the phone's own key.
pub async fn upload_encrypted_image(
    raw: &[u8],
    identity: &Keypair,
    fetch: &dyn HttpFetch,
    opts: UploadOptions<'_>,
) -> Result<EncryptedImageRef, StageError> {
    let server = opts
        .server
        .unwrap_or(DEFAULT_BLOSSOM_SERVER)
        .trim_end_matches('/')
        .to_string();
    let enc = encrypt_image(raw);

    let now_sec = opts.now_ms / 1000;
    let keys = Keys::new(identity.secret_key.clone());
    let auth_event = EventBuilder::new(Kind::Custom(BLOSSOM_AUTH_KIND), "Upload encrypted image via CodeDeck")
        .tags([
            Tag::parse(["t".to_string(), "upload".to_string()])
                .map_err(|e| StageError::Failed(e.to_string()))?,
            Tag::parse(["x".to_string(), enc.sha256_hex.clone()])
                .map_err(|e| StageError::Failed(e.to_string()))?,
            Tag::parse(["expiration".to_string(), (now_sec + 300).to_string()])
                .map_err(|e| StageError::Failed(e.to_string()))?,
        ])
        .custom_created_at(Timestamp::from_secs(now_sec))
        .sign_with_keys(&keys)
        .map_err(|e| StageError::Failed(e.to_string()))?;
    let auth_header = format!(
        "Nostr {}",
        base64_std(<nostr::Event as JsonUtil>::as_json(&auth_event).as_bytes())
    );

    let started_at = opts.now_ms;
    let mut last_error = StageError::Failed("Blossom upload failed after retries".into());

    for attempt in 0..=MAX_RETRIES {
        let left = remaining_budget(started_at, opts.budget_ms, opts.now_ms);
        if attempt > 0 && left < BLOSSOM_RETRY_FLOOR_MS {
            break;
        }
        let headers = vec![
            ("Authorization".to_string(), auth_header.clone()),
            (
                "Content-Type".to_string(),
                "application/octet-stream".to_string(),
            ),
        ];
        match fetch
            .put(&format!("{server}/upload"), headers, enc.encrypted.clone())
            .await
        {
            Ok(resp) if (200..300).contains(&resp.status) => {
                return Ok(EncryptedImageRef {
                    url: format!("{server}/{}", enc.sha256_hex),
                    key: enc.key_hex,
                    iv: enc.iv_hex,
                });
            }
            Ok(resp) => {
                last_error = StageError::Failed(format!("Blossom upload failed: {}", resp.status));
                if !RETRYABLE_STATUSES.contains(&resp.status) {
                    return Err(last_error);
                }
            }
            Err(e) => last_error = StageError::Failed(e),
        }
    }
    Err(last_error)
}

/// Download + decrypt an encrypted attachment.
pub async fn download_encrypted_image(
    reference: &EncryptedImageRef,
    fetch: &dyn HttpFetch,
) -> Result<Vec<u8>, StageError> {
    let resp = fetch
        .get(&reference.url)
        .await
        .map_err(StageError::Failed)?;
    if !(200..300).contains(&resp.status) {
        return Err(StageError::Failed(format!("download failed: {}", resp.status)));
    }
    decrypt_image(&resp.body, &reference.key, &reference.iv)
}

/// Standard-alphabet base64 (matches JS `btoa`), no external base64 dep here —
/// `client-core` already carries `base64`, re-export via a tiny shim.
fn base64_std(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use client_core::crypto::generate_keypair;
    use std::cell::RefCell;
    use std::rc::Rc;

    #[test]
    fn aes_gcm_round_trips_and_the_blob_id_hashes_the_ciphertext() {
        let raw = b"\x00\x01\x02\xfa\xfb\xfc some image bytes";
        let enc = encrypt_image(raw);
        assert_eq!(enc.key_hex.len(), 64);
        assert_eq!(enc.iv_hex.len(), 24);
        assert_ne!(enc.encrypted, raw);
        assert_eq!(enc.sha256_hex, sha256_hex(&enc.encrypted));
        assert_eq!(
            decrypt_image(&enc.encrypted, &enc.key_hex, &enc.iv_hex).unwrap(),
            raw
        );
        // wrong key → an error, never a panic
        let bad = "0".repeat(64);
        assert!(decrypt_image(&enc.encrypted, &bad, &enc.iv_hex).is_err());
    }

    type PutCall = (String, Vec<(String, String)>, usize);

    struct FakeFetch {
        calls: Rc<RefCell<Vec<PutCall>>>,
        statuses: RefCell<Vec<u16>>,
        get_body: Vec<u8>,
    }

    impl HttpFetch for FakeFetch {
        fn put(
            &self,
            url: &str,
            headers: Vec<(String, String)>,
            body: Vec<u8>,
        ) -> LocalBoxFuture<'_, Result<HttpResponse, String>> {
            self.calls
                .borrow_mut()
                .push((url.to_string(), headers, body.len()));
            let status = self
                .statuses
                .borrow_mut()
                .pop()
                .unwrap_or(200);
            Box::pin(async move {
                Ok(HttpResponse {
                    status,
                    body: b"{}".to_vec(),
                })
            })
        }
        fn get(&self, _url: &str) -> LocalBoxFuture<'_, Result<HttpResponse, String>> {
            let body = self.get_body.clone();
            Box::pin(async move { Ok(HttpResponse { status: 200, body }) })
        }
    }

    #[tokio::test]
    async fn upload_puts_the_ciphertext_with_a_bud02_auth_header_and_returns_a_ref() {
        let phone = generate_keypair();
        let raw = b"cat.png bytes";
        let calls = Rc::new(RefCell::new(Vec::new()));
        let fetch = FakeFetch {
            calls: Rc::clone(&calls),
            statuses: RefCell::new(vec![200]),
            get_body: vec![],
        };

        let mut opts = UploadOptions::at(1_700_000_000_000);
        opts.server = Some("https://blossom.example/");
        let reference = upload_encrypted_image(raw, &phone, &fetch, opts)
            .await
            .unwrap();

        let (url, headers, body_len) = calls.borrow()[0].clone();
        assert_eq!(url, "https://blossom.example/upload");
        assert!(body_len > raw.len()); // ciphertext + 16-byte tag
        let auth = headers
            .iter()
            .find(|(k, _)| k == "Authorization")
            .map(|(_, v)| v.clone())
            .unwrap();
        assert!(auth.starts_with("Nostr "));
        // the ref points at server/<blobhash> and carries usable key+iv
        assert!(reference.url.starts_with("https://blossom.example/"));
        assert_eq!(reference.key.len(), 64);

        // download round-trips: feed the ciphertext back
        let enc = encrypt_image(raw);
        let dl = FakeFetch {
            calls: Rc::new(RefCell::new(Vec::new())),
            statuses: RefCell::new(vec![]),
            get_body: enc.encrypted.clone(),
        };
        let got = download_encrypted_image(
            &EncryptedImageRef {
                url: "https://blossom.example/x".into(),
                key: enc.key_hex,
                iv: enc.iv_hex,
            },
            &dl,
        )
        .await
        .unwrap();
        assert_eq!(got, raw);
    }

    #[tokio::test]
    async fn upload_retries_a_502_then_gives_up_on_a_403() {
        let phone = generate_keypair();
        let calls = Rc::new(RefCell::new(Vec::new()));
        // popped from the end: first 502, then 200
        let fetch = FakeFetch {
            calls: Rc::clone(&calls),
            statuses: RefCell::new(vec![200, 502]),
            get_body: vec![],
        };
        let r = upload_encrypted_image(b"x", &phone, &fetch, UploadOptions::at(0)).await;
        assert!(r.is_ok());
        assert_eq!(calls.borrow().len(), 2);

        let fetch = FakeFetch {
            calls: Rc::new(RefCell::new(Vec::new())),
            statuses: RefCell::new(vec![403]),
            get_body: vec![],
        };
        let r = upload_encrypted_image(b"x", &phone, &fetch, UploadOptions::at(0)).await;
        assert!(matches!(r, Err(StageError::Failed(m)) if m.contains("403")));
    }
}
