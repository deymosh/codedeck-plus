# The web client

The bridge's web page is a client: a browser drives the bridge's sessions
from it, as the phone does. This page is its design: why it is built the way
it is, what it defends against, and what a browser may do.
[`BRIDGE.md`](BRIDGE.md#web-page) has how to open it;
`crates/protocol/src/web.rs` is the spec of its stream.

## In one paragraph

A browser makes a key of its own when it signs in: a WebCrypto ECDSA P-256
key whose private half the page can use but never read. It sends the public
half with its sign-in request, so the code the phone approves names exactly
one key. After that, every frame the browser sends, on one WebSocket stream,
carries a signature by that key. The 30-day cookie stays, but by itself it
opens nothing beyond the sign-in state. A browser that has signed nothing for
7 days is signed out. While the phone approves, it shows the SHA-256
fingerprint of the bridge's certificate, so the user can check the
browser's certificate warning against it.

## Why not Nostr in the browser

The page is served only on the direct link's `wss://` listener, so a browser
reaches the bridge over TLS and never through a relay. The phone's commands
are Nostr events with NIP-44 payloads because the same events also travel
through relays, and one format means one ingest path. A browser has no
relays, and TLS already encrypts its one hop once the certificate checks
out. So the browser sends the protocol's own JSON messages (`PhoneToBridge`
up, `BridgeToPhone` down) as they are, with no event wrapper and no
encryption of its own.

TLS does not tell the bridge **who** sent a command. A phone command is
signed by the identity key; a cookie is a bearer token, and whoever holds a
copy holds the browser. Prompting an agent is running commands on the
machine, so the browser signs with a key of its own.

## Threat model

What is at stake: commands to agents (code execution on the machine) and
transcripts (code, tool output).

| Threat | What stops it |
| --- | --- |
| Someone on the LAN or VPN | TLS, the `Host` allowlist, the `Origin` check, and the sign-in itself (only a paired phone approves a code) |
| A copied cookie (profile backup, proxy log, devtools export) | Every frame on the stream needs a signature by the browser's key, which cannot be exported. The cookie alone reads only `/api/me` and cannot keep the session alive. |
| Script injected into the page | The strict CSP (no inline script, nothing from another origin, no `eval`): the key can be *used* by any script on the page, so keeping foreign script out is what protects it. Transcripts are rendered as text only (below). |
| An active MITM whose certificate the user accepts | The fingerprint on the phone. A MITM serves its own page and its own key, and the code it shows is bound to that key; only the user comparing the browser's certificate with the phone's pin catches it. |
| A forgotten signed-in browser | The 7-day idle limit, the 30-day limit, and sign-out from the phone or another browser |
| A browser approved by an identity that is later unpaired | Unpairing ends that identity's browsers |
| A pending sign-in code read off the screen | It is useless without a paired phone, works once, for 5 minutes |

Out of reach by design: malware running as the user inside that browser
profile (it can drive the page, and so the key); a user who approves a code
they did not start themselves.

**Transcripts are attacker-controlled text.** An agent's output can contain
anything a tool read, such as a fetched web page. The page builds every
transcript element from text nodes and never assigns `innerHTML`; its light
markdown (fences, paragraphs, inline code, bold) is built as elements. The
CSP is the second line of defence, never the first.

## Sign-in

1. **The key.** On "Show a sign-in code" the page makes a fresh pair with
   `crypto.subtle.generateKey({name: "ECDSA", namedCurve: "P-256"}, false,
   ["sign", "verify"])` and stores the `CryptoKey` objects in IndexedDB,
   where they stay non-extractable. P-256 rather than Ed25519, because every
   browser has had it for years. A page whose certificate the user accepted
   is a secure context (its scheme is `https`), so WebCrypto works there —
   checked in Chrome over a LAN address.
2. **Start.** `POST /api/sign-in {key}`: the public key's raw uncompressed
   point (65 bytes, base64url). The bridge refuses a point off the curve.
   The browser's **id** is the first 16 hex characters of the point's
   SHA-256: what `web-browsers` lists and `web-browser-sign-out` names. The
   key is bound to the pending sign-in **here, before any phone sees the
   code**, so the code an identity approves names exactly one key. The answer
   is the code, its lifetime, and the `__Host-` cookie.
3. **The page** shows the code and its QR, and tells the user that the phone
   will show the certificate fingerprint to compare. It never shows a
   fingerprint itself: a MITM's page would show whatever matches.
4. **The phone** (Browsers) scans the QR or takes the typed code, then shows
   "Check the page": the certificate fingerprint it pins from the heartbeat
   (`direct.certSha256`), written as browsers' certificate viewers write it
   (uppercase pairs, colon-separated, eight to a line), and the code. Only
   "They match: sign in" sends `web-sign-in {code}`. The wire is the one it
   was: the identity's signature covers the code, and the code names one key.
