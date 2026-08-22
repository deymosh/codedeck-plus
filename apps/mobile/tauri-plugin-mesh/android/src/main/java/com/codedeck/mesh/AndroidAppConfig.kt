package com.codedeck.mesh

import android.content.Context
import android.os.Build
import java.io.File

internal fun appCoreDataDir(context: Context): File =
    context.filesDir.resolve("app-core")

internal fun seedMobileConfig(dataDir: File, deviceName: String = androidDeviceName()) {
    val name = deviceName.trim()
    if (name.isEmpty()) return
    val config = dataDir.resolve("config.toml")
    if (config.exists()) return

    runCatching {
        dataDir.mkdirs()
        config.writeText("node_name = \"${tomlString(name)}\"\n")
    }
}

private fun androidDeviceName(): String {
    val manufacturer = Build.MANUFACTURER.orEmpty().trim()
    val model = Build.MODEL.orEmpty().trim()
    val prefix = titlecaseAscii(manufacturer)
    return when {
        model.isEmpty() -> prefix
        prefix.isEmpty() -> model
        model.startsWith(manufacturer, ignoreCase = true) -> model
        else -> "$prefix $model"
    }.ifBlank { "Android device" }
}

private fun titlecaseAscii(value: String): String =
    when {
        value.isEmpty() -> ""
        else -> value.take(1).uppercase() + value.drop(1)
    }

private fun tomlString(value: String): String =
    value.replace("\\", "\\\\").replace("\"", "\\\"")
