# Terminal on the bridge

A phone can open a real terminal on a paired bridge: a shell in a
pseudo-terminal on the bridge's machine, drawn on the phone by a terminal
emulator, so interactive programs (an editor, `htop`, `git add -p`) work as
they would over SSH. This file is the design; `crates/protocol` is the spec
once it lands.

A terminal is a shell as the bridge's own user — strictly more than an agent
in its most permissive mode. The design is therefore built around two goals
before convenience: **only the machine's owner decides who gets one**, and
**everything a terminal did can be reconstructed afterwards on the machine**.

## Who may open a terminal

Three gates, all of which must pass:

1. **The bridge has terminals on.** `terminal.enabled` in `config.json` (or
   `--terminal`). Off by default; without it the bridge does not advertise
   the capability and refuses every terminal message. It is never switched
   from the phone.
2. **The identity is paired**, by the same rule as every command: the event
   is signed by a paired identity.
3. **The device is approved on the machine.** Every client of an identity
   shares the identity key, so a stolen key would otherwise open a shell from
   any new device. The bridge keeps an allowlist of device ids
   (`terminal-allow.json` in its home, `0600`). A `terminal-open` from a
   device not on it is refused (`terminal-exited {reason: "not-allowed",
   device}`), the refusal is audited, and the phone shows the device id and
   name to approve. The owner approves on the machine:
   `codedeck-bridge terminal pending` lists refused devices,
   `codedeck-bridge terminal allow <device>` approves one,
   `codedeck-bridge terminal disallow <device>` withdraws it. These work while
   the bridge runs (atomic file writes; the bridge re-reads the file, cached
   by modification time, on every terminal message), and **withdrawing a
   device closes its terminals at once** — the kill switch for a lost phone.

Optionally, the **phone can require fingerprint or PIN** (Android
`BiometricPrompt`, device credential as fallback) before opening or attaching
to a terminal: an app setting, off by default. It protects an unlocked phone
in someone else's hand; the bridge does not rely on it.

### Which device

The bridge knows a client by its session key, which rotates. A terminal
needs a name that survives rotation, for the allowlist and the audit:

- **Device id** = the first 16 bytes, in hex, of
  `sha256("codedeck/device\0" + first session key + "\0")` — the key the
  client first granted to this bridge, carried across every `replaces`.
  Re-pairing or reinstalling makes a new device, which must be approved
  again.
