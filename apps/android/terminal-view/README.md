# Vendored Termux terminal emulator and view

`apps/android/terminal-emulator` and `apps/android/terminal-view` are copies of
Termux's terminal emulator and view, taken so the app can host a terminal whose
shell runs on a remote bridge. Both are Apache-2.0 (the rest of
`termux/termux-app` is GPLv3); the license text is each module's `LICENSE`.

- Source: <https://github.com/termux/termux-app>
- Tag: `v0.118.3`
- Commit: `5b657c6adf4304e5198951ce815fe0205dcac29c`
- Copied: `terminal-emulator/src/main/java/**`, `terminal-view/src/main/java/**`
  and `terminal-view/src/main/res/**`

Upstream is not tracked. There is no submodule, no Gradle include of the
upstream tree and no JitPack dependency: the sources are here, and the modules'
Gradle files are written in this repo's own style. To update, re-copy the paths
above from a newer tag deliberately and re-apply the local changes listed
below; never merge upstream mechanically.

## Local changes

(To be listed.)
