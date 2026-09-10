// THROWAWAY F0 spike. Runs the UniFFI-generated Kotlin bindings through the real
// FFI (JNA) against the Rust cdylib in ./lib, to judge Compose-side ergonomics.

plugins {
    kotlin("jvm") version "2.1.0"
}

repositories { mavenCentral() }

dependencies {
    // What the generated bindings import.
    implementation("net.java.dev.jna:jna:5.15.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")

    testImplementation(kotlin("test"))
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}

sourceSets {
    // the uniffi-bindgen output, package `uniffi.client_core_probe`
    main { kotlin.srcDir("bindings") }
}

kotlin {
    jvmToolchain(17)
    compilerOptions {
        freeCompilerArgs.addAll(
            "-opt-in=kotlin.RequiresOptIn",
            "-opt-in=kotlinx.coroutines.DelicateCoroutinesApi",
        )
    }
}

tasks.test {
    useJUnitPlatform()
    // JNA resolves `client_core_probe` -> lib/libclient_core_probe.so
    systemProperty("jna.library.path", file("lib").absolutePath)
    testLogging {
        events("passed", "failed", "skipped")
        showStandardStreams = true
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
