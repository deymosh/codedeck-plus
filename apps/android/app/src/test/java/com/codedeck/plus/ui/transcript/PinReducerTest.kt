package com.codedeck.plus.ui.transcript

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Exhaustive `pinReducer` tests — direct port of
 * `apps/mobile/src/ui/transcript/__tests__/pinReducer.test.ts`, including
 * the property-style storms (same mulberry32 PRNG, same seeds, same
 * invariants) so a failure here is reproducible against the TS suite's own
 * failure by seed number.
 */
class PinReducerTest {

    private fun run(events: List<PinEvent>, from: PinState = initialPinState): PinState =
        events.fold(from, ::pinReducer)

    // --- basics ---------------------------------------------------------

    @Test
    fun starts_pinned_at_bottom() {
        assertTrue(initialPinState.pinned)
        assertTrue(initialPinState.atBottom)
        assertEquals(0, initialPinState.missedEntries)
    }

    @Test
    fun unflagged_scroll_away_from_bottom_unpins() {
        val s = run(listOf(PinEvent.UserScroll(atBottom = false)))
        assertEquals(false, s.pinned)
        assertEquals(false, s.atBottom)
    }

    @Test
    fun unflagged_scroll_landing_on_the_bottom_re_pins_and_clears_missed_count() {
        val s = run(
            listOf(
                PinEvent.UserScroll(atBottom = false),
                PinEvent.NewEntries(3),
                PinEvent.UserScroll(atBottom = true),
            ),
        )
        assertTrue(s.pinned)
        assertEquals(0, s.missedEntries)
    }

    @Test
    fun reached_bottom_pins_regardless_of_how_the_viewport_got_there() {
        val s = run(
            listOf(
                PinEvent.UserScroll(atBottom = false),
                PinEvent.NewEntries(5),
                PinEvent.ReachedBottom,
            ),
        )
        assertTrue(s.pinned)
        assertTrue(s.atBottom)
        assertEquals(0, s.missedEntries)
    }

    @Test
    fun left_bottom_alone_never_unpins() {
        val s = run(listOf(PinEvent.LeftBottom))
        assertTrue(s.pinned)
        assertEquals(false, s.atBottom)
    }

    @Test
    fun session_switch_resets_to_pinned_but_not_at_bottom_from_any_state_cdx_024() {
        val s = run(
            listOf(
                PinEvent.UserScroll(atBottom = false),
                PinEvent.NewEntries(9),
                PinEvent.ProgrammaticScrollStart,
                PinEvent.SessionSwitch,
            ),
        )
        assertEquals(initialPinState.copy(atBottom = false), s)
    }

    // --- programmatic-scroll flagging ------------------------------------

    @Test
    fun flagged_scrolls_never_unpin() {
        val s = run(
            listOf(
                PinEvent.ProgrammaticScrollStart,
                PinEvent.UserScroll(atBottom = false),
                PinEvent.UserScroll(atBottom = true),
                PinEvent.ProgrammaticScrollEnd,
            ),
        )
        assertTrue(s.pinned)
    }

    @Test
    fun an_unflagged_scroll_after_the_window_closes_unpins_normally() {
        val s = run(
            listOf(
                PinEvent.ProgrammaticScrollStart,
                PinEvent.UserScroll(atBottom = true),
                PinEvent.ProgrammaticScrollEnd,
                PinEvent.UserScroll(atBottom = false),
            ),
        )
        assertEquals(false, s.pinned)
    }

    @Test
    fun nested_flags_still_flagged_until_every_start_is_ended() {
        val mid = run(
            listOf(
                PinEvent.ProgrammaticScrollStart,
                PinEvent.ProgrammaticScrollStart,
                PinEvent.ProgrammaticScrollEnd,
            ),
        )
        assertEquals(1, mid.programmaticDepth)
        val s = pinReducer(mid, PinEvent.UserScroll(atBottom = false))
        assertTrue(s.pinned) // still flagged
    }

    @Test
    fun programmatic_depth_clamps_at_0_on_stray_ends() {
        val s = run(listOf(PinEvent.ProgrammaticScrollEnd, PinEvent.ProgrammaticScrollEnd))
        assertEquals(0, s.programmaticDepth)
        assertEquals(false, pinReducer(s, PinEvent.UserScroll(atBottom = false)).pinned)
    }

    @Test
    fun flagged_scroll_to_bottom_while_pinned_keeps_missed_count_at_0() {
        val s = run(
            listOf(
                PinEvent.ProgrammaticScrollStart,
                PinEvent.UserScroll(atBottom = true),
                PinEvent.ProgrammaticScrollEnd,
            ),
        )
        assertEquals(0, s.missedEntries)
        assertTrue(s.atBottom)
    }

    // --- new entries ------------------------------------------------------

    @Test
    fun new_entries_never_changes_pinned() {
        assertTrue(run(listOf(PinEvent.NewEntries(4))).pinned)
        val unpinned = run(listOf(PinEvent.UserScroll(atBottom = false), PinEvent.NewEntries(4)))
        assertEquals(false, unpinned.pinned)
    }

    @Test
    fun new_entries_counts_missed_only_while_unpinned() {
        val pinnedState = run(listOf(PinEvent.NewEntries(4)))
        assertEquals(0, pinnedState.missedEntries)

        val s = run(
            listOf(
                PinEvent.UserScroll(atBottom = false),
                PinEvent.NewEntries(4),
                PinEvent.NewEntries(2),
            ),
        )
        assertEquals(6, s.missedEntries)
    }

    @Test
    fun new_entries_negative_counts_are_ignored() {
        val s = run(listOf(PinEvent.UserScroll(atBottom = false), PinEvent.NewEntries(-5)))
        assertEquals(0, s.missedEntries)
    }

