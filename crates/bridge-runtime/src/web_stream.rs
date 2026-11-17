//! A browser's stream on the web page: the one WebSocket a signed-in browser
//! drives sessions over (`protocol::web` is the spec).
//!
//! The upgrade is let through only for an allowed `Host`, the page's own
//! `Origin` and a cookie naming a signed-in browser (`Web::stream_grant`).
//! Then the browser must prove it holds the key it signed in with: it signs
//! the connection's challenge (`HELLO`), and every frame after that, each
//! with a `seq` above the last. A frame that does not verify closes the
//! stream. A verified command is checked against what a browser may send
//! (`bridge_core::browser_may_send`) and handed to the engine as the
//! identity's that let the browser in; a page request is answered here.
//!
//! What the bridge sends a browser goes through the same lane as a phone's
//! direct link: queued, never waited on, and a browser that stops reading is
//! closed rather than allowed to hold the bridge's one thread.

use std::time::Duration;

use bridge_core::Input;
use futures_util::{SinkExt, StreamExt};
use protocol::web::{closed, decode_web_frame, encode_web_frame, signed_input, WebFrame};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

use crate::web::{StreamGrant, Web};

/// How long a browser has to say `HELLO` once it has its challenge: it
/// signs with a key it already holds, so no prompt stands in the way.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// A stream silent this long is dropped; the page renews its presence well
/// within it.
const IDLE_TIMEOUT: Duration = Duration::from_secs(400);
/// How long the WebSocket handshake may take.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Largest frame accepted from a browser: a command and its signature.
const MAX_FRAME_BYTES: usize = 256 * 1024;

/// Serve a request for the stream whose head is `head` (still unread from
/// `stream`'s point of view: it is replayed to the WebSocket handshake).
/// `slot`: the direct link's hub and the peer, whose per-host connection
/// slot an open stream gives back (see `Hub::release_host_slot`).
pub async fn serve<S: AsyncRead + AsyncWrite + Unpin>(head: Vec<u8>, mut stream: S, web: &Web, slot: Option<(&crate::direct::Hub, std::net::IpAddr)>) {
    let grant = match web.stream_grant(&head) {
        Ok(grant) => grant,
        Err(status) => {
            crate::web::refuse(&mut stream, status).await;
            return;
        }
    };
    let config = WebSocketConfig { max_message_size: Some(MAX_FRAME_BYTES), max_frame_size: Some(MAX_FRAME_BYTES), ..Default::default() };
    let replay = crate::direct::Replay::new(head, stream);
    let Ok(Ok(ws)) = tokio::time::timeout(HANDSHAKE_TIMEOUT, tokio_tungstenite::accept_async_with_config(replay, Some(config))).await
    else {
        return;
    };
    run(ws, grant, web, slot).await;
}

/// The stream once upgraded: the handshake, then frames both ways.
async fn run<W>(ws: W, grant: StreamGrant, web: &Web, slot: Option<(&crate::direct::Hub, std::net::IpAddr)>)
where
    W: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error>
        + Unpin,
{
    let (mut sink, mut source) = ws.split();
    let send = |frame: &WebFrame| Message::Text(encode_web_frame(frame));
    let challenge = base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, rand::random::<[u8; 32]>());
    if sink.send(send(&WebFrame::Challenge(challenge.clone()))).await.is_err() {
        return;
    }
    let verifies = |seq: u64, body: &str, sig: &str| {
        grant.browser_key.verifies(&signed_input(web.machine(), &grant.id, &challenge, seq, body), sig)
    };
    let hello = tokio::time::timeout(HELLO_TIMEOUT, next_text(&mut source)).await.ok().flatten();
    match hello.as_deref().map(decode_web_frame) {
        Some(Ok(WebFrame::Hello { sig })) if verifies(0, "", &sig) => {}
        _ => {
            let _ = sink.send(send(&WebFrame::Closed(closed::BAD_SIGNATURE.into()))).await;
            return;
        }
    }
    if !web.still_signed_in(&grant.key) {
        let _ = sink.send(send(&WebFrame::Closed(closed::EXPIRED.into()))).await;
        return;
    }
    web.seen(&grant.key);
    let Some((n, lane, reason)) = web.open_stream(&grant) else {
        let _ = sink.send(send(&WebFrame::Closed(closed::BUSY.into()))).await;
        return;
    };
    log::info!("[Web] A browser opened its stream");
    // Open and signed: from here the page's own caps bound it.
    if let Some((hub, peer)) = slot {
        hub.release_host_slot(peer);
    }
    let mut last_seq = 0u64;
    let mut ok = sink.send(send(&WebFrame::Ready)).await.is_ok();
    while ok {
        if let Some(text) = lane.pop() {
            ok = sink.send(Message::Text(text)).await.is_ok();
            continue;
        }
        if lane.is_closed() {
            let _ = sink.send(send(&WebFrame::Closed(reason.get().into()))).await;
            break;
        }
        tokio::select! {
            biased;
            () = lane.ready() => {
                if let Some(text) = lane.pop() {
                    ok = sink.send(Message::Text(text)).await.is_ok();
                }
            },
            incoming = tokio::time::timeout(IDLE_TIMEOUT, source.next()) => match incoming {
                Ok(Some(Ok(Message::Text(text)))) => {
                    match handle(&text, &grant, web, &mut last_seq, &verifies).await {
                        Ok(Some(answer)) => ok = sink.send(send(&answer)).await.is_ok(),
                        Ok(None) => {}
                        Err(why) => {
                            let _ = sink.send(send(&WebFrame::Closed(why.into()))).await;
                            ok = false;
                        }
                    }
                }
                Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => ok = sink.flush().await.is_ok(),
                Ok(Some(Ok(Message::Binary(_) | Message::Frame(_)))) => {}
                _ => ok = false,
            },
        }
    }
    web.close_stream(n);
    if let Some((hub, peer)) = slot {
        hub.retake_host_slot(peer);
    }
    log::info!("[Web] A browser closed its stream");
}

