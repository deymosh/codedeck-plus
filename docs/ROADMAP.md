# Roadmap

Work that is decided but not built yet, with enough of the design to start
from. Which agents to add next is in
[`AGENT-CANDIDATES.md`](AGENT-CANDIDATES.md).

## Live text while the agent writes

Today a reply or a model's reasoning reaches the phone when it is complete:
for a long answer that is seconds of a turn that looks idle. The aim is to
see it as it is written — in a few updates a second, not one event per
token: every event is signed, encrypted and, over Tor, a relay round trip.

**Where the text comes from.** Claude Code streams when its query is opened
with `includePartialMessages` (`stream_event` messages carrying text and
thinking deltas; today the adapter drops them). OpenCode sends
`message.part.delta` events and partial `message.part.updated` parts (today
only a part with `time.end` is emitted). The DeepSeek Harness hands its reply
over whole, so it has nothing to stream.

**Shape across the layers.**

- Driver protocol: a session event `partial {key, entryType: text |
  thinking, subagent?, offset, text}` — `key` names the part (the SDK's
  block or part id), `text` the characters from `offset` on. The driver
  coalesces deltas and sends at most every ~250 ms per part.
- Bridge: a `partial` is neither stored nor numbered. It goes out as an
  ephemeral (24515) `partial {sessionId, key, entryType, offset, text}`,
  throttled again per session.
  The final `text` / `thinking` entry still arrives as today, with its seq.
- Phone (client core): one live row per part, outside the transcript store.
  An update applies when its `offset` is the row's length; a gap (a dropped
  ephemeral event) freezes the row until the final entry. The final entry
  with the same `key` replaces the live row; the end of a turn clears any
  left over.
- Android: the live row renders where the final row will, so nothing jumps
  when it is replaced; Markdown is rendered as it grows, off the main thread.

**Open questions.** How relays rate-limit a burst of ephemeral events (the
phone has no backoff for that yet); whether the direct link should skip the
throttle; how a phone that reconnects mid-part picks the row up (likely
waits for the final entry); the battery cost of a phone receiving them with
the screen off.

No capability is needed: bridge and app update together, and an agent with
nothing to stream simply sends no `partial`.
