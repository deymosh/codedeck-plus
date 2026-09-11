# `@codedeck/contract-harness`

A standalone process that runs one real `BridgeCore` (from `@codedeck/core`)
behind a scriptable `FakeSdkFacade` (from `@codedeck/testkit`), fronted by a
real `ws://127.0.0.1:<port>` relay. It exists so a client that is **not**
JavaScript — the Rust `client-runtime`, today; any future native client —
can be tested against the real bridge protocol over a genuine socket,
without a language-specific FFI shim. See the migration plan §4 "Layer 2".

This is a devtool: it is never published, never shipped, and carries no
production code path. `packages/testkit` stays a pure library; this package
is the "spawn it as a subprocess and drive it" layer around it.

## What's inside

- `relayServer.ts` — a thin `ws://` wire adapter over
  `@codedeck/testkit`'s `InMemoryRelay`. Speaks `REQ`/`CLOSE`/`EVENT` in,
  `EVENT`/`EOSE`/`OK` out. No NIP-42 challenge is ever issued.
- `harness.ts` — the "world": one `BridgeCore` + `FakeSdkFacade` + relay
  server, in a throwaway temp `sessionStateDir`. `restart()` shuts the
  current `BridgeCore` down and starts a fresh one with the same identity,
  storage, and state directory — a real bridge-process restart, not a reset.
- `control.ts` — pure request → response dispatch over a `Harness` (no
  process I/O — unit-testable on its own).
- `main.ts` — the process entry point: starts a harness, then reads
  newline-delimited JSON commands from stdin and writes newline-delimited
  JSON responses to stdout.

## Running it

```bash
node out/main.js [--port=<port>]   # 0 (default) asks the OS for a free port
```

The first line on stdout is always:

```json
{"type":"ready","wsUrl":"ws://127.0.0.1:54321","pid":12345}
```

A driver must wait for this line before doing anything else — the relay
socket is not listening until it's printed.

## Control protocol

One JSON object per line, both directions. Every request carries an `id`
(any string the driver chooses); the matching response echoes it back, so
responses may be correlated even if a future version answers out of order.

**Request → response**, one pair per command:

| `cmd` | Request fields | `result` on success |
|---|---|---|
| `get-relay-url` | — | `{ url }` — same as the `ready` line's `wsUrl`. |
| `open-pairing-window` | `opts?` (`PairingWindowOptions`, minus the callbacks — see below) | `{ url, displayUrl, token, expiresAt }` — `expiresAt` is an ISO-8601 string. |
| `emit-sdk-message` | `sessionId`, `message` (an `SdkMessage`) | `null`. Pushes `message` into that session's stream, as if the Claude Code subprocess had emitted it. The session must already exist (created via a real phone `create-session` command over the socket) or this throws. |
| `list-sdk-sessions` | — | An array of session ids, in creation order — the same ids the phone sees on the wire. A driver that just sent `create-session` can safely take the last one. |
| `get-bridge-transcript` | `sessionId` | An array of `{ seq, entry }` — every row the bridge has stored for that session, in order. `[]` for an unknown session. |
| `restart-bridge` | — | `null`. Shuts the current `BridgeCore` down and starts a fresh one — same secret key, same storage, same on-disk transcripts, but a FRESH `FakeSdkFacade` (a real bridge restart kills the underlying Claude Code subprocess too). `BridgeCore`'s own resume-on-boot re-spawns any still-tracked session under the same id on the new facade. The relay server and its socket are untouched, so a connected client sees a real disconnect/reconnect, not a torn-down world. |
| `drain-logs` | — | An array of `{ level, message }` — every host log line since the last drain (own or the previous command's). Logs are queued regardless of whether anything reads them. |
| `shutdown` | — | `null`, then the process exits. Also triggered by stdin closing (the driver process died) — the harness never lingers as an orphan. |

`PairingWindowOptions` here omits `onPaired`/`onClosed` (they're callbacks —
meaningless across a process boundary); a driver that needs to know when a
phone paired should poll `drain-logs` or simply proceed once its own
`pair-ack` arrives on the socket.

**On error**, any command instead answers `{ id, ok: false, error }` (a
string) rather than throwing across the boundary. A response for a request
that failed to parse as JSON at all answers with `id: "unknown"`.

## Driving a scenario (sketch)

1. Spawn the process, read the `ready` line for `wsUrl`.
2. Point a client (Rust `client-runtime`, or a TS test) at `wsUrl` as its
   relay.
3. Send `open-pairing-window`; feed the returned `url` to the client's
   pairing intent.
4. Drive the client to create a session (a real `create-session` phone
   command over the socket — the harness does not fabricate sessions).
5. `emit-sdk-message` to script the fake subprocess's output; assert on
   what the client observes.
6. `get-bridge-transcript` to compare the bridge's own record against the
   client's.
7. `restart-bridge`; assert the client's reconnect + sync-gap-refill path.
8. `shutdown` when done.

This is scenario A of the migration plan's Layer 2 gate (pair → session in a
folder → live output lands in the transcript → input reaches confirmed →
bridge restart → reconnect → refresh + sync gap-refill → contiguous
transcript identical to the bridge's own).