- **Device name**: the phone sends a label with its session-key grant
  (`label`, user-editable, default the phone's model). A name is what a
  person reads; the id is what the bridge trusts.

## The shell

- Starts in the workspace (`work.rs`'s root) or, opened from a session, in
  that session's directory. The phone never sends a path.
- Runs with a **built environment**, not the bridge's: `PATH`, `HOME`,
  `USER`, `LANG`, `SHELL`, `TERM=xterm-256color` (and on Windows the system
  variables a shell needs). The bridge's own environment can hold provider
  keys the user exported for the agents, and only each driver knows which
  variables are secrets, so the shell inherits none of it.
- What runs: `terminal.command` when the owner sets one (a fixed program —
  `tmux new -A -s phone`, a restricted shell), else `$SHELL`, else `/bin/sh`;
  on Windows `pwsh`, else `powershell`, else `cmd`.
- **One writer.** Only the device that opened a terminal types into it.
  Another device attaches read-only and can take over explicitly
  (`terminal-takeover`), which is audited and moves the writer. The new
  writer's `seq` resumes where its own last one ended — a takeover never
  restarts a device's count.

## Capability

`terminal` — the phone shows Terminal only when the heartbeat lists it. It
fits the rule in `capabilities.rs`: a phone that sent terminal messages to a
bridge without it would wait on a terminal that never opens.

## Transport

Terminal messages are ordinary CodeDeck messages, but they take **the direct
link by default**: a terminal opens only over a direct link (LAN, VPN, or an
onion endpoint through Orbot) unless the owner sets `terminal.relays: true`.
Even encrypted, a relay sees each event's size and timing, and keystroke
timing alone leaks what was typed; the direct link shows nobody either.
When relays are allowed, a terminal falls back to them like any message.

- Both directions use `LIVE_KIND` (24515, ephemeral): **keystrokes are never
  stored on a relay**. Phone→bridge input on the live kind is new: the direct
  link accepts it besides commands (today it accepts only 4515), and, with
  relays allowed, the bridge subscribes to it from its paired phones.
- **Every input carries `seq`**, per terminal **and per device**, counting up
  by one from 1. The bridge applies input in order, drops a `seq` it has
  already applied (a relay's replay of a signed keystroke event re-types
  nothing), and holds a later one for up to 2 s waiting for the gap, then
  asks the phone to resend from the gap (`terminal-input-from`). A device's
  `seq` on a terminal only ever grows: a takeover does not start it over, so
  nothing that device sent before can be typed again whoever wrote in
  between. The `terminal-input-from` a takeover sends names the seq that
  device resumes at — the phone keeps one counter per terminal and takes the
  number it is given. Held input is capped at 256 inputs / 1 MiB; past
  either, or past a seq no run with a hole in it could reach, what is held is
  dropped and the writer is asked to resend. Terminal input does **not** go
  through the command dedup set (the 1000 most recent ids, `ingest.rs`):
  a burst of keystrokes would push command ids out of it and reopen a replay
  window for commands. The per-terminal, per-device `seq` is its dedup, and
  the 300-second age limit still applies.
- **Output is coalesced**: the bridge flushes at most every 16 ms on the
  direct link and every 100 ms on relays, or sooner past 16 KiB pending.
  Larger flushes split by the existing `chunk` fragmentation.
- **Input is sent when a program can react to it, not per keystroke.** On
  the normal screen (a shell prompt), printable characters wait on the phone
  and go in one event when a key a program acts on is pressed — Enter, Tab
  (completion), Esc, arrows, Backspace/Delete, any Ctrl/Alt chord — or when
  typing pauses (150 ms on the direct link, 400 ms on relays), or past 256
  bytes. So `git che` + Tab is one event carrying `git che\t`, and the
  completion comes back in one output frame. Characters still waiting are
  drawn at once as a **predicted echo** (dimmed, at the cursor, as mosh
  does) and replaced by the real output when it arrives, so batching never
  feels like lag. On the alternate screen (vim, htop, less — every key is a
  command there) there is no prediction and keys go after at most 20 ms on
  the direct link and 60 ms on relays, coalescing a held key's repeats. The
  emulator already knows which screen is showing; nothing extra crosses the
  wire. A paste is one event.
- **A rate cap per terminal on relays**: at most 5 input events and 10
  output events a second, the rest merged into the next — relays rate-limit
  their writers, and a terminal must not get the bridge's or the phone's key
  throttled for the agents too. The direct link has no cap.
- **A terminal never slows the phones' links.** The bridge runs the relays,
  the direct links, the web page and the engine on one thread, so no
  terminal may block it or flood it. A terminal's input and its recording
  each have a thread of their own, and the bridge only hands work over:
  input goes into a bounded queue and is dropped, with a warning, when the
  program has stopped reading it. Output is paced rather than passed
  through — the reader thread is throttled by a small queue, and the bridge
  emits at most one frame per 16 ms — so a shell writing faster than the
  phones can be sent it runs at that pace, its pty filling and its write
  blocking, like a terminal on a slow line. What a terminal costs the
  bridge's thread is therefore bounded, whatever runs in it.
- **Privacy of size and timing.** NIP-44 already pads every payload to a
  size bucket, so a relay sees bucketed sizes, not byte counts. Batching on
  the keys above, rather than sending each keystroke, also hides the typing
  rhythm that keystroke-timing analysis reads. Output is not compressed
  before encryption: terminal output mixes what a command printed with what
  an outsider can influence (a file, a log line), and a compressed length is
  an oracle for that mix.
- **Output goes only to the devices showing that terminal**, by the
  `watching` rule live text already follows (see `presence` in
  `PROTOCOL.md`): a device watches a
  terminal the way it watches a session.
- Loss is tolerated: every output frame carries the terminal's byte offset,
  and a phone that sees a gap (or reconnects) asks for a replay from the
  last offset it drew. The bridge keeps the last 256 KiB of each terminal's
  output for that; older than that, the phone resets the screen and redraws
  from what is kept (the program's next repaint fixes the rest).

## Messages

All carry `v` like every message. `term` is a terminal id the bridge assigns.

| Message | Direction | Fields |
| --- | --- | --- |
| `terminal-open` | phone → bridge | `openId` (the phone's own, echoed back), `cols`, `rows`, `session?` (start in its directory) |
| `terminal-opened` | bridge → phone | `openId`, `term`, `shell` (what runs, e.g. `/bin/bash`) |
| `terminal-input` | phone → bridge | `term`, `seq`, `data` (base64 of the bytes — a key press need not be valid UTF-8) |
| `terminal-input-from` | bridge → phone | `term`, `seq` (resend from here; on a takeover, the seq this device's own count resumes at) |
| `terminal-output` | bridge → phone | `term`, `offset`, `data` (base64) |
| `terminal-resize` | phone → bridge | `term`, `cols`, `rows` (writer only) |
| `terminal-replay` | phone → bridge | `term`, `from` (byte offset; attaches read-only) |
| `terminal-takeover` | phone → bridge | `term` (become the writer) |
| `terminal-close` | phone → bridge | `term` (hang up: SIGHUP, then kill after 5 s) |
| `terminal-exited` | bridge → phone | `term?`, `openId?` (instead of `term` for a refused open), `code?`, `reason` (exit, killed, closed, idle, limit, not-allowed, disabled, transport, restart; open — an unknown one reads as ended), `device?` |
| `terminal-event` | bridge → every present client | `term`, `what` (opened, attached, takeover, closed, exited), `device`, `name?`, `via`, `at` |

The open terminals ride the session list the bridge already publishes
(`term`, `shell`, `opened`, `device`, `name`, `writer`, `cols`, `rows`), so a
phone that comes back (or a second phone) sees them and can attach with
`terminal-replay {from: 0}`. That list holds **only the receiving identity's
own terminals**: a terminal belongs to the identity that opened it, so no
other paired identity's heartbeat names it — not its id, its shell, nor the
device running it. An identity with a terminal open gets a heartbeat event of
its own; one with none gets the single shared list, so the cost of a terminal
is paid only by the identity that has it.

**Every other device is told.** `terminal-event` goes to each present client
of the identity, not just the one acting, and the phone shows it as a notice
("Terminal opened on <machine> by <device>"). A phone that did not open a
terminal learns of it at once — the detection half of the allowlist.

## Audit

Kept on the bridge, under `<home>/audit/` (`0700`, files `0600`, like the
state file), never sent anywhere:

- **`terminal.jsonl`** — one line per event: opened (device id and name,
  identity, transport `direct`/`onion`/`relay`, cwd, what runs, size),
  attached, takeover, resized, closed, exited (reason, code, duration), and
  refused (why: disabled, not-allowed, limit, transport, bad seq). Each line
  carries `prev`, the SHA-256 of the line before it, so an edit or a deleted
  line breaks the chain (`codedeck-bridge audit verify` checks it). The honest
  limit: anyone running as the bridge's user can rewrite the whole file; the
  chain catches tampering that is not that thorough, and `audit.syslog: true`
  also copies each line to the system log (journald / syslog), which survives
  even that.
- **`term-<id>.cast`** — a full recording of each terminal in asciicast v2
  (replayable with `asciinema play`): every output frame, and every input
  chunk with the device that typed it. **Input typed while the terminal has
  echo off** — a password prompt — is recorded as `[input hidden: N bytes]`,
  never the bytes: the bridge reads the PTY's termios (`portable-pty`'s
  `MasterPty::get_termios`, the `ECHO` local flag) before recording each
  chunk. On Windows, where ConPTY exposes no echo state, input is recorded as
  byte counts only; what was typed still shows where the shell echoed it.
  A recording can contain secrets a command printed (`cat .env`): it is
  readable only by the bridge's user, and the owner chooses how long to keep
  it.
- **Retention**: `audit.maxDays` (default 90) and `audit.maxBytes` (default
  1 GiB); the oldest whole files go first. The log of who opened what is
  small and kept the longest.

## Lifetime

A terminal outlives a dropped connection — the point of a phone remote is
that the train goes into a tunnel. It ends when its shell exits, when its
writer closes it, when its device is withdrawn from the allowlist, or after
**1 h with no device attached** (`terminal.idleMinutes`, up to 24 h). At most
4 terminals per bridge; a fifth `terminal-open` is answered
`terminal-exited {reason: "limit"}`. A bridge restart ends them all (the
PTYs die with it), and each one's end is audited.

## Bridge

- `crates/bridge-core` routes the messages (paired identity, capability on,
  device allowed, transport allowed, the terminal exists, the sender is its
  writer, `seq` in order) and emits effects: spawn, write, resize, replay,
  close, audit. It holds no PTY and no file.
- `crates/bridge-runtime` owns the PTYs through the `portable-pty` crate
  (ConPTY on Windows, so the Windows bridge gets a real terminal too), the
  per-terminal output ring and offset, the flush timer per transport, the
  allowlist file and the audit files.

## Phone

- The emulator is Termux's `terminal-emulator` + `terminal-view`
  (Apache-2.0), hosted in Compose through `AndroidView`. It already handles
  VT100/xterm sequences, 256 colours, the alternate screen, selection and
  the IME.
- An extra-keys row above the keyboard (Esc, Ctrl, Alt, Tab, arrows, `|`,
  `~`, `/`), as in Termux — a phone keyboard has none of these.
- Reached from the machine's page (Terminal) and from a session's menu
  (Terminal here, opened in the session's directory). Running terminals show
  on the machine's page, with the device that opened each.
- A refused open shows the device's id and name and the command to run on
  the machine.
- Pinch zooms the font; the emulator's size follows the view and every
  change sends `terminal-resize`.
- Settings: "Require fingerprint for terminals" (off by default).

## Traffic and battery

Nothing is sent while no terminal is on screen: output goes only to devices
watching it, and an idle shell writes nothing. Typing costs one event per key a
program acts on or per pause (a command line with a completion is two or
three events, not thirty), output one per flush (at most ~60/s on the
direct link, 10/s on relays, usually far fewer); each is signed by the
identity and NIP-44 encrypted like every message. The audit costs only disk
on the bridge. `terminal-event` is one small message per open, attach,
takeover or close, to each present device.

## Order

1. Protocol: the messages, the capability, the live kind from the phone,
   the device label on the session-key grant, fixtures in the corpus.
2. Bridge: config, device ids and the allowlist with its CLI, core routing
   (gates, writer, `seq`), runtime PTYs, ring and flushing, the audit files
   and `audit verify`; an end-to-end test drives a terminal through the
   bridge (`echo` round trip, resize, replay after a gap, a replayed input
   dropped, a withdrawn device's terminal closed).
3. Phone: client-core terminal state and offsets, the FFI surface, the
   screen, the refusal and the notices, the fingerprint setting.
