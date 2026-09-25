package com.codedeck.plus.ui.transcript.rows

import uniffi.client_ffi.UniffiIntent

/**
 * A card builds the exact `UniffiIntent` and hands it to this — mirrors
 * `apps/mobile/src/ui/transcript/rows/types.ts`'s `CardActions.sendCommand`.
 * No `markResponded`/`setPlanChoice` local-store callbacks the way the TS
 * interface had: `RespondPermission`/`AnswerQuestion`/`Keypress` already
 * update `ui.responded_cards` server-side inside `Intent::apply` (see
 * `crates/client-ffi/src/intent.rs`'s doc comment), and
 * `SetPlanApprovalChoice` is itself just another `UniffiIntent` a card
 * dispatches alongside its answer — there is nothing left for a second
 * callback to do.
 */
typealias CardActions = (UniffiIntent) -> Unit
