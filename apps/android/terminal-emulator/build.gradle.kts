// Vendored Termux terminal emulator (Apache-2.0). The sources under
// src/main/java are a verbatim copy of termux/termux-app's terminal-emulator
// module except where terminal-view/README.md lists a local change; the
// module shape follows apps/android/app/build.gradle.kts so it shares the
// version catalog's AGP/compileSdk/minSdk. Upstream built it with the NDK
// for a local pseudoterminal; this copy has no native code and no local
// process.
plugins {
    alias(libs.plugins.android.library)
}

android {
    namespace = "com.termux.terminal"
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

    testOptions {
        unitTests {
            // Same reason as the app module: a JVM test that reaches
            // android.util.Log (Logger falls back to it with a null client)
            // would otherwise throw "Method ... not mocked".
            isReturnDefaultValues = true
        }
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = true
    }
}

dependencies {
    testImplementation(libs.junit)
}
