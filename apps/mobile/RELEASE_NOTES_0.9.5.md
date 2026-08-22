CodeDeck Next 0.9.5 — you can tell your conversations apart again.

**The Messages list was a column of anonymous letter circles.** Every tile in
the sidebar's conversation list showed a coloured circle with one letter and
nothing else — no name, no message preview, no timestamp. Picking the right
chat meant remembering which circle was which, or opening them one at a time.

The text was there the whole time; a stylesheet rule stacked each tile
vertically, centred the avatar over it, and squeezed the row down until the
name and preview were pushed out of the tile and hidden behind the next one.

Tiles are now what they always should have been: avatar on the left, the
person's name and the last message beside it, the time (and unread count) on
the right. Long names truncate cleanly instead of shoving anything off the row,
and a list long enough to scroll now scrolls instead of squashing every tile.

Three smaller improvements came along with it:

- **A peer whose profile has not loaded shows a readable `npub1…` in mono type**
  rather than a bare letter, so an unnamed contact is still identifiable —
  and still tells you at a glance that it is a key, not a display name.
- **Marmot group chats are labelled by the group's own name** (or its member
  count), instead of borrowing a single member's identity. The tile and the
  open chat now always agree on what a conversation is called.
- **The MLS / NIP-17 tag only appears when your list actually mixes both.** On
  a list where every chat is the same kind, five identical tags were just
  taking width away from the names. The chat header still states the protocol.

Nothing about messaging, encryption, sessions or pairing changed — this release
is the conversation list's appearance only.
