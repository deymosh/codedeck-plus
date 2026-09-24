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
        // The same identity the frozen Tauri app (apps/mobile) shipped under,
        // so a signed release installs over it as an upgrade.
        applicationId = "com.codedeck.plus"
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
        // A release stamps its version from the tag (`-PcodedeckVersion=1.2.3`,
        // or `1.2.3-rc1` for a prerelease). The code keeps the Tauri app's
        // scheme, major*1_000_000 + minor*1_000 + patch, so it keeps rising
        // across the switch from that app.
        val stamped = (findProperty("codedeckVersion") as String?)?.removePrefix("v")
        versionName = stamped ?: "0.0.0-dev"
        versionCode = stamped
            ?.substringBefore('-')
            ?.split('.')
            ?.map { it.toInt() }
            ?.let { (major, minor, patch) -> major * 1_000_000 + minor * 1_000 + patch }
            ?: 1
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
    // CoreHost.pause()/resume() from it.
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
    // crates/client-ffi's cdylib. Version pinned loosely on purpose — this
    // is exactly the dependency the generated bindings file itself declares
    // as a prerequisite; keep it in step with whatever `uniffi` crate version
    // crates/client-ffi/Cargo.toml pins (currently 0.28).
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