/// One frame from the browser: its answer, nothing, or why the stream ends.
async fn handle(
    text: &str,
    grant: &StreamGrant,
    web: &Web,
    last_seq: &mut u64,
    verifies: &impl Fn(u64, &str, &str) -> bool,
) -> Result<Option<WebFrame>, &'static str> {
    let (seq, body, sig, page) = match decode_web_frame(text) {
        Ok(WebFrame::Cmd { seq, body, sig }) => (seq, body, sig, false),
        Ok(WebFrame::Page { seq, body, sig }) => (seq, body, sig, true),
        _ => return Err(closed::BAD_FRAME),
    };
    // A `seq` that does not grow is a replay, however good its signature.
    if seq <= *last_seq || !verifies(seq, &body, &sig) {
        return Err(closed::BAD_SIGNATURE);
    }
    *last_seq = seq;
    if !web.still_signed_in(&grant.key) {
        return Err(closed::EXPIRED);
    }
    web.seen(&grant.key);
    if page {
        let (status, reply, write) = web.page_request(&body, &grant.by);
        let (status, reply) = match write {
            Some(write) => crate::web::write_config_now(write).await,
            None => (status, reply),
        };
        let reply = serde_json::json!({ "status": status, "body": serde_json::from_str::<serde_json::Value>(&reply).unwrap_or_default() });
        return Ok(Some(WebFrame::Reply { seq, reply: reply.to_string() }));
    }
    let msg = match protocol::decode_phone_to_bridge(&body) {
        Ok(msg) => msg,
        Err(err) => return Ok(Some(WebFrame::Ok { seq, accepted: false, message: format!("invalid: {err}") })),
    };
    if !bridge_core::browser_may_send(&msg) {
        return Ok(Some(WebFrame::Ok { seq, accepted: false, message: "not from a browser".into() }));
    }
    let _ = web.inputs().send(Input::WebCommand { id: grant.id.clone(), by: grant.by.clone(), msg: Box::new(msg) });
    Ok(Some(WebFrame::Ok { seq, accepted: true, message: String::new() }))
}

