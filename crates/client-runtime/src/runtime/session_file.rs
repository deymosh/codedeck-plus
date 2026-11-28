//! Sending a file into a session: the upload runs as its own task
//! ([`FileSendCtx`]), off the loop.

use std::cell::Cell;
use std::rc::Rc;
use std::time::Duration;

use nostr_transport::{PublishResult, PublishVerdict};
use protocol::commands::PhoneToBridge;
use tokio::sync::oneshot;

use super::{egress_detail, Clock, CoreEvent, CoreObserver, Entropy, Loop};
use crate::intent::SessionFileSend;
use crate::signer::{Cipher, IdentitySigner};
use crate::transport::ws::{WsTransport, PUBLISH_CONFIRM_ATTEMPTS, PUBLISH_CONFIRM_BUDGET};

impl Loop {
    /// The ports an image send needs, cloned out of the loop so the send can
    /// run as its own task.
    fn image_send_ctx(&self, machine: &str) -> FileSendCtx {
        FileSendCtx {
            signer: Rc::clone(&self.signer),
            cipher: self.cipher_for(machine),
            relays: self.stores.relays_for(machine),
            http: Rc::clone(&self.http),
            ws: self.ws.clone(),
            clock: Rc::clone(&self.clock),
            entropy: Rc::clone(&self.entropy),
            observer: Rc::clone(&self.observer),
            blossom_server: Some(self.stores.settings.data.blossom_server.trim().to_string()).filter(|s| !s.is_empty()),
        }
    }

    /// Runs [`FileSendCtx::send_session_file`] as its own task and answers
    /// `reply` when it finishes. An upload can take minutes (Blossom retries,
    /// then a paced chunk fallback); on the loop it would hold up relay
    /// events, reconnects and every view query for that long.
    pub(super) fn spawn_session_file(&self, send: SessionFileSend, reply: Option<oneshot::Sender<()>>) {
        let ctx = self.image_send_ctx(&send.machine);
        let (sends, id) = (Rc::clone(&self.file_sends), send.input_id.clone());
        let answered = Rc::new(Cell::new(false));
        sends.borrow_mut().insert(id.clone(), Rc::clone(&answered));
        tokio::task::spawn_local(async move {
            ctx.send_session_file(send, &answered).await;
            // Only this send's entry: a retry under the same id may have
            // replaced it meanwhile.
            let mut sends = sends.borrow_mut();
            if sends.get(&id).is_some_and(|a| Rc::ptr_eq(a, &answered)) {
                sends.remove(&id);
            }
            drop(sends);
            if let Some(reply) = reply {
                let _ = reply.send(());
            }
        });
    }
}

/// The ports an image send needs, cloned out of the loop so the send runs
/// as its own task (see `Loop::spawn_session_file`). It never touches the
/// stores: everything it reports goes through the observer.
struct FileSendCtx {
    signer: Rc<dyn IdentitySigner>,
    /// The machine's payload cipher, decided when the send started.
    cipher: Cipher,
    /// The machine's relays (see `CoreStores::relays_for`).
    relays: Vec<String>,
    http: Rc<dyn crate::attachments::HttpFetch>,
    ws: WsTransport,
    clock: Rc<dyn Clock>,
    entropy: Rc<dyn Entropy>,
    observer: Rc<dyn CoreObserver>,
    /// The Blossom server the user chose, if any.
    blossom_server: Option<String>,
}

impl FileSendCtx {
    /// Build + sign + publish one command inline (unlike [`Loop::publish_command`],
    /// which is fire-and-forget off the loop) so a caller can branch on the
    /// verdict — the session-image upload needs that to decide Blossom vs.
    /// chunk fallback.
    async fn publish_and_confirm(
        &self,
        machine: &str,
        msg: PhoneToBridge,
        budget: Duration,
        attempts: u32,
    ) -> PublishResult {
        let now = self.clock.now_ms();
        match crate::signer::build_command(self.signer.as_ref(), &self.cipher, machine, &msg, now).await {
            Ok(event) => self.ws.publish_confirmed_to(&event, &self.relays, budget, attempts).await,
            Err(err) => PublishResult {
                verdict: PublishVerdict::Rejected,
                detail: Some(egress_detail(&err)),
            },
        }
    }

