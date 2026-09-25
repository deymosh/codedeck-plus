//! The driver protocol: how the bridge talks to the agent host.
//!
//! The bridge is Rust; agent SDKs (the Claude Agent SDK, OpenCode's client)
//! are JavaScript. One Node process, the agent host (`packages/agent-host`),
//! holds a driver per agent and multiplexes every session over its
//! stdin/stdout as JSON lines ([`codec`]). Its stderr is log output.
//!
//! The split of responsibilities is what keeps the bridge agent-neutral:
//! - a **driver** owns everything specific to its agent — spawning it,
//!   translating its events into transcript entries, what its modes mean,
//!   when it needs the user's permission, how credentials and provider
//!   profiles reach it;
//! - the **bridge** owns everything the phone sees — sessions, seqs,
//!   transcripts, cards and their timeouts, restarts, persistence.
//!
//! The shape follows the Agent Client Protocol: the bridge sends requests
//! (`start-session`, `prompt`, …), the host streams [`SessionEvent`]s and
//! asks the bridge when it needs the user (`request-permission`,
//! `ask-question`, `request-plan-approval`) or a bridge-implemented tool
//! (`call-host-tool`).
//!
//! These types are the source of truth; the host's TypeScript types are
//! generated from them by `tests/gen_ts_bindings.rs`.

pub mod codec;
pub mod messages;
mod secret;

