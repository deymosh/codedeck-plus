// Root build.gradle.kts — plugins declared here (apply false) so :app can
// apply them without repeating a version. Mirrors the shape a plain
// (non-KMP, single-module) Compose Android app uses — see
// gradle/libs.versions.toml's own comment for why this repo's version
// choices are what they are.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.paparazzi) apply false
}
