# Roadmap

Work that is decided but not built yet, with enough of the design to start
from. Which agents to add next is in
[`AGENT-CANDIDATES.md`](AGENT-CANDIDATES.md).

## A VS Code extension

A thin launcher for the bridge, so a machine with VS Code needs no terminal
to run one. It knows no agent: everything agent-specific stays in the bridge
and the agent host.

- **Install.** Download the release archive for the host's platform
  (`linux-x86_64`, `linux-aarch64`, `macos-aarch64`, `windows-x86_64`),
  verify it, and unpack it with the system `tar` (Windows 10 and later ship
  a `tar.exe` that opens the `.zip`). A file that Node's `https` writes is
  not quarantined on macOS, so no `xattr` step is needed.
- **Verify.** Releases publish no checksums today. Open choice: a
  `SHA256SUMS` asset on each release, or the archives' sha256 baked into the
  `.vsix` built in the same release run (stronger: the extension then trusts
  only what it shipped with).
- **Run.** `codedeck-bridge run --workspace <folder>` for the open
  workspace, its output in an output channel, and a status bar entry for its
  state.
- **Pair.** `codedeck-bridge pair --json` against the bridge it started:
  JSON lines `{id, state: "open", url, displayUrl, expiresAtMs}`, then
  `paired` (with `phone: {label, npub}`), `expired` or `closed`; exit 0 only
  when paired. The extension draws the QR from `url`.
- **Ship.** The `.vsix` is a GitHub Release asset, built by `release.yml`;
  it is not published on the Marketplace.
