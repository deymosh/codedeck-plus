//! live_text — the replies agents are still writing, one live row per part,
//! kept apart from the transcript: nothing here is stored, numbered or
//! synced, and the entry that completes a part (its `part` naming the row's
//! key) replaces the row.
//!
//! A row only ever grows by the piece that continues it (`offset` = its
//! length). A piece that does not (one was lost) freezes the row as it is
//! until its entry arrives; a piece of a part already completed is a late
//! one and is dropped. The end of the turn drops whatever is left.

use std::collections::{HashMap, HashSet};

use protocol::common::PartialKind;
use protocol::events::PartialMsg;

/// What changed, for the host to show: a row's whole text now, or `None`
/// when the row is gone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveChange {
    pub key: String,
    pub text: Option<String>,
}

#[derive(Debug, Default)]
struct Row {
    key: String,
    text: String,
    /// `text`'s length in UTF-16 code units, the unit offsets count in.
    len: u64,
    frozen: bool,
}

#[derive(Debug, Default)]
struct SessionLive {
    rows: Vec<Row>,
    /// Parts completed this turn: a piece of one arriving late is dropped.
    done: HashSet<String>,
}

/// Live rows by `(machine, session)`.
#[derive(Debug, Default)]
pub struct LiveTextState {
    sessions: HashMap<(String, String), SessionLive>,
}

impl LiveTextState {
    /// A piece arrived. Only a main-agent reply is shown live: reasoning and
    /// a sub-agent's text live inside their tool group.
    pub fn apply(&mut self, machine: &str, msg: &PartialMsg) -> Option<LiveChange> {
        if msg.entry_type != PartialKind::Text || msg.subagent.is_some() {
            return None;
        }
        let live = self.sessions.entry((machine.to_string(), msg.session_id.clone())).or_default();
        if live.done.contains(&msg.key) {
            return None;
        }
        let row = match live.rows.iter().position(|r| r.key == msg.key) {
            Some(i) => &mut live.rows[i],
            None => {
                live.rows.push(Row { key: msg.key.clone(), ..Row::default() });
                live.rows.last_mut().expect("just pushed")
            }
        };
        if row.frozen || msg.offset != row.len {
            row.frozen = true;
            return None;
        }
        row.text.push_str(&msg.text);
        row.len += msg.text.encode_utf16().count() as u64;
        Some(LiveChange { key: row.key.clone(), text: Some(row.text.clone()) })
    }

    /// The entry completing part `key` arrived: its row, if any, goes.
    pub fn complete(&mut self, machine: &str, session_id: &str, key: &str) -> Option<LiveChange> {
        let live = self.sessions.entry((machine.to_string(), session_id.to_string())).or_default();
        live.done.insert(key.to_string());
        let i = live.rows.iter().position(|r| r.key == key)?;
        live.rows.remove(i);
        Some(LiveChange { key: key.to_string(), text: None })
    }

    /// The turn ended (or the session went): every row left goes.
    pub fn end_turn(&mut self, machine: &str, session_id: &str) -> Vec<LiveChange> {
        let Some(live) = self.sessions.remove(&(machine.to_string(), session_id.to_string())) else {
            return Vec::new();
        };
        live.rows.into_iter().map(|r| LiveChange { key: r.key, text: None }).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::common::Subagent;

    fn piece(key: &str, offset: u64, text: &str) -> PartialMsg {
        PartialMsg {
            session_id: "s".into(),
            key: key.into(),
            entry_type: PartialKind::Text,
            subagent: None,
            offset,
            text: text.into(),
        }
    }

    fn shown(c: Option<LiveChange>) -> Option<String> {
        c.and_then(|c| c.text)
    }

    #[test]
    fn a_row_grows_by_the_pieces_that_continue_it() {
        let mut s = LiveTextState::default();
        assert_eq!(shown(s.apply("m", &piece("k", 0, "Hé 🎉"))).as_deref(), Some("Hé 🎉"));
        assert_eq!(shown(s.apply("m", &piece("k", 5, "!"))).as_deref(), Some("Hé 🎉!"));
    }

    #[test]
    fn a_gap_freezes_the_row_until_its_entry() {
        let mut s = LiveTextState::default();
        s.apply("m", &piece("k", 0, "abc"));
        assert_eq!(s.apply("m", &piece("k", 9, "lost")), None);
        assert_eq!(s.apply("m", &piece("k", 3, "def")), None, "a frozen row stays frozen");
        assert_eq!(s.complete("m", "s", "k"), Some(LiveChange { key: "k".into(), text: None }));
    }

    #[test]
    fn a_late_piece_of_a_completed_part_is_dropped_until_the_turn_ends() {
        let mut s = LiveTextState::default();
        s.apply("m", &piece("k", 0, "abc"));
        s.complete("m", "s", "k");
        assert_eq!(s.apply("m", &piece("k", 3, "d")), None);
        assert_eq!(s.end_turn("m", "s"), vec![]);
        assert!(s.apply("m", &piece("k", 0, "new turn")).is_some());
    }

    #[test]
    fn the_turn_end_drops_every_row_left() {
        let mut s = LiveTextState::default();
        s.apply("m", &piece("a", 0, "x"));
        s.apply("m", &piece("b", 0, "y"));
        let gone: Vec<_> = s.end_turn("m", "s").into_iter().map(|c| (c.key, c.text)).collect();
        assert_eq!(gone, vec![("a".into(), None), ("b".into(), None)]);
    }

    #[test]
    fn reasoning_and_a_sub_agents_text_are_not_shown_live() {
        let mut s = LiveTextState::default();
        let mut thinking = piece("t", 0, "hmm");
        thinking.entry_type = PartialKind::Thinking;
        assert_eq!(s.apply("m", &thinking), None);
        let mut sub = piece("u", 0, "sub");
        sub.subagent = Some(Subagent { label: None, parent_call_id: Some("c".into()) });
        assert_eq!(s.apply("m", &sub), None);
    }
}