    /// A session attachment, through the user's Blossom server when one is
    /// set, else (or when it fails) through the relays in chunks. Two
    /// INDEPENDENT stages:
    /// stage 1 puts the bytes somewhere durable, stage 2 tells the bridge
    /// where they are. Only a stage-1 failure reaches the chunk fallback — once
    /// the bridge is told a URL, the bytes are already on the server, so a
    /// stage-2 rejection is a hard failure, never a reason to re-upload
    /// megabytes over the relays. No optimistic local echo: the image lands in
    /// the transcript only once the bridge injects it, like any other output.
    ///
    /// Done here means sent: whether the file arrived is the bridge's answer
    /// under `input_id` (`CoreEvent::FileSettled`). A send that fails on the
    /// phone settles it as `unsent` itself, and the bridge's answer to a
    /// piece already sent ends the chunk loop early.
    async fn send_session_file(&self, send: SessionFileSend, answered: &Cell<bool>) {
        let SessionFileSend { machine, session_id, text, data, filename, mime_type, input_id } = send;
        use client_core::image_chunks::{chunk_base64, IMAGE_CHUNK_BYTES, IMAGE_CHUNK_DELAY_MS};
        use protocol::commands::{
            UploadFileBlossomMsg, UploadFileChunkMsg, UploadFileMsg,
        };

        /// Overall wall clock for the whole send, all stages together.
        const SESSION_IMAGE_SEND_BUDGET_MS: u64 = 120_000;
        /// Budget for the chunk fallback, from the first chunk. Deliberately
        /// under the bridge's 60 s chunk-assembly window (armed on the first
        /// chunk) — past that point every further chunk is guaranteed waste,
        /// the tracker is already gone. PAIRED CONSTANT with the bridge side.
        const CHUNK_ASSEMBLY_BUDGET_MS: u64 = 55_000;
        use crate::attachments::MAX_FALLBACK_CHUNKS;

        let started_at = self.clock.now_ms();
        let size_bytes = data.len() as u64;

        // The file did not leave the phone: it settles here, as the bridge
        // would settle one it could not take.
        let fail = |this: &Self| {
            this.observer.on_event(CoreEvent::FileSettled {
                id: input_id.clone(),
                reason: Some("unsent".into()),
                detail: None,
            });
        };

        // --- Stage 1: the bytes, on the user's server when they chose one ---
        let uploaded = match self.blossom_server.as_deref() {
            Some(server) => {
                let opts = crate::attachments::UploadOptions::at(server, started_at);
                Some(crate::attachments::upload_encrypted_blob(&data, self.signer.as_ref(), self.http.as_ref(), opts).await)
            }
            None => None,
        };

        if let Some(Ok(reference)) = uploaded {
            // --- Stage 2: the reference ---
            let hash = client_core::image_chunks::blossom_hash_from_url(&reference.url).to_string();
            let msg = PhoneToBridge::UploadFile(UploadFileMsg::Blossom(UploadFileBlossomMsg {
                session_id,
                hash,
                url: reference.url,
                key: reference.key,
                iv: reference.iv,
                filename,
                mime_type,
                text,
                size_bytes,
                input_id: Some(input_id.clone()),
            }));
            let result = self
                .publish_and_confirm(&machine, msg, PUBLISH_CONFIRM_BUDGET, PUBLISH_CONFIRM_ATTEMPTS)
                .await;
            if !matches!(result.verdict, PublishVerdict::Accepted | PublishVerdict::Unconfirmed) {
                fail(self);
            }
            return;
        }

        // --- Stage 3: chunk fallback (nobody holds the bytes) ---
        use base64::Engine as _;
        let base64_data = base64::engine::general_purpose::STANDARD.encode(&data);
        let chunks = chunk_base64(&base64_data, IMAGE_CHUNK_BYTES);
        if chunks.len() > MAX_FALLBACK_CHUNKS {
            fail(self);
            return;
        }
        let upload_id = format!("{started_at:x}-{:x}", (self.entropy.unit() * 1e9) as u64);
        let total_chunks = chunks.len() as u64;
        let chunks_started_at = self.clock.now_ms();
        for (i, chunk) in chunks.into_iter().enumerate() {
            // Answered already — the session stopped, say: the rest of the
            // file would be refused piece by piece.
            if answered.get() {
                return;
            }
            let now = self.clock.now_ms();
            if now.saturating_sub(chunks_started_at) >= CHUNK_ASSEMBLY_BUDGET_MS
                || now.saturating_sub(started_at) >= SESSION_IMAGE_SEND_BUDGET_MS
            {
                fail(self);
                return;
            }
            let msg = PhoneToBridge::UploadFile(UploadFileMsg::Chunk(UploadFileChunkMsg {
                session_id: session_id.clone(),
                upload_id: upload_id.clone(),
                filename: filename.clone(),
                mime_type: mime_type.clone(),
                base64_data: chunk,
                // Chunk 0 carries the caption; the rest must not repeat it.
                text: if i == 0 { text.clone() } else { String::new() },
                chunk_index: i as u64,
                total_chunks,
                input_id: Some(input_id.clone()),
            }));
            // The TS client sends chunks with a single attempt each — the outer
            // budget disciplines the run, not per-frame retry.
            let result = self
                .publish_and_confirm(&machine, msg, PUBLISH_CONFIRM_BUDGET, 1)
                .await;
            if !matches!(result.verdict, PublishVerdict::Accepted | PublishVerdict::Unconfirmed) {
                fail(self);
                return;
            }
            if (i as u64) + 1 < total_chunks {
                tokio::time::sleep(Duration::from_millis(IMAGE_CHUNK_DELAY_MS)).await;
            }
        }
    }

}
