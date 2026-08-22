CodeDeck Next 0.9.4 — Marmot chats can now find the people you want to talk to.

One fix, but it is the difference between a feature that works and one that
looks broken.

**Marmot (MLS) chats reach White Noise and other MDK peers now.** Starting a
Marmot chat needs the other side's published KeyPackage, and Marmot peers put
theirs on Marmot relays — not on the general-purpose relays CodeDeck shipped
with. So "Start Marmot chat" answered *"Peer has no published Marmot
KeyPackage"* for peers whose KeyPackage had been live the whole time, on relays
the app never dialled. Measured against a real peer: zero KeyPackages on the
three relays CodeDeck shipped with, and current ones on both whitenoise relays.

`wss://relay.us.whitenoise.chat` and `wss://relay.eu.whitenoise.chat` are now in
the default relay list, alongside the transport relays. Nothing else changes:
sessions, transcripts and NIP-17 DMs keep running on the relays they already
used, and these two carry only Marmot traffic (they are kind-restricted relays
and simply decline everything else).

If you never touched Settings → Relays, updating adds them for you. If you did
customise your relay list, it is left exactly as you set it — add either relay
by hand to get the same result.
