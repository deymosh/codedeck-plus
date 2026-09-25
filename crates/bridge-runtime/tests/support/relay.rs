//! A minimal Nostr relay on loopback for end-to-end tests: `REQ` (stored
//! matches, then `EOSE`, then live events), `EVENT` (`OK`, store unless
//! ephemeral, broadcast), `CLOSE`. Filters: kinds, authors, `#p`, since.
//! Enough for the bridge and the phone to find each other; no signature
//! checks (the clients verify what they receive).

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

#[derive(Default)]
struct State {
    events: Vec<Value>,
    /// (connection, subscription id) → filters.
    subs: HashMap<(u64, String), Vec<Value>>,
    conns: HashMap<u64, mpsc::UnboundedSender<String>>,
    next_conn: u64,
}

fn matches(filter: &Value, event: &Value) -> bool {
    let has = |key: &str, value: &Value| filter.get(key).and_then(Value::as_array).is_none_or(|list| list.contains(value));
    if !has("kinds", &event["kind"]) || !has("authors", &event["pubkey"]) {
        return false;
    }
    if let Some(ps) = filter.get("#p").and_then(Value::as_array) {
        let tagged = event["tags"].as_array().into_iter().flatten().any(|t| t[0] == "p" && ps.contains(&t[1]));
        if !tagged {
            return false;
        }
    }
    filter.get("since").and_then(Value::as_i64).is_none_or(|since| event["created_at"].as_i64().unwrap_or(0) >= since)
}

/// Start the relay; its `ws://127.0.0.1:<port>` URL. Runs until the
/// `LocalSet` ends.
pub async fn start() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let state = Rc::new(RefCell::new(State::default()));
    tokio::task::spawn_local(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            let state = Rc::clone(&state);
            tokio::task::spawn_local(async move {
                let Ok(ws) = tokio_tungstenite::accept_async(tcp).await else { return };
                let (mut sink, mut stream) = ws.split();
                let (tx, mut rx) = mpsc::unbounded_channel::<String>();
                let conn = {
                    let mut s = state.borrow_mut();
                    s.next_conn += 1;
                    let id = s.next_conn;
                    s.conns.insert(id, tx.clone());
                    id
                };
                tokio::task::spawn_local(async move {
                    while let Some(text) = rx.recv().await {
                        if sink.send(Message::Text(text)).await.is_err() {
                            break;
                        }
                    }
                });
                while let Some(Ok(msg)) = stream.next().await {
                    let Message::Text(text) = msg else { continue };
                    let Ok(frame) = serde_json::from_str::<Value>(&text) else { continue };
                    handle(&state, conn, &tx, &frame);
                }
                let mut s = state.borrow_mut();
                s.conns.remove(&conn);
                s.subs.retain(|(c, _), _| *c != conn);
            });
        }
    });
    url
}

fn handle(state: &Rc<RefCell<State>>, conn: u64, tx: &mpsc::UnboundedSender<String>, frame: &Value) {
    match frame[0].as_str() {
        Some("REQ") => {
            let id = frame[1].as_str().unwrap_or_default().to_string();
            let filters: Vec<Value> = frame.as_array().map(|a| a[2..].to_vec()).unwrap_or_default();
            let mut s = state.borrow_mut();
            for event in &s.events {
                if filters.iter().any(|f| matches(f, event)) {
                    let _ = tx.send(json!(["EVENT", id, event]).to_string());
                }
            }
            let _ = tx.send(json!(["EOSE", id]).to_string());
            s.subs.insert((conn, id), filters);
        }
        Some("CLOSE") => {
            let id = frame[1].as_str().unwrap_or_default().to_string();
            state.borrow_mut().subs.remove(&(conn, id));
        }
        Some("EVENT") => {
            let event = frame[1].clone();
            let _ = tx.send(json!(["OK", event["id"], true, ""]).to_string());
            let mut s = state.borrow_mut();
            let kind = event["kind"].as_u64().unwrap_or(0);
            if !(20000..30000).contains(&kind) {
                s.events.push(event.clone());
            }
            for ((c, id), filters) in &s.subs {
                if filters.iter().any(|f| matches(f, &event)) {
                    if let Some(out) = s.conns.get(c) {
                        let _ = out.send(json!(["EVENT", id, event]).to_string());
                    }
                }
            }
        }
        _ => {}
    }
}
