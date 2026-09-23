package com.codedeck.plus.ui

import uniffi.client_ffi.UniffiMachineSummary
import uniffi.client_ffi.UniffiSessionSummary

/**
 * Shared sidebar ⇄ swipe-carousel session ordering — port of
 * `apps/mobile/src/ui/getOrderedSessionKeys.ts`. The carousel navigates the
 * EXACT list the sidebar displays, so both consumers import these functions
 * and the two orders can never diverge by construction.
 *
 * The Rust side hands machines/sessions over in `BTreeMap` key order
 * (pubkey / session id), which is stable but not human-meaningful — the
 * mobile reference deliberately re-orders them here instead:
 * - machines by name asc (ties broken by pubkey for stability)
 * - per machine, sessions by `lastActivity` desc
 * - pending sessions excluded structurally (they live in the pending-sessions
 *   view, never in a machine's session list).
 */

/** Canonical machine+session pair — also the carousel's navigation stop. */
data class SessionKey(val machine: String, val sessionId: String)

/** The `"$machine $sessionId"` session key — the same format the Rust
 *  `session_key_of` helper emits for `ui.respondedCards` / `unreadSessions`
 *  entries (see `SessionScreen.kt`'s `respondedCards` lookup). */
fun sessionKeyOf(machine: String, sessionId: String): String = "$machine $sessionId"

/** Machine display order — name asc, ties broken by pubkey. */
fun orderedMachines(machines: List<UniffiMachineSummary>): List<UniffiMachineSummary> =
    machines.sortedWith(compareBy({ it.name }, { it.pubkeyHex }))

/** Per-machine session display order — `lastActivity` desc. */
fun orderedSessions(sessions: List<UniffiSessionSummary>): List<UniffiSessionSummary> =
    sessions.sortedByDescending { it.lastActivity }

/** Flat session keys in the sidebar's visual order. */
fun getOrderedSessionKeys(machines: List<UniffiMachineSummary>): List<SessionKey> =
    orderedMachines(machines).flatMap { machine ->
        orderedSessions(machine.sessions).map { session ->
            SessionKey(machine.pubkeyHex, session.id)
        }
    }