5. **The bridge** matches the code and signs the browser in with that key.
   The page, polling `/api/me`, sees `signed-in` with its own `id` and the
   machine's npub — and opens the stream only if the key it holds has that
   id (site data cleared means a new sign-in).

The key lives as long as the sign-in: signing out, a revocation or a lapse
deletes it, and the next sign-in makes a fresh one, so a revoked key is
never used again.

## The stream

`GET /api/stream` with `Upgrade: websocket`; every other upgrade on the port
is a phone's direct link. The upgrade is refused unless the `Host` is
allowed, the `Origin` is the page's own (browsers send cookies on
cross-site WebSocket handshakes, and `SameSite` alone is not relied on), and
the cookie names a signed-in browser — a check that costs one hash, before
any signature work.

Frames are JSON arrays, one per text message, like the direct link's:

```
bridge  ["CHALLENGE", c]                 32 random bytes, base64url, new per connection
browser ["HELLO", sig]                   within 10 s; signs seq 0 with an empty body
bridge  ["READY"] | ["CLOSED", reason]   bad-signature | expired | signed-out | busy | bad-frame
browser ["CMD", seq, body, sig]          body: one PhoneToBridge, as JSON text
bridge  ["OK", seq, accepted, message]   per CMD
bridge  ["MSG", message]                 one BridgeToPhone, as a JSON object
browser ["PAGE", seq, body, sig]         a page request, as JSON text
bridge  ["REPLY", seq, {status, body}]   its answer
```

**The signed input** is the UTF-8 of
`codedeck-web-v1\n<machine npub>\n<browser id>\n<challenge>\n<seq>\n<body>`
with `seq` in decimal; `sig` is WebCrypto's ECDSA signature over it with
SHA-256 (64 bytes, `r‖s`, base64url). It is over the exact text sent, so
neither side canonicalizes JSON, and binding the machine, the browser and the
connection's challenge makes a signature good once, on one connection to one
bridge. `seq` grows on every signed frame (gaps allowed); a frame that does
not verify, or whose `seq` does not grow, closes the stream. Several tabs are
several connections, each with its own challenge.

**Page requests** are what only the page asks: `{type: "devices"}`,
`{type: "config"}` and `{type: "config-set", set}`. The heartbeat
(`sessions`) arrives as a `MSG`, and the browser list through the phone's own
`web-browsers-request` and `web-browser-sign-out`. Over plain HTTPS a cookie
reaches only the page's files, `GET /api/me`, `POST /api/sign-in`, the QR and
`POST /api/sign-out` (ending its own sign-in, which a cookie may always do).

**No automatic resend.** A `CMD` whose `OK` never came before the connection
dropped is reported as "may not have arrived" and not sent again: a browser's
command has no event id for the engine to drop a duplicate by, and the
transcript shows whether an input landed.

## The browser in the engine

A browser is a principal of `bridge-core`: **a client of the identity that
let it in**, addressed as `Addressee::browser(identity, id)`. The runtime
verifies each frame and hands the engine `Input::WebCommand`; the engine
runs it as that identity's, with the reply going to the browser alone. Its
copies are neither encrypted nor signed: the runtime writes them down its
streams. It has presence and watch state like a phone's client, so it gets
live text only for the session on screen; it is present while a stream is
open. Unpairing an identity ends the browsers it let in.

**What a browser may send** (`bridge_core::browser_may_send`, which names
every command so a new one is decided rather than let through): `input`, the
three card responses, `set-option`, `sync-request`/`sync-ack`,
`create-session`, `refresh-sessions`, `close-session`, `interrupt`,
`stop-task`, `create-folder`, `presence`, the read-only requests (usage,
models, agent style, commands, personas, plugins, MCP, session MCP,
permission rules, accounts, provider profiles), `web-browsers-request`,
`web-browser-sign-out`, and `upload-file` in its chunked form. Refused, with
`OK false`:

- `session-key`, `pair-request` and `web-sign-in` belong to an identity: a
  browser never lets in another browser.
- `set-credentials`, `set-provider-profile` and `account-action` move
  secrets and sign-ins.
- `terminal-*`: the terminal allowlist names devices, and a browser is none.
- `upload-file` in its Blossom form: it names a URL for the bridge to
  download (through the Tor proxy when one is set). A browser has no Blossom
  server of its own, and taking the form would let a page make the bridge
  fetch any URL it names.
- The agent-configuration writes: `plugin-action`, `mcp-action`,
  `agent-action`, `session-mcp-toggle`, `permission-rules-remove`.

