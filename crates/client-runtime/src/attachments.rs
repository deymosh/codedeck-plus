//! Session attachments — the AES-256-GCM blob crypto and the BUD-01/02
//! Blossom upload, for any kind of file.
//!
//! The blob on the server is the ciphertext; the key + iv travel only inside
//! the NIP-44 encrypted session command that references it. HTTP is a port
//! (`HttpFetch`) so the platform binds real networking; tests fake it.

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm};
use protocol::crypto::bytes_to_hex;
use nostr::{EventBuilder, JsonUtil, Kind, PublicKey, Tag, Timestamp};
use sha2::{Digest, Sha256};

use client_core::image_chunks::IMAGE_CHUNK_BYTES;

use crate::deadline::{remaining_budget, with_deadline, StageError};
use crate::ports::LocalBoxFuture;
use crate::signer::IdentitySigner;

/// Most relay chunks one send may take when no Blossom server holds the
/// bytes; a longer run could not finish inside the bridge's assembly window.
pub const MAX_FALLBACK_CHUNKS: usize = 200;
/// The most of one file the bridge keeps (its `MAX_UPLOAD_BYTES`).
pub const MAX_BLOSSOM_UPLOAD_BYTES: u64 = 25 * 1024 * 1024;

/// The largest file one send can carry: through a Blossom server, what the
/// bridge keeps; through the relays alone, what fits in
/// [`MAX_FALLBACK_CHUNKS`] base64 chunks.
pub fn max_upload_bytes(blossom: bool) -> u64 {
    if blossom {
        MAX_BLOSSOM_UPLOAD_BYTES
    } else {
        (MAX_FALLBACK_CHUNKS * IMAGE_CHUNK_BYTES) as u64 / 4 * 3
    }
}

/// BUD-02 authorization event kind.
pub const BLOSSOM_AUTH_KIND: u16 = 24242;

/// Where an uploaded file lives and how to decrypt it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedBlobRef {
    pub url: String,
    /// AES-256 key, 64 hex chars (lower-case).
    pub key: String,
    /// AES-GCM IV, 24 hex chars (lower-case).
    pub iv: String,
}

// --- crypto -------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedBlob {
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
pub fn encrypt_blob(raw: &[u8]) -> EncryptedBlob {
    let key = Aes256Gcm::generate_key(OsRng);
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let cipher = Aes256Gcm::new(&key);
    let encrypted = cipher
        .encrypt(&nonce, raw)
        .expect("AES-GCM encrypt of an in-memory buffer never fails");
    EncryptedBlob {
        sha256_hex: sha256_hex(&encrypted),
        encrypted,
        key_hex: bytes_to_hex(&key),
        iv_hex: bytes_to_hex(&nonce),
    }
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
    /// Rebuild the underlying client through the (possibly new) SOCKS5 proxy
    /// — `None` when Tor turns off. Default: no-op (`NoHttpFetch`, test
    /// doubles with nothing to reconfigure).
    fn set_proxy(&self, _proxy: Option<&str>) {}
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
}

// --- upload ----------------------------------------------------

/// Generous per attempt (a multi-MB body on mobile data); a false trip costs a
/// retry. The total budget bounds all attempts + backoff together.
pub const BLOSSOM_ATTEMPT_TIMEOUT_MS: u64 = 45_000;
pub const BLOSSOM_TOTAL_BUDGET_MS: u64 = 60_000;
/// Don't start an attempt that cannot plausibly finish.
pub const BLOSSOM_RETRY_FLOOR_MS: u64 = 10_000;
const RETRYABLE_STATUSES: [u16; 5] = [502, 520, 522, 523, 524];
const MAX_RETRIES: u32 = 2;

/// The server is the one the user chose; there is no built-in one, since the
/// server learns who uploads and when.
pub struct UploadOptions<'a> {
    pub server: &'a str,
    pub now_ms: u64,
    pub budget_ms: u64,
}

impl<'a> UploadOptions<'a> {
    pub fn at(server: &'a str, now_ms: u64) -> Self {
        Self {
            server,
            now_ms,
            budget_ms: BLOSSOM_TOTAL_BUDGET_MS,
        }
    }
}

