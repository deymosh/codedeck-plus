package com.codedeck.plus.ui.transcript

/**
 * A fixed corpus of the markdown shapes CodeDeck's transcript actually
 * renders, distilled from `apps/mobile/src/ui/transcript/displayEntries.ts`
 * and `rows/Markdown.tsx`'s pipeline (`react-markdown` + `remark-gfm` +
 * `rehype-highlight`). Ported near-verbatim from
 * `spike/markdown-compose-probe/ui/src/main/kotlin/probe/Corpus.kt` — the
 * one place that spike's findings are exercised for real, in the app the
 * verdict was about.
 */
object MarkdownCorpus {
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

        ```diff
        - const sk = SecretKey::from_hex(&hex)?;
        + let sk = SecretKey::from_hex(&hex).map_err(bad_key)?;
        ```
    """.trimIndent()

    val USER_MESSAGE = "port the connection reducer to rust, keep the jitter injected"
}