These can be opened one at a time later, each with its own reasoning.

**Files.** A file attached on the page (the composer's Attach, a paste or a
drop) goes up as the phone's chunked upload does, on the stream itself: each
chunk is a signed `CMD` of about 180,000 base64 characters, which keeps the
frame inside the stream's 256 KiB, and the next is sent only once the last
one's `OK` came back. The bridge's caps apply: 25 MB, and 16 uploads in
progress at once; a partial upload idle for a minute is dropped when the
next chunk of any upload arrives. The words typed with it go in the first
chunk, which carries that much less of the file (so words longer than about
90 KB go on their own, not with a file), and become the message; the bridge
saves the file in the workspace's `.codedeck/uploads` and tells the agent
where. A file chosen for one session is dropped when another is opened, so
it never reaches the wrong one.

An `OK` says the bridge has the chunk, not that the file reached the agent.
That answer comes once per file, by the id the page gave it when it was
attached (`inputId`, on every chunk): `input-ack` when the file is in the
session, `input-failed` with the reason when it is not — the page then stops
sending pieces, says why and keeps the file attached. Until the answer the
file shows as delivering; with none in a minute the page says so and keeps
it attached, and sending it again under the same id is acknowledged rather
than delivered twice (while the bridge remembers it: a day, not across a
restart).

## Lifetimes

- **30 days** from sign-in at most (the cookie's `Max-Age` is set at the
  start; the bridge's record, which decides, counts from the approval).
- **7 idle days:** only a verified signature (`HELLO`, `CMD`, `PAGE`) moves
  `lastSeenMs` — a request carrying the cookie does not, so a copied cookie
  cannot keep a session alive. It is written to disk at most once a minute,
  so the limit holds to a minute and survives a restart. An open tab renews
  its presence every 5 minutes, which keeps it signed in while open.
- `expiresMs` in `web-browsers` is when it actually lapses:
  `min(sinceMs + 30 d, lastSeenMs + 7 d)`.
- A lapse, sign-out or revocation closes the browser's streams at once with
  `["CLOSED", reason]`; the page returns to sign-in and deletes its key.

## Rendering

The page renders the protocol's messages itself, in plain JavaScript with no
build step, about 60 KB in all. Reusing the phone's core instead
(`crates/client-core` in wasm) was considered: it is pure, but it and
`crates/protocol` depend on `nostr`, which pulls `secp256k1-sys`, a C
library — a wasm build needs the Nostr parts behind a feature or a C
compiler for wasm, a wasm build in every release, and `'wasm-unsafe-eval'`
in the CSP. The browser needs none of the Nostr parts, and a renderer of the
wire's entry types is small, so the page keeps its own; the corpora and
`PROTOCOL.md` are what it follows.

## Cost

- No relay traffic, no NIP-44 and no event signing for a browser's copies: a
  copy for a browser costs the bridge less than one for a phone.
- Live text only for the session on screen, nothing for a closed tab.
- **The phones' links never wait for a browser.** A stream goes through the
  direct link's lane: queued, never waited on, and a browser that stops
  reading is closed (`busy`) and reconnects with a sync. Caps: 4 streams per
  browser, 16 in all, 64 signed-in browsers. An open stream does not count
  against its host's direct-link connections (8 per address, or per /64 on
  IPv6, where a whole LAN shares one), so tabs never lock a phone out.
- One ECDSA P-256 verify per browser frame, at human rates.

## Tests

- `crates/protocol/src/web.rs`: the frames, and the key and signature checks
  against a vector made by WebCrypto.
- `crates/bridge-core/tests/web_client.rs`: the engine's side — copies,
  replies, live text, the allowlist, unpairing.
- `crates/bridge-runtime/src/web.rs`, `web_stream.rs`: the page and the
  stream over a real WebSocket — the cookie alone, the limits on an injected
  clock, the gate, a replayed `seq`, another key, another connection's
  challenge.
- `crates/bridge-runtime/tests/web_page.rs` (ignored; `./codedeck e2e` and
  CI run it): the real runtime and agent host, a paired phone core, and a
  browser over pinned TLS, from sign-in to a session answered and the phone's
  sign-out closing the stream. Its `hold_a_bridge_for_a_real_browser` holds
  such a bridge for a real browser: with `CODEDECK_WEB_HOLD=<file>` (and
  `CODEDECK_WEB_HOLD_PORT`, `CODEDECK_WEB_HOLD_SECS`) the phone approves
  every code written to `<file>`, so headless Chrome — or a person — can
  drive the page.

Later, optionally: signing as the real identity through a NIP-07 browser
extension, for users who have one; a real certificate through Tailscale,
which removes the warning.
