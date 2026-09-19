#!/usr/bin/env bash
# F0 probe-3, on-device half: install bgprobe on the Android emulator, then run
# the background matrix and report whether kind-30515 deliveries keep arriving
# while the app is backgrounded / screen-off / Dozed.
#
# NOTE: a stock AOSP/Google-APIs emulator is LENIENT — it will NOT reproduce
# Samsung/OneUI or Xiaomi/MIUI proprietary background killing, which is the
# actual reason CodeDeck's background is unreliable today. An emulator GREEN is
# necessary but NOT sufficient; a real Samsung + Xiaomi pass is still a hard
# gate before F1 fully commits.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK="${ANDROID_HOME:-$LOCALAPPDATA/Android/Sdk}"
ADB="$SDK/platform-tools/adb.exe"
EMU="$SDK/emulator/emulator.exe"
AVD="${AVD:-Medium_Phone_API_36}"
APK="$HERE/artifacts/bgprobe-debug.apk"
PKG="com.codedeck.bgprobe"
export MSYS_NO_PATHCONV=1

log() { echo -e "\n=== $* ==="; }
hb()  { "$ADB" logcat -d -s bgprobe | grep -oE 'received=[0-9]+' | tail -1 | cut -d= -f2; }
rc()  { "$ADB" logcat -d -s bgprobe | grep -oE 'reconnects=[0-9]+' | tail -1 | cut -d= -f2; }
phase() { # $1 = label, $2 = seconds
  local before after brc arc
  before=$(hb); brc=$(rc); sleep "$2"; after=$(hb); arc=$(rc)
  printf '  %-22s received %s -> %s   reconnects %s -> %s   %s\n' \
    "$1" "${before:-0}" "${after:-0}" "${brc:-0}" "${arc:-0}" \
    "$([ "${after:-0}" -gt "${before:-0}" ] && echo DELIVERING || echo '!! STALLED')"
}

log "pulse-relay on host :7447 (docker)"
docker rm -f bgprobe-pulse >/dev/null 2>&1
docker run -d --rm --name bgprobe-pulse -p 7447:7447 -e PULSE_SECS=15 \
  -v "$(cygpath -w "$HERE" 2>/dev/null || echo "$HERE"):/s" -w /s/rust/heartbeat-core \
  -v codedeck-spike-cargo:/ct -e CARGO_TARGET_DIR=/ct codedeck-bgprobe-build \
  bash -c 'cargo run --quiet --release --bin pulse-relay'
sleep 5

log "boot emulator ($AVD)"
"$EMU" -avd "$AVD" -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect &
EMU_PID=$!
trap '"$ADB" emu kill >/dev/null 2>&1; kill $EMU_PID 2>/dev/null; docker rm -f bgprobe-pulse >/dev/null 2>&1' EXIT
"$ADB" wait-for-device
until [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 3; done
"$ADB" shell input keyevent 82 >/dev/null 2>&1  # dismiss keyguard

log "install + launch"
"$ADB" install -r -g "$APK"
"$ADB" shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS 2>/dev/null
# service is not exported; MainActivity starts it when launched with --ez auto true
"$ADB" shell am start -n "$PKG/.MainActivity" --ez auto true >/dev/null
sleep 10

log "background matrix (pulse every 15s)"
phase "foreground baseline"   45
"$ADB" shell input keyevent 3           # HOME
phase "app backgrounded"      45
"$ADB" shell input keyevent 26          # screen OFF
phase "screen off"           60
"$ADB" shell dumpsys deviceidle force-idle >/dev/null
phase "forced Doze"          90
"$ADB" shell dumpsys deviceidle unforce >/dev/null
"$ADB" shell input keyevent 26          # screen ON
"$ADB" shell cmd connectivity airplane-mode enable  >/dev/null 2>&1
sleep 10
"$ADB" shell cmd connectivity airplane-mode disable >/dev/null 2>&1
phase "after airplane blip"  45

log "final logcat tail"
"$ADB" logcat -d -s bgprobe | tail -25
