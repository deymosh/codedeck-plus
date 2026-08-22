CodeDeck Next 0.9.3 — the first release that has actually been used on a phone.

0.9.0 shipped unverified. Since then the app has been run on real hardware
across several device sessions, and most of this release is what those sessions
found. 127 commits since 0.9.0.

**The app now looks like the original CodeDeck again.** One screen: sessions
grouped by machine in a sidebar, DMs in their own section (inline when there's
room, a drawer when there isn't). Swipe to delete with a 4-second undo, unread
dots with an audible ping, and a session carousel you can swipe between.

New in this release:

- **Custom AI providers.** A session can run on Kimi K3, OpenRouter, or any
  Anthropic-compatible endpoint instead of Anthropic. Profiles are managed on
  the phone and stored by the bridge in its keychain; the token never travels
  over the wire and never reaches a log. The provider is fixed when the session
  is created, and a session whose profile was deleted fails loudly rather than
  silently falling back to Anthropic and billing you for it.
- **Model shown in the session header again**, and the bridge now actually
  knows which model a session is on.
- **Image attachments work.** Sending an image failed with "Failed to read
  file" on every Android build — the WebView hands back a `content://` URI that
  the old read path could not open. Uploads are also cancellable now, and a
  stalled read reports an error instead of wedging the composer permanently.

Fixed, and worth naming because they were data-losing or misleading:

- **Your own messages could vanish.** The bridge acknowledged a message before
  any transcript entry existed for it, and the echo travelled on an ephemeral
  event — so if that one event dropped, the message was simply gone from your
  screen. Sent messages now stay visible until the transcript genuinely
  contains them.
- **"Connected" could be a lie.** The relay pool closed its own subscriptions
  on an internal 20-second idle timer, leaving the app inbound-dead while the
  status chip still read connected and outgoing messages still worked. Only
  backgrounding and re-opening the app healed it.
- **Text got clipped while typing** on narrow screens, at any UI scale.
- **Unfolding a foldable mid-session no longer inflates the text**, and
  headings, tables, code blocks, quotes and nested lists are all styled.
- The default relay fallback is now `nostr.oxtr.dev`. The previous candidate
  passed every cold probe and then demanded proof-of-work under live load,
  which is the worst possible behaviour for a default.

Security:

- A session bound to a custom provider can no longer inherit the operator's
  cloud backend, credentials or custom headers from the environment. Before
  this fix a Kimi session could be silently billed to an operator's AWS
  account, and gateway credentials could be forwarded to a third-party
  endpoint. Provider endpoints must be https (loopback http is allowed, for
  local models), enforced at the point of use.

Still true from 0.9.0 — please read:

- This is a **new Android app** (`com.codedeck.next`) that installs alongside
  the old CodeDeck. Nothing is migrated: fresh pairing is required, and old
  history and settings do not carry over.
- **You need a v10 bridge** on the machine running Claude Code — the VSCode
  extension, or the headless CLI for a laptop or VPS. Install either from its
  GitHub releases page:
  github.com/JeroenOnNostr/codedeck-next-bridge-vscode
  github.com/JeroenOnNostr/codedeck-next-bridge
  The old bridge will not pair with this app.
- **This exact binary has not been device-verified.** 0.9.2 was tested on a
  Pixel 9 Pro Fold; ten commits landed after that run, so treat 0.9.3 as a
  pre-release and keep a way back. The full suite (1445 tests) passes.
- The listing still has no screenshots. They are owed from a real device.

The source is now public: https://github.com/JeroenOnNostr/codedeck-next-mobile
