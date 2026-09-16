package com.codedeck.plus.ui.transcript

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/**
 * Loose accessors over `OutputEntry.metadata` — genuinely untyped
 * bridge-supplied JSON (see `DisplayEntries.kt`'s doc comment), read the
 * same loose way the TS renderer reads `entry.metadata?.tool_use_id`. Most
 * of what a card needs is already a typed field on its `DisplayEntry`
 * variant (server-computed) rather than metadata a row has to dig for —
 * these exist for the handful of fields that aren't (`tool_input`,
 * `redacted`, the error-row `special` label).
 */
fun JsonObject?.metaStr(key: String): String? =
    (this?.get(key) as? JsonPrimitive)?.contentOrNull

fun JsonObject?.metaBool(key: String): Boolean? =
    (this?.get(key) as? JsonPrimitive)?.booleanOrNull

fun JsonObject?.metaObj(key: String): JsonObject? = this?.get(key) as? JsonObject
