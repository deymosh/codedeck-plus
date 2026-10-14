//! Live text: what of a streamed part the bridge passes on to the phones.
//!
//! The driver sends a part's text in pieces (`partial`), each from the offset
//! the last one ended at. The bridge passes on each piece as it comes, minus
//! what the phone must never see: a session-meta comment the agent appends to
//! a reply, which the bridge strips from the stored entry. A part stops at the
//! comment — its completing entry, stripped, replaces the live row anyway.
//! A piece that does not continue the part (one was lost, or came out of
//! order) stops it too: the row stays as it is until the completing entry.

/// The start of the session-meta comment (see [`crate::session::strip_session_meta`]).
const META_OPEN: &str = "<!--";

/// One part being streamed, as far as the bridge passed it on.
#[derive(Debug, Default)]
pub(crate) struct LivePart {
    /// Where the driver's next piece must start (UTF-16 code units).
    expected: u64,
    /// How much of the part the phones have been sent (UTF-16 code units).
    sent: u64,
    /// The tail of what came, held back because it may begin the
    /// session-meta comment.
    held: String,
    /// Nothing more of this part is passed on.
    stopped: bool,
}

impl LivePart {
    /// A piece of the part arrived: `text` from `offset`. Returns what to send
    /// the phones — its offset in what they have, and the text — if anything.
    /// `strip_meta` is set for a reply, whose stored entry has the comment
    /// removed; reasoning is passed on as it is.
    pub fn admit(&mut self, offset: u64, text: &str, strip_meta: bool) -> Option<(u64, String)> {
        if self.stopped {
            return None;
        }
        if offset != self.expected {
            self.stopped = true;
            return None;
        }
        self.expected += utf16_len(text);
        let pending = std::mem::take(&mut self.held) + text;
        let out = if !strip_meta {
            pending
        } else if let Some(at) = pending.find(META_OPEN) {
            self.stopped = true;
            pending[..at].to_string()
        } else {
            let keep = held_tail(&pending);
            self.held = pending[pending.len() - keep..].to_string();
            pending[..pending.len() - keep].to_string()
        };
        if out.is_empty() {
            return None;
        }
        let at = self.sent;
        self.sent += utf16_len(&out);
        Some((at, out))
    }
}

/// How many bytes at the end of `text` could be the start of [`META_OPEN`]:
/// held back until the next piece says whether they are.
fn held_tail(text: &str) -> usize {
    (1..META_OPEN.len())
        .rev()
        .find(|&n| text.ends_with(&META_OPEN[..n]))
        .unwrap_or(0)
}

fn utf16_len(text: &str) -> u64 {
    text.encode_utf16().count() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pieces_pass_on_with_offsets_in_what_the_phone_has() {
        let mut p = LivePart::default();
        assert_eq!(p.admit(0, "Hello ", true), Some((0, "Hello ".into())));
        assert_eq!(p.admit(6, "wörld 🎉", true), Some((6, "wörld 🎉".into())));
        // The emoji is two UTF-16 units: the next piece starts at 14.
        assert_eq!(p.admit(14, "!", true), Some((14, "!".into())));
    }

    #[test]
    fn a_reply_stops_at_the_session_meta_comment_even_split_across_pieces() {
        let mut p = LivePart::default();
        assert_eq!(p.admit(0, "Done. <", true), Some((0, "Done. ".into())));
        assert_eq!(p.admit(7, "!-", true), None);
        assert_eq!(p.admit(9, "- session-meta: {} -->", true), None);
        assert_eq!(p.admit(31, "more", true), None);
    }

    #[test]
    fn a_held_back_lookalike_is_released_by_what_follows() {
        let mut p = LivePart::default();
        assert_eq!(p.admit(0, "a <", true), Some((0, "a ".into())));
        assert_eq!(p.admit(3, "b", true), Some((2, "<b".into())));
    }

    #[test]
    fn reasoning_is_passed_on_whole() {
        let mut p = LivePart::default();
        assert_eq!(p.admit(0, "x <!-- y", false), Some((0, "x <!-- y".into())));
    }

    #[test]
    fn a_piece_that_does_not_continue_the_part_stops_it() {
        let mut p = LivePart::default();
        assert!(p.admit(0, "abc", true).is_some());
        assert_eq!(p.admit(5, "def", true), None);
        assert_eq!(p.admit(3, "def", true), None);
    }
}
