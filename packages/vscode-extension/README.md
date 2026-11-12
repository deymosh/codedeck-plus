# CodeDeck+ for VS Code

Runs the [CodeDeck+](https://github.com/deymosh/codedeck-plus) bridge for the
open workspace, so the coding agents on this machine (OpenCode, Claude Code,
DeepSeek Harness, Qwen Code) can be driven from the CodeDeck+ Android app over
end-to-end-encrypted Nostr.

- **Start the bridge** (status bar → *Start the bridge*, or *CodeDeck+: Start
  the bridge*). The first start downloads the bridge of the release this
  extension came with, checks it against the sha256 the extension was built
  with, and unpacks it into the extension's storage. Sessions run in the
  workspace's folders.
- **Pair a phone**: *CodeDeck+: Pair a phone* shows a QR code to scan with
  the app.
- **The log**: *CodeDeck+: Show the bridge's log*.

The bridge runs while the window is open and stops with it. It keeps its
state in `~/.codedeck`, shared with the `codedeck-bridge` command line: a
bridge already running there (a service, a terminal, another window) is used
for pairing instead of starting a second one.

Settings: `codedeck.autoStart`, `codedeck.home` (another state directory),
`codedeck.bridgePath` (a bridge binary of your own, with its `agent-host/`
beside it). Everything else — relays, Tor, the direct link — is the bridge's
own configuration, `config.json` in its home; see the repository's
`docs/BRIDGE.md`.

Builds exist for Linux x86_64 and aarch64, macOS on Apple silicon and
Windows x86_64 (Windows on Arm runs it under emulation).
