//! `agent_styles` — agents' looks, by the hash a bridge names them with.
//!
//! A bridge advertises an agent's style only by [`AgentStyle::hash`] in its
//! heartbeat; the style itself is asked for once, when a session of that
//! agent is on screen and the hash is not here yet. The cache is content
//! addressed: a hash always names the same style, so one fetched from any
//! bridge serves every bridge that runs the same agent version, and a
//! restart asks for nothing it already has (the runtime persists it).

use std::collections::{BTreeMap, BTreeSet};

use protocol::common::AgentStyle;

#[derive(Debug, Default, Clone, PartialEq)]
pub struct AgentStyles {
    styles: BTreeMap<String, AgentStyle>,
}

impl AgentStyles {
    pub fn get(&self, hash: &str) -> Option<&AgentStyle> {
        self.styles.get(hash)
    }

    pub fn contains(&self, hash: &str) -> bool {
        self.styles.contains_key(hash)
    }

    /// Keeps `style` under `hash` when it really hashes to it: a style that
    /// does not is dropped rather than shown under a name it does not have.
    /// Styles no agent in `named` names any more are let go at the same
    /// time, so the cache holds what the paired bridges run, not every
    /// version ever seen. Returns whether anything changed.
    pub fn insert(&mut self, hash: &str, style: AgentStyle, named: &BTreeSet<String>) -> bool {
        if style.hash() != hash || self.styles.get(hash) == Some(&style) {
            return false;
        }
        self.styles.insert(hash.to_string(), style);
        self.styles.retain(|h, _| h == hash || named.contains(h));
        true
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &AgentStyle)> {
        self.styles.iter()
    }
}

/// The persisted form: the hash → style map as JSON.
pub fn serialize_agent_styles(s: &AgentStyles) -> String {
    serde_json::to_string(&s.styles).unwrap_or_else(|_| "{}".into())
}

/// Never fails: garbage, or a style that no longer hashes to its key (one
/// written by a build whose style had other knobs), is left out and asked
/// for again when needed.
pub fn hydrate_agent_styles(raw: Option<&str>) -> AgentStyles {
    let styles: BTreeMap<String, AgentStyle> = raw.and_then(|r| serde_json::from_str(r).ok()).unwrap_or_default();
    AgentStyles { styles: styles.into_iter().filter(|(h, s)| s.hash() == *h).collect() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn style(accent: &str) -> AgentStyle {
        AgentStyle { accent: Some(accent.into()), ..Default::default() }
    }

    fn named(hashes: &[&str]) -> BTreeSet<String> {
        hashes.iter().map(|h| h.to_string()).collect()
    }

    #[test]
    fn a_style_is_kept_only_under_its_own_hash() {
        let mut c = AgentStyles::default();
        let s = style("#D77757");
        assert!(!c.insert("0000000000000000", s.clone(), &named(&[])), "wrong name");
        assert!(c.insert(&s.hash(), s.clone(), &named(&[])));
        assert!(!c.insert(&s.hash(), s.clone(), &named(&[])), "already there");
        assert_eq!(c.get(&s.hash()), Some(&s));
    }

    #[test]
    fn styles_nobody_names_go_when_a_new_one_comes() {
        let mut c = AgentStyles::default();
        let (old, kept, new) = (style("#000001"), style("#000002"), style("#000003"));
        c.insert(&old.hash(), old.clone(), &named(&[]));
        c.insert(&kept.hash(), kept.clone(), &named(&[&old.hash()]));
        c.insert(&new.hash(), new.clone(), &named(&[&kept.hash()]));
        assert!(!c.contains(&old.hash()));
        assert!(c.contains(&kept.hash()) && c.contains(&new.hash()));
    }

    #[test]
    fn a_restart_keeps_what_still_hashes_right() {
        let mut c = AgentStyles::default();
        let s = style("#5C9CF5");
        c.insert(&s.hash(), s.clone(), &named(&[]));
        let back = hydrate_agent_styles(Some(&serialize_agent_styles(&c)));
        assert_eq!(back, c);

        let stale = format!(r##"{{"0123456789abcdef":{{"accent":"#000000"}},"{}":{{"accent":"#5C9CF5"}}}}"##, s.hash());
        assert_eq!(hydrate_agent_styles(Some(&stale)), c);
        assert_eq!(hydrate_agent_styles(Some("not json")), AgentStyles::default());
        assert_eq!(hydrate_agent_styles(None), AgentStyles::default());
    }
}
