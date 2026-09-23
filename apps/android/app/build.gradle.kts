plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.paparazzi)
}

android {
    namespace = "com.codedeck.plus"
    // AGP 9's platform DSL — Android 17 (API 37) ships minor platform
    // revisions (37.0/37.1/37.2/…) rather than one fixed "android-37" SDK;
    // `release(37)` resolves to the latest stable minor under that major
    // version instead of pinning one that will age out of `sdkmanager`.
    compileSdk {
        version = release(37)
    }

    defaultConfig {
        // Deliberately DIFFERENT from apps/mobile/src-tauri's applicationId
        // (com.codedeck.plus) while this app is still catching up to feature
        // parity: installing this one must not replace or lose the Tauri
        // app's local state on a test device. The plan's F3 "Convivencia"
        // note originally called for the SAME applicationId so an eventual
        // F5 cutover would be a plain swap — revert to "com.codedeck.plus"
        // (and drop this note) only once this app is actually finished and
        // ready to replace the Tauri one. `namespace` above stays
        // com.codedeck.plus on purpose — it only affects the generated R
        // class / Kotlin package, not app identity, so it doesn't need to
        // track this.
        applicationId = "com.codedeck.native"
        // 26, not apps/mobile's 24: the JNA runtime uniffi-bindgen's
        // generated Kotlin depends on uses MethodHandle.invoke/invokeExact,
        // unsupported by D8 below API 26 (confirmed by a failed dex build at
        // 24 — "Increase the minSdkVersion to 26 or above").
        minSdk {
            version = release(26)
        }
        targetSdk {
            version = release(37)
        }
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        // Release-shaped (R8 minified/optimized, isDebuggable = false) but
        // debug-keystore signed so it installs via `adb install` like any dev
        // build — for local device performance comparisons only, never for
        // distribution. Mirrors apps/mobile's own `./codedeck apk benchmark`.
        create("benchmark") {
            initWith(getByName("release"))
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += listOf("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        unitTests {
            // Without this, any unit-tested code path calling an unstubbed
            // android.util.Log method throws "Method ... not mocked" — no
            // Robolectric/Mockito-static dependency stubs it per-test, so
            // returning Android's default value instead of throwing is what
            // lets a class that logs still be exercised by a plain JVM test.
            isReturnDefaultValues = true
        }
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    // ProcessLifecycleOwner — app-level foreground/background ("is ANY activity
    // visible"), not a per-Activity signal; StayConnectedService drives
    // CoreBridge.pause()/resume() from it.
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.bundles.compose)
    // Chrome/composer icons (mic, attach, pair, settings, menu, close). The
    // full extended set is large, but release builds R8-minify (above) and
    // drop every unused icon; debug builds simply carry the dead weight.
    implementation("androidx.compose.material:material-icons-extended")
    implementation(libs.kotlinx.coroutines.android)
    // JNA: the FFI bridge uniffi-bindgen's generated Kotlin uses to call into
    // crates/uniffi-bridge's cdylib. Version pinned loosely on purpose — this
    // is exactly the dependency the generated bindings file itself declares
    // as a prerequisite; keep it in step with whatever `uniffi` crate version
    // crates/uniffi-bridge/Cargo.toml pins (currently 0.28).
    implementation("net.java.dev.jna:jna:5.19.0@aar")

    // Tink directly, not its deprecated androidx.security:security-crypto
    // wrapper (frozen at 1.1.0-alpha07): platform/SecureIdentityStore.kt
    // uses AndroidKeysetManager to keep the persisted bridge identity
    // secret encrypted at rest under a Keystore-held master key.
    implementation("com.google.crypto.tink:tink-android:1.19.0")

    // Pairing-QR camera scan (ui/screens/PairingScanView.kt): CameraX for the
    // preview/analysis pipeline, ML Kit's BUNDLED barcode model (no Play
    // Services needed at runtime) restricted to QR by its scanner options.
    // Neither library is covered by the Compose BOM, so they are pinned
    // explicitly; release R8 strips the parts and model weight the scan
    // surface doesn't touch, debug builds just carry them (same trade as the
    // icons dependency above).
    val camerax = "1.6.2"
    implementation("androidx.camera:camera-camera2:$camerax")
    implementation("androidx.camera:camera-lifecycle:$camerax")
    implementation("androidx.camera:camera-view:$camerax")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")

    // F3.3.2: Compose-native Markdown for assistant/plan transcript rows.
    // GFM (tables, task lists, strikethrough, autolinks) is the renderer's
    // own default AST handling, no separate "GFM module" — see
    // ui/transcript/Markdown.kt's doc comment.
    implementation(libs.markdown.renderer)
    implementation(libs.markdown.renderer.m3)
    implementation(libs.kotlinx.serialization.json)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    debugImplementation(libs.androidx.ui.tooling)
}