/// Encrypt + upload one file; returns where it lives and its key + iv.
/// `Err(StageError)` on
/// definitive failure (the UI shows it and keeps the pending attachment for a
/// retry). The BUD-02 auth event is signed by the phone's identity — the
/// pubkey an allowlisting image server knows.
pub async fn upload_encrypted_blob(
    raw: &[u8],
    signer: &dyn IdentitySigner,
    fetch: &dyn HttpFetch,
    opts: UploadOptions<'_>,
) -> Result<EncryptedBlobRef, StageError> {
    let server = opts.server.trim_end_matches('/').to_string();
    let enc = encrypt_blob(raw);

    let now_sec = opts.now_ms / 1000;
    let author_pk = PublicKey::from_hex(&signer.pubkey_hex()).map_err(|e| StageError::Failed(e.to_string()))?;
    let unsigned = EventBuilder::new(Kind::Custom(BLOSSOM_AUTH_KIND), "Upload encrypted image via CodeDeck")
        .tags([
            Tag::parse(["t".to_string(), "upload".to_string()])
                .map_err(|e| StageError::Failed(e.to_string()))?,
            Tag::parse(["x".to_string(), enc.sha256_hex.clone()])
                .map_err(|e| StageError::Failed(e.to_string()))?,
            Tag::parse(["expiration".to_string(), (now_sec + 300).to_string()])
                .map_err(|e| StageError::Failed(e.to_string()))?,
        ])
        .custom_created_at(Timestamp::from_secs(now_sec))
        .build(author_pk);
    let auth_event = crate::signer::sign(signer, unsigned)
        .await
        .map_err(|e| StageError::Failed(format!("sign: {e}")))?;
    let auth_header = format!(
        "Nostr {}",
        base64_std(<nostr::Event as JsonUtil>::as_json(&auth_event).as_bytes())
    );

    // Elapsed time comes from a live monotonic clock. `opts.now_ms` is one
    // snapshot (it dates the auth event); measured against it, elapsed would
    // always read 0 and the total budget would never bound the attempts.
    let started = tokio::time::Instant::now();
    let mut last_error = StageError::Failed("Blossom upload failed after retries".into());

    for attempt in 0..=MAX_RETRIES {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(1000 << (attempt - 1))).await;
        }
        let elapsed = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let left = remaining_budget(0, opts.budget_ms, elapsed);
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
        let put = fetch.put(&format!("{server}/upload"), headers, enc.encrypted.clone());
        let attempt_ms = BLOSSOM_ATTEMPT_TIMEOUT_MS.min(left).max(1);
        let outcome = match with_deadline(put, attempt_ms, "Blossom upload").await {
            Ok(outcome) => outcome,
            Err(timeout) => {
                last_error = timeout;
                continue;
            }
        };
        match outcome {
            Ok(resp) if (200..300).contains(&resp.status) => {
                return Ok(EncryptedBlobRef {
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

/// Standard-alphabet base64 (matches JS `btoa`), no external base64 dep here —
/// `client-core` already carries `base64`, re-export via a tiny shim.
fn base64_std(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::{Key, Nonce};
    use protocol::crypto::{generate_keypair, hex_to_bytes};
    use std::cell::RefCell;
    use std::rc::Rc;

    /// What the bridge does with a downloaded blob: decrypt it with the key +
    /// iv the session command carried.
    fn decrypt_image(encrypted: &[u8], key_hex: &str, iv_hex: &str) -> Result<Vec<u8>, String> {
        let key_bytes = hex_to_bytes(key_hex).map_err(|_| "bad key hex".to_string())?;
        let iv_bytes = hex_to_bytes(iv_hex).map_err(|_| "bad iv hex".to_string())?;
        if key_bytes.len() != 32 || iv_bytes.len() != 12 {
            return Err("wrong key/iv length".into());
        }
        Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes))
            .decrypt(Nonce::from_slice(&iv_bytes), encrypted)
            .map_err(|_| "attachment decrypt failed".to_string())
    }

    #[test]
    fn aes_gcm_round_trips_and_the_blob_id_hashes_the_ciphertext() {
        let raw = b"\x00\x01\x02\xfa\xfb\xfc some image bytes";
        let enc = encrypt_blob(raw);
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
    }

    #[tokio::test]
    async fn upload_puts_the_ciphertext_with_a_bud02_auth_header_and_returns_a_ref() {
        let phone = generate_keypair();
        let raw = b"cat.png bytes";
        let calls = Rc::new(RefCell::new(Vec::new()));
        let fetch = FakeFetch {
            calls: Rc::clone(&calls),
            statuses: RefCell::new(vec![200]),
        };

        let opts = UploadOptions::at("https://blossom.example/", 1_700_000_000_000);
        let reference = upload_encrypted_blob(raw, &crate::signer::LocalSigner(phone), &fetch, opts)
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
        assert_eq!(reference.iv.len(), 24);
    }

    /// A server that accepts the connection and never answers.
    struct HangingFetch {
        calls: Rc<RefCell<u32>>,
    }

    impl HttpFetch for HangingFetch {
        fn put(
            &self,
            _url: &str,
            _headers: Vec<(String, String)>,
            _body: Vec<u8>,
        ) -> LocalBoxFuture<'_, Result<HttpResponse, String>> {
            *self.calls.borrow_mut() += 1;
            Box::pin(std::future::pending())
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_hanging_server_is_bounded_by_the_total_budget() {
        let phone = generate_keypair();
        let calls = Rc::new(RefCell::new(0));
        let fetch = HangingFetch { calls: Rc::clone(&calls) };
        let started = tokio::time::Instant::now();

        let r = upload_encrypted_blob(b"x", &crate::signer::LocalSigner(phone.clone()), &fetch, UploadOptions::at("https://blossom.example", 0)).await;

        assert!(matches!(r, Err(StageError::Timeout { .. })));
        // Attempt 1 hits the 45 s per-attempt cap; attempt 2 gets only what is
        // left of the 60 s budget; attempt 3 would start below the retry floor.
        assert_eq!(*calls.borrow(), 2);
        let elapsed = started.elapsed().as_millis() as u64;
        assert!(elapsed <= BLOSSOM_TOTAL_BUDGET_MS + 3_000, "took {elapsed} ms");
    }

    #[tokio::test(start_paused = true)]
    async fn upload_retries_a_502_then_gives_up_on_a_403() {
        let phone = generate_keypair();
        let calls = Rc::new(RefCell::new(Vec::new()));
        // popped from the end: first 502, then 200
        let fetch = FakeFetch {
            calls: Rc::clone(&calls),
            statuses: RefCell::new(vec![200, 502]),
        };
        let r = upload_encrypted_blob(b"x", &crate::signer::LocalSigner(phone.clone()), &fetch, UploadOptions::at("https://blossom.example", 0)).await;
        assert!(r.is_ok());
        assert_eq!(calls.borrow().len(), 2);

        let fetch = FakeFetch {
            calls: Rc::new(RefCell::new(Vec::new())),
            statuses: RefCell::new(vec![403]),
        };
        let r = upload_encrypted_blob(b"x", &crate::signer::LocalSigner(phone.clone()), &fetch, UploadOptions::at("https://blossom.example", 0)).await;
        assert!(matches!(r, Err(StageError::Failed(m)) if m.contains("403")));
    }
}
