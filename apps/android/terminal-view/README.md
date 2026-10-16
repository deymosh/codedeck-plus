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

- **No native code.** Upstream built the emulator with the NDK
  (`src/main/jni/`, `Android.mk`, an `externalNativeBuild` block) around a
  local pseudoterminal. None of it is copied, and the `JNI` class is deleted.
- **`TerminalSession` is remote, not process-backed.** The class keeps its
  name and package so `TerminalView` needs no change, but its constructor is
  `(Integer transcriptRows, TerminalSessionClient client,
  TerminalSessionCallbacks callbacks)` and it spawns nothing. `feed(byte[])`
  appends bytes from the bridge to the emulator on the main thread and asks the
  view's client to redraw; `updateSize(...)` resizes the emulator and reports
  the new size; `isAlternateBufferActive()` exposes the alternate-screen flag
  so a host can batch input differently there. The `write(...)` paths the view
  uses (keys, IME text, paste, code points) now call
  `TerminalSessionCallbacks.onInput` instead of writing to a file descriptor.
  The pid, exit-status, `finishIfRunning`, cwd and process-cleanup machinery is
  gone.
- **`TerminalSessionCallbacks` added** (`onInput`, `onResize`) — the small
  interface the bridge-facing host implements; upstream had no equivalent
  because its input and resize went straight to the pty.
- **`TerminalSession`'s `TerminalOutput` callbacks null-check `mClient`.** The
  emulator calls `onColorsChanged` from its own constructor's `reset()`, so a
  session built without a client (as the unit test builds one) would otherwise
  throw.
- **Manifests emptied.** The upstream `package` attribute moved to the Gradle
  `namespace` (`com.termux.terminal`, `com.termux.view`), which AGP 9 requires.
- **Gradle files written fresh** in `apps/android/app/build.gradle.kts`'s
  style (the catalog's AGP, compileSdk and minSdk, Java 17), and the app
  depends on both modules.
- **`terminal-emulator/src/test/.../TerminalSessionTest.java` added** — a JVM
  test of the three directions above.

The upstream `proguard-rules.pro` files are not copied: they were empty
templates and neither module minifies.
