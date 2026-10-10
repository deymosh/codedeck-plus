# The former Tauri app (frozen)

> **Frozen.** This app stays on protocol v10: it does not talk to a v11
> bridge, and it is outside the pnpm workspace, CI and releases. The phone
> client is the native app in [`apps/android`](../android). These sources are
> kept as the starting point for a future desktop client.

It is the Tauri v2 shell CodeDeck+ started from: a React + TypeScript webview
over a small Rust host, with its own TypeScript port of the phone's core
(stores, connection state machine, relay client, crypto) speaking the v10
wire. The `RELEASE_NOTES_0.9.*.md` files are that era's notes.

## Layout

```
src/core/       stores, connection FSM, bridge API, Nostr client, crypto (v10)
src/ui/         screens, components, transcript renderers
src/platform/   Tauri seams, each guarded with a browser fallback
src-tauri/      the Rust host and its tauri-plugin-* crates (Rust + Kotlin)
```

## Reviving it as a desktop client

The phone's logic now lives in Rust (`crates/client-core`,
`crates/client-runtime`), shared by any client, so a desktop client should
not revive `src/core/`: its Tauri host would hold a `client_runtime::Core`
(see [`docs/CLIENT.md`](../../docs/CLIENT.md)) and the webview would render
its views and dispatch its intents, as the Android app does through
`crates/client-ffi`. What carries over from here is the UI and the platform
seams.

## License

MIT. A community continuation of CodeDeck Next by
[JeroenOnNostr](https://github.com/JeroenOnNostr) — original MIT license and
attribution preserved.
