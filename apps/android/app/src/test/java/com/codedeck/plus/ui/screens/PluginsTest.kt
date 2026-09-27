package com.codedeck.plus.ui.screens

import org.junit.Assert.assertEquals
import org.junit.Test
import uniffi.client_ffi.UniffiAvailablePlugin
import uniffi.client_ffi.UniffiPluginFailure

/** What the plugins page lists when searching, and how it words a failure. */
class PluginsTest {
    private fun offer(name: String, description: String?, installs: ULong?) =
        UniffiAvailablePlugin("$name@m", name, "m", description, installs)

    @Test
    fun theCatalogIsSearchedByNameAndDescriptionMostInstalledFirst() {
        val all = listOf(
            offer("lint", "Keeps code tidy", 10uL),
            offer("review", "Code review for pull requests", 500uL),
            offer("docs", null, null),
            offer("code-intel", "Symbol search", 20uL),
        )
        assertEquals(listOf("review", "code-intel", "lint", "docs"), browseResults(all, "").map { it.name })
        assertEquals(listOf("review", "code-intel", "lint"), browseResults(all, " CODE ").map { it.name })
    }

    @Test
    fun aFailureSaysWhatWasTriedOnWhatAndWhy() {
        assertEquals(
            "Could not install x@m: not found",
            failureLine(UniffiPluginFailure("install", "x@m", "not found")),
        )
        assertEquals(
            "Could not add the marketplace me/skills: repository not found",
            failureLine(UniffiPluginFailure("add-marketplace", "me/skills", "repository not found")),
        )
    }
}