pub use codec::{
    decode_bridge_frame, decode_host_frame, encode_frame, FrameError, DRIVER_PROTOCOL_VERSION,
    MAX_LINE_BYTES,
};
pub use messages::*;
pub use secret::Secret;

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::common::{EntryBody, OutputEntry, PermissionOptionKind, Role, SessionOption, ToolKind};
    use serde_json::{json, Value};

    fn bridge_rt(v: Value) -> BridgeFrame {
        let f = decode_bridge_frame(&v.to_string()).unwrap_or_else(|e| panic!("{v} -> {e}"));
        assert_eq!(serde_json::from_str::<Value>(&encode_frame(&f)).unwrap(), v, "exact wire shape");
        f
    }

    fn host_rt(v: Value) -> HostFrame {
        let f = decode_host_frame(&v.to_string()).unwrap_or_else(|e| panic!("{v} -> {e}"));
        assert_eq!(serde_json::from_str::<Value>(&encode_frame(&f)).unwrap(), v, "exact wire shape");
        f
    }

    #[test]
    fn every_bridge_message_round_trips_its_wire_shape() {
        bridge_rt(json!({"v":1,"id":"1","kind":"initialize","payload":{"bridgeVersion":"11.0.0"}}));
        let start = bridge_rt(json!({"v":1,"id":"2","kind":"start-session","payload":{
            "sessionId":"s1","agent":"claude-code","cwd":"/w","mode":"plan","effort":"high","model":"m",
            "resume":"native-1","credentials":{"anthropic_api_key":"sk"},"env":{"GITHUB_TOKEN":"gh"},
            "provider":{"id":"p","baseUrl":"https://x","authToken":"t","models":[{"id":"k"}],"defaultModel":"k"},
            "hostTools":[{"name":"list","description":"List devices","inputSchema":{"type":"object"}}],
            "denySecretPaths":true
        }}));
        let BridgeMessage::StartSession(s) = start.message else { panic!("start-session") };
        assert_eq!(s.credentials["anthropic_api_key"].expose(), "sk");
        bridge_rt(json!({"v":1,"id":"3","kind":"start-session","payload":{"sessionId":"s","agent":"fake","cwd":"/"}}));
        bridge_rt(json!({"v":1,"id":"4","kind":"end-session","payload":{"sessionId":"s"}}));
        bridge_rt(json!({"v":1,"id":"5","kind":"prompt","payload":{"sessionId":"s","text":"hi"}}));
        bridge_rt(json!({"v":1,"id":"6","kind":"interrupt","payload":{"sessionId":"s"}}));
        let set = bridge_rt(json!({"v":1,"id":"7","kind":"set-option","payload":{"sessionId":"s","option":"effort","value":"max"}}));
        assert!(matches!(set.message, BridgeMessage::SetOption { option: SessionOption::Effort, .. }));
        bridge_rt(json!({"v":1,"id":"8","kind":"list-models","payload":{"agent":"opencode"}}));
        bridge_rt(json!({"v":1,"id":"9","kind":"get-usage","payload":{"sessionId":"s"}}));
        bridge_rt(json!({"v":1,"id":"10","kind":"check-credential","payload":{"agent":"claude-code","credential":"anthropic_api_key","value":"sk"}}));
        bridge_rt(json!({"v":1,"id":"h1","kind":"permission-outcome","payload":{"outcome":"selected","optionId":"allow"}}));
        bridge_rt(json!({"v":1,"id":"h2","kind":"plan-outcome","payload":{"outcome":"cancelled","reason":"Timed out"}}));
        bridge_rt(json!({"v":1,"id":"h3","kind":"question-outcome","payload":{"outcome":"answered","answers":["Red","a, b"]}}));
        bridge_rt(json!({"v":1,"id":"h4","kind":"host-tool-result","payload":{"text":"no device","isError":true}}));
    }

    #[test]
    fn every_host_message_round_trips_its_wire_shape() {
        host_rt(json!({"v":1,"id":"1","kind":"initialized","payload":{"hostVersion":"1","agents":[{
            "id":"claude-code","displayName":"Claude Code",
            "modes":[{"id":"plan","label":"Plan"}],"efforts":[],"defaultMode":"default",
            "supports":{"models":true,"usage":true,"providers":true,"gsd":true,"interrupt":true},
            "credentials":[{"id":"anthropic_api_key","label":"Anthropic API key","envVar":"ANTHROPIC_API_KEY"}]
        },{
            "id":"opencode","displayName":"OpenCode","modes":[],"efforts":[],
            "supports":{"models":false,"usage":false,"providers":false,"gsd":false,"interrupt":true},
            "credentials":[],"unavailableReason":"opencode is not installed"
        }]}}));
        host_rt(json!({"v":1,"id":"2","kind":"ack"}));
        host_rt(json!({"v":1,"id":"3","kind":"error","payload":{"message":"no such agent"}}));
        host_rt(json!({"v":1,"id":"4","kind":"models","payload":{"models":[{"id":"m","label":"M"}],"defaultModel":"m"}}));
        host_rt(json!({"v":1,"id":"5","kind":"usage","payload":{}}));
        host_rt(json!({"v":1,"id":"6","kind":"usage","payload":{"usage":{"available":true,"windows":[{"label":"5h","utilization":12.5,"resetsAt":null}],"fetchedAt":"t"}}}));
        host_rt(json!({"v":1,"id":"7","kind":"credential-checked","payload":{"valid":false}}));
        host_rt(json!({"v":1,"id":"8","kind":"credential-checked","payload":{}}));
        host_rt(json!({"v":1,"kind":"session-event","payload":{"sessionId":"s","event":{"type":"ready"}}}));
        host_rt(json!({"v":1,"kind":"session-event","payload":{"sessionId":"s","event":{
            "type":"info","nativeSessionId":"n","model":"m","mode":"plan","contextWindow":1000000,"contextPercentage":12.0}}}));
        host_rt(json!({"v":1,"kind":"session-event","payload":{"sessionId":"s","event":{"type":"info","mode":"default"}}}));
        let entries = host_rt(json!({"v":1,"kind":"session-event","payload":{"sessionId":"s","event":{"type":"entries","entries":[
            {"timestamp":"t","entryType":"text","role":"agent","text":"hello"},
            {"timestamp":"t","entryType":"turn_complete"}
        ]}}}));
        let HostMessage::SessionEvent { event: SessionEvent::Entries { entries }, .. } = entries.message else {
            panic!("entries")
        };
        assert_eq!(
            entries[0],
            OutputEntry::new("t", EntryBody::Text { role: Role::Agent, text: "hello".into(), collapsible: false })
        );
        host_rt(json!({"v":1,"kind":"session-event","payload":{"sessionId":"s","event":{"type":"turn","state":"running"}}}));
        host_rt(json!({"v":1,"kind":"session-event","payload":{"sessionId":"s","event":{"type":"ended"}}}));
        host_rt(json!({"v":1,"kind":"session-event","payload":{"sessionId":"s","event":{"type":"ended","error":"exit 1","resumeLost":true}}}));
        let perm = host_rt(json!({"v":1,"id":"h1","kind":"request-permission","payload":{
            "sessionId":"s","requestId":"toolu_1","toolName":"Bash","kind":"execute","title":"rm -rf build",
            "description":"clean","locations":["/w/build"],"rawInput":{"command":"rm -rf build"},
            "options":[{"id":"allow","label":"Allow","kind":"allow_once"},{"id":"deny","label":"Deny","kind":"reject_once"}],
            "subagent":{"label":"Plan"}
        }}));
        let HostMessage::RequestPermission(p) = perm.message else { panic!("request-permission") };
        assert_eq!(p.kind, ToolKind::Execute);
        assert_eq!(p.options[0].kind, PermissionOptionKind::AllowOnce);
        host_rt(json!({"v":1,"id":"h2","kind":"ask-question","payload":{"sessionId":"s","requestId":"q","questions":[
            {"header":"Color","question":"Which?","options":[{"label":"Red"}],"multiSelect":true},
            {"question":"Why?","options":[]}
        ]}}));
        host_rt(json!({"v":1,"id":"h3","kind":"request-plan-approval","payload":{"sessionId":"s","requestId":"p","options":[{"id":"default","label":"Approve"}]}}));
        host_rt(json!({"v":1,"id":"h4","kind":"call-host-tool","payload":{"sessionId":"s","tool":"logcat","args":{"serial":"x","lines":20}}}));
    }

    #[test]
    fn replies_are_told_apart_from_requests() {
        assert!(HostMessage::Ack.is_reply());
        assert!(!HostMessage::SessionEvent { session_id: "s".into(), event: SessionEvent::Ready {} }.is_reply());
        assert!(BridgeMessage::HostToolResult { text: String::new(), is_error: false }.is_reply());
        assert!(!BridgeMessage::Interrupt { session_id: "s".into() }.is_reply());
    }

    #[test]
    fn a_frame_from_another_version_is_refused_before_its_body() {
        let err = decode_host_frame(r#"{"v":2,"kind":"teleport","payload":{}}"#).unwrap_err();
        assert_eq!(err, FrameError::Version(2));
    }

    #[test]
    fn malformed_and_unknown_frames_are_errors_not_panics() {
        for line in [
            "",
            "not json",
            "[]",
            r#"{"kind":"ack","payload":{}}"#,
            r#"{"v":1,"kind":"teleport","payload":{}}"#,
            r#"{"v":1,"kind":"ack","payload":{"x":1}}"#,
            r#"{"v":1,"kind":"session-event","payload":{"sessionId":"s","event":{"type":"exploded"}}}"#,
            r#"{"v":1,"kind":"request-permission","payload":{"sessionId":"s","requestId":"r","toolName":"X","kind":"teleport","title":"","options":[]}}"#,
        ] {
            assert!(matches!(decode_host_frame(line), Err(FrameError::Malformed(_))), "{line}");
        }
    }

    #[test]
    fn an_oversized_line_is_refused_unparsed() {
        let line = format!(r#"{{"v":1,"kind":"error","payload":{{"message":"{}"}}}}"#, "x".repeat(MAX_LINE_BYTES));
        assert!(matches!(decode_host_frame(&line), Err(FrameError::TooLong(_))));
    }

    #[test]
    fn a_trailing_newline_is_accepted_and_encoding_never_emits_one() {
        let f = Frame::notification(HostMessage::SessionEvent {
            session_id: "s".into(),
            event: SessionEvent::Entries {
                entries: vec![OutputEntry::new(
                    "t",
                    EntryBody::Text { role: Role::Agent, text: "two\nlines".into(), collapsible: false },
                )],
            },
        });
        let line = encode_frame(&f);
        assert!(!line.contains('\n'));
        assert_eq!(decode_host_frame(&format!("{line}\r\n")).unwrap(), f);
    }

    #[test]
    fn logging_a_start_session_never_prints_its_secrets() {
        let f = decode_bridge_frame(
            &json!({"v":1,"id":"1","kind":"start-session","payload":{
                "sessionId":"s","agent":"claude-code","cwd":"/w",
                "credentials":{"anthropic_api_key":"sk-ant-SECRET"},"env":{"GITHUB_TOKEN":"ghp_SECRET"},
                "provider":{"id":"p","baseUrl":"https://x","authToken":"tok-SECRET","models":[]}
            }})
            .to_string(),
        )
        .unwrap();
        assert!(!format!("{f:?}").contains("SECRET"));
    }
}
