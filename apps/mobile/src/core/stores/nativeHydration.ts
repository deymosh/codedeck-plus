/**
 * The hydration sequence every native-core store adapter uses: register the
 * live-update listener, THEN pull the initial snapshot — never
 * concurrently.
 *
 * Rust only re-announces state on an actual transition (see
 * `client_runtime::Core::dispatch`'s own doc comment on `connection_status`/
 * `*_view`: "a fresh read for a UI that just attached — the observer only
 * reports changes"). It never replays history for a listener that attaches
 * late, and Tauri's `listen()` has no buffering: an event emitted before a
 * listener finishes attaching is lost for good.
 *
 * On an ordinary app reopen against an already-connected, already-populated
 * core (the singleton `CoreBridge` — built once in `lib.rs`'s `run()` — is
 * designed to outlive a WebView reload, and `core_init` is explicitly
 * idempotent), nothing is about to transition again soon. That makes the
 * one-shot snapshot fetch the ONLY chance to observe the real state — firing
 * it unawaited alongside listener registration left the two racing with no
 * guaranteed order, and a lost race (or a swallowed rejection) stranded the
 * store at its construction-time default forever. This is the root cause
 * behind the connection dot staying stale, and a bridge-confirmed session
 * not appearing, after closing and reopening the app.
 *
 * Awaiting registration first closes the gap completely: once it resolves,
 * any transition from that point on is guaranteed to arrive over the
 * listener, and the fetch that follows reads whatever is true at that
 * instant — no version/generation counter needed.
 */
export async function hydrateFromCore(
  registerListener: () => Promise<unknown>,
  fetchSnapshot: () => Promise<void>,
  tag: string,
  log?: (msg: string) => void,
): Promise<void> {
  try {
    await registerListener();
  } catch (err) {
    log?.(`[${tag}] listener registration failed — live updates will not arrive: ${err}`);
  }
  try {
    await fetchSnapshot();
  } catch (err) {
    log?.(`[${tag}] initial snapshot fetch failed: ${err}`);
  }
}
