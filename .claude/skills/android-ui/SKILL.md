---
name: android-ui
description: Change or add Android app UI (Jetpack Compose in apps/android) — the component kit, navigation wiring, and Paparazzi snapshot tests.
---

# Android UI

Code: `apps/android/app/src/main/java/com/codedeck/plus/ui/`. Read only the
files you touch; the ones below are the contract.

## Build from the kit

- `components/Kit.kt` — `Page`, `Group` + rows (`NavRow`, `SwitchRow`,
  `ValueRow`, `ActionRow`, `ExpandableRow`, `GroupBody`), `Toggle`/`BusyToggle`,
  `RowSpinner`/`PageLoading`, `Note`/`ErrorNote`, `ConfirmDialog`, `Segmented`,
  buttons (`Primary`/`Secondary`/`QuietButton`), `Field`, `Chip`, `Dot`,
  `EmptyState`. Also `components/SelectField.kt`, and `components/Sheet.kt`:
  `DeckSheet` is every bottom sheet (never a raw `ModalBottomSheet`). A sheet
  with pages navigates inside itself, Back stepping to the page it came from.
- `theme/Tokens.kt` — every colour, size, radius. No literal colours; colour
  means state (running/waiting/failed), white is the only accent.
- Grep `components/` before writing a raw Material widget or a styled
  `Text`/`Box`. If a second screen needs something a screen has privately,
  move it into `Kit.kt` (stateless, KDoc saying what it is for).

## Screens

- Split each screen into a pure `XContent(machine, …, dispatch, onBack)` (what
  snapshots render) and a thin `XScreen(core, …)` that reads `CoreHost`
  flows. For a machine's page use `machineOrLeave` (`screens/MachineSettings.kt`).
- Navigation is state, not a library: `Shell.kt` (`Screen` + `ScreenSaver` +
  `BackHandler`) and, inside Settings, `SettingsPage` in
  `screens/SettingsScreen.kt`. A page reachable from both — like a machine's
  page — must be wired in **both**. Never default a navigation callback to
  `{}`: a missing wire must fail to compile.
- Native (FFI) functions cannot run in JVM tests: take them as parameters
  defaulting to the native call (see `McpContent`'s `parse`/`check`).

## Snapshots and tests

- `app/src/test/.../ui/DesignSnapshotTest.kt` renders pages from
  `DesignFixtures.kt`; add a page there for new UI. Goldens live in
  `app/src/test/snapshots/images/`.
- Run Gradle from `apps/android` in the Android toolchain (Linux:
  `source toolchain/env.sh`; Windows: the long-lived container, see
  CLAUDE.md "Commands"):
  `./gradlew --offline testDebugUnitTest verifyPaparazziDebug`.
- A refactor must pass `verifyPaparazziDebug` **without** re-recording. For an
  intended visual change run `recordPaparazziDebug`, look at the changed PNGs,
  and commit them with the code.
- After an FFI change regenerate bindings first: `./codedeck gen-android-bindings`
  (CI fails on drift).
