package probe

/** A fixed corpus of the transcript shapes CodeDeck renders today, distilled
 *  from `apps/mobile/src/ui/transcript/displayEntries.ts`. */
object Corpus {

    /** One assistant message exercising every GFM feature the React stack
     *  (`react-markdown` + `remark-gfm` + `rehype-highlight`) handles. */
    val ASSISTANT_MARKDOWN = """
        ## Refactor plan

        Here's what I'll do, in order:

        1. Extract the reducer
        2. Wire the effects interpreter
           - keep the jitter source injected
           - `backoffDelayMs(attempt)` stays pure
        3. Port the tests

        - [x] audit `ports.ts`
        - [ ] move `crypto.ts`
        - [ ] delete the TS path

        | module | destination | risk |
        |---|---|---|
        | `connection.ts` | `core::connection` | low |
        | `bridgeApi.ts` | `core::bridge_api` | medium |
        | `marmot.rs` | `core::marmot` (feature) | build |

        > Absence never deletes — a stale session is marked, not dropped.

        Inline: call `mergeSessionList()` and check `seqHigh`. See
        [the contract](https://example.com/protocol).

        ```bash
        ./codedeck check && git commit -m "port connection reducer"
        ```

        ```typescript
        export function connectionReducer(
          state: ConnectionState,
          event: ConnectionEvent,
        ): ReducerResult {
          switch (event.type) {
            case 'socket-close':
              return { state: { ...state, status: 'waiting-retry' }, effects: [] }
          }
        }
        ```

        ```rust
        #[uniffi::export(with_foreign)]
        pub trait CoreListener: Send + Sync {
            fn on_event(&self, event: CoreEvent);
        }
        ```

        ```json
        { "kinds": [30515], "authors": ["aa"], "#p": ["bb"] }
        ```

        ```diff
        - const sk = SecretKey::from_hex(&hex)?;
        + let sk = SecretKey::from_hex(&hex).map_err(bad_key)?;
        ```
    """.trimIndent()

    val USER_MESSAGE = "port the connection reducer to rust, keep the jitter injected"

    data class DiffLine(val kind: Char, val text: String) // ' ' '+' '-'

    val DIFF_FILE = "packages/core/src/nostr/pool.ts"
    val DIFF_LINES = listOf(
        DiffLine(' ', "  const pool = new SimplePool();"),
        DiffLine('-', "  pool.trackRelays = true;"),
        DiffLine('+', "  pool.trackRelays = true;"),
        DiffLine('+', "  pool.idleTimeout = 0x7fffffff; // CDX-020"),
        DiffLine(' ', "  return pool;"),
    )

    val TOOL_GROUP = listOf("Read pool.ts", "Edit pool.ts", "Bash: ./codedeck check")
}
