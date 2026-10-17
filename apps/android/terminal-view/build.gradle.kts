// Vendored Termux terminal view (Apache-2.0). The sources under src/main are
// a verbatim copy of termux/termux-app's terminal-view module except where
// terminal-view/README.md lists a local change; the module shape follows
// apps/android/app/build.gradle.kts so it shares the version catalog's
// AGP/compileSdk/minSdk.
plugins {
    alias(libs.plugins.android.library)
}

android {
    namespace = "com.termux.view"
    compileSdk {
        version = release(37)
    }

    defaultConfig {
        minSdk {
            version = release(26)
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = true
    }
}

dependencies {
    // The view draws an emulator buffer and drives a session, both from the
    // emulator module, so callers of this module see those types too (api,
    // not implementation, as upstream had it).
    api(project(":terminal-emulator"))
    implementation(libs.androidx.annotation)
}