async fn next_text<S>(source: &mut S) -> Option<String>
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        match source.next().await? {
            Ok(Message::Text(text)) => return Some(text),
            Ok(Message::Ping(_) | Message::Pong(_)) => continue,
            _ => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::web::tests::{clock, page, sign_in_with, TestKey, HOST};
    use crate::web::STREAM_PATH;
    use tokio::io::DuplexStream;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::WebSocketStream;

    type Ws = WebSocketStream<DuplexStream>;

    /// Serve one stream request from a browser holding `cookie` at `origin`,
    /// while `client` plays the browser's side; both run to their end.
    async fn with_stream<F, Fut>(web: &Web, cookie: &str, origin: &str, client: F)
    where
        F: FnOnce(Ws) -> Fut,
        Fut: std::future::Future<Output = ()>,
    {
        let (client_io, mut server_io) = tokio::io::duplex(1 << 20);
        let server = async {
            if let Some(head) = crate::web::read_head(&mut server_io).await {
                serve(head, server_io, web, None).await;
            }
        };
        let browser = async {
            let mut request = format!("ws://{HOST}{STREAM_PATH}").into_client_request().unwrap();
            request.headers_mut().insert("Origin", origin.parse().unwrap());
            request.headers_mut().insert("Cookie", format!("__Host-codedeck={cookie}").parse().unwrap());
            if let Ok((ws, _)) = tokio_tungstenite::client_async(request, client_io).await {
                client(ws).await;
            }
        };
        tokio::join!(server, browser);
    }

    async fn recv(ws: &mut Ws) -> WebFrame {
        let text = next_text(ws).await.expect("a frame");
        decode_web_frame(&text).expect("a web frame")
    }

    async fn send(ws: &mut Ws, frame: WebFrame) {
        ws.send(Message::Text(encode_web_frame(&frame))).await.unwrap();
    }

    /// What `key` signs for frame `seq` with `body`, on a connection whose
    /// challenge is `challenge`.
    fn sign(key: &TestKey, challenge: &str, seq: u64, body: &str) -> String {
        key.sign(&signed_input("npub1machine", &key.public.id(), challenge, seq, body))
    }

    /// Read the challenge and say a good `HELLO`; returns the challenge once
    /// the bridge said `READY`.
    async fn hello(ws: &mut Ws, key: &TestKey) -> String {
        let WebFrame::Challenge(challenge) = recv(ws).await else { panic!("a challenge first") };
        send(ws, WebFrame::Hello { sig: sign(key, &challenge, 0, "") }).await;
        assert_eq!(recv(ws).await, WebFrame::Ready);
        challenge
    }

    fn commands(inputs: &mut tokio::sync::mpsc::UnboundedReceiver<Input>) -> Vec<String> {
        std::iter::from_fn(|| inputs.try_recv().ok())
            .filter_map(|input| match input {
                Input::WebCommand { msg, .. } => Some(protocol::encode_phone_to_bridge(&msg).unwrap()),
                _ => None,
            })
            .collect()
    }

    const REFRESH: &str = r#"{"v":12,"type":"refresh-sessions"}"#;

    #[tokio::test(flavor = "current_thread")]
    async fn a_signed_command_reaches_the_engine_and_the_bridge_answers_down_the_stream() {
        let dir = tempfile::tempdir().unwrap();
        let (_, now) = clock();
        let (web, mut inputs) = page(dir.path(), Vec::new(), now);
        let key = TestKey::new(7);
        let cookie = sign_in_with(&web, &mut inputs, &key);
        while inputs.try_recv().is_ok() {}
        let (page_ref, key_ref) = (&web, &key);
        with_stream(&web, &cookie, &format!("https://{HOST}"), |mut ws| async move {
            let (web, key) = (page_ref, key_ref);
            let challenge = hello(&mut ws, key).await;
            send(&mut ws, WebFrame::Cmd { seq: 1, body: REFRESH.into(), sig: sign(key, &challenge, 1, REFRESH) }).await;
            assert_eq!(recv(&mut ws).await, WebFrame::Ok { seq: 1, accepted: true, message: String::new() });
            web.deliver(&key.public.id(), r#"{"v":12,"type":"input-ack","sessionId":"s","inputId":"i"}"#);
            let WebFrame::Msg(message) = recv(&mut ws).await else { panic!("the bridge's message") };
            assert!(message.contains("input-ack"));
        })
        .await;
        let got: Vec<Input> = std::iter::from_fn(|| inputs.try_recv().ok()).collect();
        assert!(matches!(&got[0], Input::WebBrowserOnline { id, by } if *id == key.public.id() && by == "npub1owner"), "{got:?}");
        assert!(matches!(&got[1], Input::WebCommand { id, .. } if *id == key.public.id()), "{got:?}");
        assert!(matches!(&got[2], Input::WebBrowserOffline { .. }), "{got:?}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_hello_by_another_key_is_closed() {
        let dir = tempfile::tempdir().unwrap();
        let (web, mut inputs) = page(dir.path(), Vec::new(), clock().1);
        let cookie = sign_in_with(&web, &mut inputs, &TestKey::new(7));
        while inputs.try_recv().is_ok() {}
        let thief = TestKey::new(8);
        with_stream(&web, &cookie, &format!("https://{HOST}"), |mut ws| async move {
            let WebFrame::Challenge(challenge) = recv(&mut ws).await else { panic!() };
            // The cookie alone, with a key of the thief's own.
            let sig = thief.sign(&signed_input("npub1machine", &TestKey::new(7).public.id(), &challenge, 0, ""));
            send(&mut ws, WebFrame::Hello { sig }).await;
            assert_eq!(recv(&mut ws).await, WebFrame::Closed(closed::BAD_SIGNATURE.into()));
        })
        .await;
        assert!(commands(&mut inputs).is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_replayed_frame_closes_the_stream() {
        let dir = tempfile::tempdir().unwrap();
        let (web, mut inputs) = page(dir.path(), Vec::new(), clock().1);
        let key = TestKey::new(7);
        let cookie = sign_in_with(&web, &mut inputs, &key);
        let origin = format!("https://{HOST}");

        // The same seq twice on one connection.
        let replay_key = TestKey::new(7);
        with_stream(&web, &cookie, &origin, |mut ws| async move {
            let challenge = hello(&mut ws, &replay_key).await;
            let frame = WebFrame::Cmd { seq: 1, body: REFRESH.into(), sig: sign(&replay_key, &challenge, 1, REFRESH) };
            send(&mut ws, frame.clone()).await;
            assert!(matches!(recv(&mut ws).await, WebFrame::Ok { accepted: true, .. }));
            send(&mut ws, frame).await;
            assert_eq!(recv(&mut ws).await, WebFrame::Closed(closed::BAD_SIGNATURE.into()));
        })
        .await;
        assert_eq!(commands(&mut inputs).len(), 1, "the replay ran nothing");

        // A frame signed for an earlier connection's challenge.
        let first = TestKey::new(7);
        let old_challenge = std::cell::RefCell::new(String::new());
        let (slot, first) = (&old_challenge, &first);
        with_stream(&web, &cookie, &origin, |mut ws| async move {
            *slot.borrow_mut() = hello(&mut ws, first).await;
        })
        .await;
        let second = TestKey::new(7);
        let old = old_challenge.borrow().clone();
        with_stream(&web, &cookie, &origin, |mut ws| async move {
            hello(&mut ws, &second).await;
            send(&mut ws, WebFrame::Cmd { seq: 1, body: REFRESH.into(), sig: sign(&second, &old, 1, REFRESH) }).await;
            assert_eq!(recv(&mut ws).await, WebFrame::Closed(closed::BAD_SIGNATURE.into()));
        })
        .await;
        assert!(commands(&mut inputs).is_empty(), "nothing from another connection runs");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_command_a_browser_may_not_send_is_refused_and_a_page_request_answered() {
        let dir = tempfile::tempdir().unwrap();
        let (web, mut inputs) = page(dir.path(), Vec::new(), clock().1);
        let key = TestKey::new(7);
        let cookie = sign_in_with(&web, &mut inputs, &key);
        with_stream(&web, &cookie, &format!("https://{HOST}"), |mut ws| async move {
            let challenge = hello(&mut ws, &key).await;
            let sign_in = r#"{"v":12,"type":"web-sign-in","code":"K7QM-4XPA"}"#;
            send(&mut ws, WebFrame::Cmd { seq: 1, body: sign_in.into(), sig: sign(&key, &challenge, 1, sign_in) }).await;
            assert_eq!(recv(&mut ws).await, WebFrame::Ok { seq: 1, accepted: false, message: "not from a browser".into() });
            let devices = r#"{"type":"devices"}"#;
            send(&mut ws, WebFrame::Page { seq: 2, body: devices.into(), sig: sign(&key, &challenge, 2, devices) }).await;
            let WebFrame::Reply { seq: 2, reply } = recv(&mut ws).await else { panic!("a reply") };
            let reply: serde_json::Value = serde_json::from_str(&reply).unwrap();
            assert_eq!(reply["status"], 200);
            assert!(reply["body"]["devices"].is_array());
        })
        .await;
        assert!(commands(&mut inputs).is_empty(), "the engine never saw the sign-in");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_lapsed_browser_is_closed_at_its_next_frame() {
        let dir = tempfile::tempdir().unwrap();
        let (now, clock) = clock();
        let (web, mut inputs) = page(dir.path(), Vec::new(), clock);
        let key = TestKey::new(7);
        let cookie = sign_in_with(&web, &mut inputs, &key);
        while inputs.try_recv().is_ok() {}
        with_stream(&web, &cookie, &format!("https://{HOST}"), |mut ws| async move {
            let challenge = hello(&mut ws, &key).await;
            now.set(now.get() + crate::web::IDLE_TTL_MS + 1);
            send(&mut ws, WebFrame::Cmd { seq: 1, body: REFRESH.into(), sig: sign(&key, &challenge, 1, REFRESH) }).await;
            assert_eq!(recv(&mut ws).await, WebFrame::Closed(closed::EXPIRED.into()));
        })
        .await;
        assert!(commands(&mut inputs).is_empty());
    }
}
