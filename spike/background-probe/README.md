# F0 · probe 3 — background reliability

> **THROWAWAY.** Delete once the verdict is folded into the plan (or an ADR).

## Status: **GO on the emulator** · real-OEM pass still required before F1 commits

The plan's central thesis is "sockets in a Rust core inside the foreground
service keep delivering while the app is backgrounded / Dozed, where WebView
sockets do not". Both halves now pass:

| Half | State |
|---|---|
| **Networking core** (Rust relay client: subscribe kind-30515, count deliveries, reconnect with backoff) | ✅ **GO** — host tests green |
| **On-device** (that core, hosted by a real Android `dataSync` foreground service, on a wiped API-36 emulator) | ✅ **GO** — full matrix DELIVERING (`artifacts/emulator-matrix.log`) |

### Emulator matrix result (pulse every 15 s)

| phase | heartbeats received | reconnects | verdict |
|---|---|---|---|
| foreground baseline | 2 → 4 | 0 | DELIVERING |
| backgrounded (HOME) | 4 → 7 | 0 | DELIVERING |
| screen off | 7 → 10 | 0 | DELIVERING |
| **forced Doze** (`dumpsys deviceidle force-idle`) | 10 → 15 | 0 | DELIVERING — socket survived Doze, zero reconnects |
| after airplane-mode blip | 15 → 17 | 4 → 5 | DELIVERING — dropped, backoff-reconnected, resumed |

The FGS `dataSync` exemption + the persistent socket held through Doze with no
teardown; airplane toggles exercised the reconnect FSM and it recovered.

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

## Still required before F1 fully commits

A pass on a **real Samsung/OneUI + a real Xiaomi/MIUI** device (see the emulator
caveat below). Run `./spike/background-probe/run-emulator.sh` after
`adb connect`-ing the device, or drive the matrix by hand:
`am start -n …/.MainActivity --ez auto true`, then HOME / power / leave 30+ min /
toggle wifi+data, watching `adb logcat -s bgprobe`.

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
- emulator matrix: `./spike/background-probe/run-emulator.sh` (wipe/roomy AVD;
  `AVD=<name>` to override). The API-36 AVD used here was factory-reset first
  (`emulator -avd <name> -wipe-data`).

## Delete criteria

Once probe-3's verdict (both halves) is recorded in the plan, `rm -rf spike/background-probe/`.