    // --- property-style storms --------------------------------------------

    /** `Math.imul`-equivalent: Kotlin `Int * Int` already wraps to the low 32
     *  bits the same way, so this is only here to name the operation. */
    private fun imul(a: Int, b: Int): Int = a * b

    /** Deterministic PRNG (mulberry32) — same algorithm and seeds as
     *  `pinReducer.test.ts`'s own `rng()`, so a failure here reproduces
     *  against the TS suite's failure by seed number. Kotlin `Int` wraps on
     *  overflow the same way JS's `| 0` truncation does for this algorithm. */
    private fun mulberry32(seed: Int): () -> Double {
        var a = seed
        return {
            a += 0x6d2b79f5
            var t = a
            t = imul(t xor (t ushr 15), 1 or t)
            t = (t + imul(t xor (t ushr 7), 61 or t)) xor t
            ((t xor (t ushr 14)).toLong() and 0xFFFFFFFFL).toDouble() / 4294967296.0
        }
    }

    /** Cross-checks the Kotlin mulberry32 port against Node's own JS
     *  reference sequence (computed once, offline, from the exact algorithm
     *  `pinReducer.test.ts`'s `rng()` uses) — the storm tests below are only
     *  as reproducible-by-seed against the TS suite as this PRNG is faithful. */
    @Test
    fun mulberry32_matches_the_javascript_reference_sequence() {
        val seed1 = mulberry32(1)
        assertEquals(0.6270739405881613, seed1(), 1e-15)
        assertEquals(0.002735721180215478, seed1(), 1e-15)
        assertEquals(0.5274470399599522, seed1(), 1e-15)
        assertEquals(0.9810509674716741, seed1(), 1e-15)
        assertEquals(0.9683778982143849, seed1(), 1e-15)

        val seed2 = mulberry32(2)
        assertEquals(0.7342509443406016, seed2(), 1e-15)
        assertEquals(0.32499843230471015, seed2(), 1e-15)
        assertEquals(0.28529605525545776, seed2(), 1e-15)
        assertEquals(0.5379551574587822, seed2(), 1e-15)
        assertEquals(0.8752879470121115, seed2(), 1e-15)
    }

    private fun randomEvent(rand: () -> Double): PinEvent {
        val roll = rand()
        return when {
            roll < 0.35 -> PinEvent.UserScroll(atBottom = rand() < 0.4)
            roll < 0.5 -> PinEvent.NewEntries(1 + (rand() * 5).toInt())
            roll < 0.62 -> PinEvent.ProgrammaticScrollStart
            roll < 0.74 -> PinEvent.ProgrammaticScrollEnd
            roll < 0.84 -> PinEvent.ReachedBottom
            roll < 0.94 -> PinEvent.LeftBottom
            else -> PinEvent.SessionSwitch
        }
    }

    @Test
    fun holds_every_invariant_across_200_seeded_random_storms_of_300_events() {
        for (seed in 1..200) {
            val rand = mulberry32(seed)
            var state = initialPinState
            for (i in 0 until 300) {
                val event = randomEvent(rand)
                val before = state
                state = pinReducer(state, event)
                val ctx = "seed $seed step $i event $event"

                assertTrue(ctx, state.programmaticDepth >= 0)
                assertTrue(ctx, state.missedEntries >= 0)

                // Invariant 1: an unflagged user scroll away from bottom always unpins.
                if (event is PinEvent.UserScroll && !event.atBottom && before.programmaticDepth == 0) {
                    assertEquals(ctx, false, state.pinned)
                }
                // Invariant 2: reaching the bottom always pins + clears missed.
                val reachedBottom = event is PinEvent.ReachedBottom ||
                    (event is PinEvent.UserScroll && event.atBottom && before.programmaticDepth == 0)
                if (reachedBottom) {
                    assertEquals(ctx, true, state.pinned)
                    assertEquals(ctx, 0, state.missedEntries)
                }
                // Invariant 3: session-switch fully resets.
                if (event is PinEvent.SessionSwitch) {
                    assertEquals(ctx, initialPinState.copy(atBottom = false), state)
                }
                // Invariant 4: new-entries never flips pinned; while unpinned it
                // only ever changes missedEntries.
                if (event is PinEvent.NewEntries) {
                    assertEquals(ctx, before.pinned, state.pinned)
                    if (!before.pinned) {
                        assertEquals(ctx, before.copy(missedEntries = 0), state.copy(missedEntries = 0))
                    }
                }
                // Invariant 5: flagged scrolls never unpin.
                if (event is PinEvent.UserScroll && before.programmaticDepth > 0) {
                    assertEquals(ctx, before.pinned, state.pinned)
                }
                // Global: pinned may only become false via an unflagged user scroll.
                if (!before.pinned || state.pinned || event is PinEvent.SessionSwitch) continue
                assertTrue(ctx, event is PinEvent.UserScroll)
                assertEquals(ctx, 0, before.programmaticDepth)
            }
        }
    }

    @Test
    fun interleaved_programmatic_windows_and_user_flings_converge_to_the_geometry() {
        for (seed in 300 until 340) {
            val rand = mulberry32(seed)
            var state = initialPinState
            repeat(100) { state = pinReducer(state, randomEvent(rand)) }
            while (state.programmaticDepth > 0) state = pinReducer(state, PinEvent.ProgrammaticScrollEnd)
            state = pinReducer(state, PinEvent.UserScroll(atBottom = true))
            assertTrue(state.pinned)
            assertEquals(0, state.missedEntries)
            state = pinReducer(state, PinEvent.UserScroll(atBottom = false))
            assertEquals(false, state.pinned)
        }
    }
}
