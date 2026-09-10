# F0 · probe 3 — background reliability

> **THROWAWAY.** Delete once the verdict is folded into the plan (or an ADR).

## Status: **networking core GO · on-device run BLOCKED (roomy AVD / device needed)**

The plan's central thesis is "sockets in a Rust core inside the foreground
service keep delivering while the app is backgrounded / Dozed, where WebView
sockets do not". This probe has two halves:

| Half | State |
|---|---|
| **Networking core** (Rust relay client: subscribe kind-30515, count deliveries, reconnect with backoff) | ✅ **GO** — host tests green |
| **On-device** (that core, hosted by a real Android `dataSync` foreground service, survives HOME / screen-off / forced Doze / airplane blips on the emulator) | ⛔ **not run** — the only installed AVD is 96% full (`/data` 262 MB free; Android blocks installs under ~594 MB free) and it is the maintainer's populated test AVD, not safe to wipe |

## What is proven (networking core)

`rust/heartbeat-core` — a real `tokio-tungstenite` client:

- `counts_heartbeat_deliveries` — connects, sends `REQ` for
  `{kinds:[30515], authors:[…], #p:[…]}`, counts each `EVENT`, exposes
  `ProbeStats { connected, received, last_heartbeat_ms, reconnects }`.
- `reconnects_after_socket_drop_and_resumes` — relay drops the socket after N
  events; the core emits `Disconnected` → `Reconnecting { attempt, delay_ms }`
  (exp backoff 1→32 s, cap 30 s) → `Connected` again and resumes counting.
- Consumed on Android via **UniFFI** (the pattern probe-1 validated) — the
  generated `HeartbeatProbe` / `ProbeListener` / `ProbeEvent` / `ProbeStats` are
  wired into `RelayService` and compile + package into the APK.

## What is built and ready (on-device)

- **`android/`** — a minimal native app. `RelayService` (`foregroundServiceType="dataSync"`,
  `START_STICKY`, optional `PARTIAL_WAKE_LOCK`) **owns the Rust core**; the socket
  lives in the service process, not a WebView. `MainActivity` shows the running
  count; `adb`-drivable via `am start -n …/.MainActivity --ez auto true [--ez wl true]`.
- **`pulse-relay`** — a WS stand-in for "a bridge emitting kind-30515", every 15 s.
- **`build.sh`** — one Docker image (Rust + NDK r28c + cargo-ndk + JDK 17 +
  Android cmdline-tools) → `cargo test` → `libheartbeat_core.so` (x86_64 + arm64)
  → `uniffi-bindgen` → **`artifacts/bgprobe-debug.apk`** (builds green).
- **`run-emulator.sh`** — installs the APK, starts `pulse-relay` on host `:7447`,
  runs the matrix: `foreground baseline → app backgrounded (HOME) → screen off →
  forced Doze (dumpsys deviceidle force-idle) → airplane blip`, printing
  `DELIVERING` / `!! STALLED` per phase from logcat.

## To finish the on-device run

Need an AVD with room (or a device). Fastest:

```
# fresh throwaway AVD in Android Studio (Device Manager → Create), API 34+,
# then:
AVD=<name> ./spike/background-probe/run-emulator.sh
```

## Findings so far

- `#[uniffi::export]` without `async_runtime` is correct when no public method is
  `async` (probe-1 used the async attr deliberately; this core does not — it owns
  its tokio runtime internally, created in `start()`).
- APK build tooling: **compileSdk 36** here — the API-37 platform ships SDK XML
  v4, which the sdklib bundled in the Dockerized AGP 8.11.1 cannot parse
  (`Failed to find target android-37`). A native Android Studio build (matching
  newer sdklib) handles 37; the real `apps/android` still targets 37. This is a
  tooling-version bump for F3, not an architecture risk.

## Hard limitation of the emulator for this probe

A stock AOSP / Google-APIs emulator is **lenient** — it honours forced Doze and
app-standby, but it does **not** reproduce Samsung/OneUI or Xiaomi/MIUI
proprietary background killing, which is the actual reason CodeDeck's background
is unreliable today. **An emulator GREEN is necessary but NOT sufficient.** A
real Samsung + a real Xiaomi pass remain a hard gate before F1 fully commits.

## Reproduce / continue

- core only: `docker run --rm -v .../background-probe:/s -w /s/rust/heartbeat-core rust:1-bookworm cargo test`
- APK: `./spike/background-probe/build.sh`
- on-device: `AVD=<roomy_avd> ./spike/background-probe/run-emulator.sh`

## Delete criteria

Once probe-3's verdict (both halves) is recorded in the plan, `rm -rf spike/background-probe/`.
