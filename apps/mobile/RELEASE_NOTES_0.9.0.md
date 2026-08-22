CodeDeck Next 0.9.0 — first release of the rebuilt app.

This is a complete rebuild on protocol v10, not an update to the existing
CodeDeck app. It ships as a new Android app (`com.codedeck.next`) and installs
**alongside** the old one — nothing is overwritten or migrated.

What that means for you:

- **Fresh pairing is required.** Old pairings, session history and settings do
  not carry over. Scan the QR from the new app against a v10 bridge.
- **You need the new bridge**, which only speaks v10: the `codedeck-bridge-vscode`
  extension, or the headless CLI (`npx @codedeck/bridge`) for a laptop or VPS.
- The old app and old bridge keep working side by side during the transition.

In this release:

- Multiple concurrent Claude Code sessions, switchable from one app
- Plan approval, permission cards and AskUserQuestion prompts on the phone
- Ranged transcript sync — history survives restarts, offline gaps, reinstalls
- Per-session model selection and effort levels
- Encrypted Nostr DMs: NIP-17 and Marmot (MLS) side by side
- Project/folder management on every bridge host, including VPS
- Auto and manual UI scale, phone through tablet

Known limitations — please read:

- **This build has not yet been verified on a physical device.** It is a 0.9.0
  pre-release of the 1.0 cutover: the test suite and a laptop soak rig pass,
  but the on-device verification pass is still outstanding. Treat it as a
  pre-release and keep the old app installed until you have confirmed the new
  one works for you.
- No screenshots on the listing yet — they are owed from a real device.
- The source repository is not published yet, so the listing carries no source
  link. It will be added once the repo is public.
