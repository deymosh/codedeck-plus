plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.paparazzi)
}

// `<workspace version>-dev+<commit>` (`-dirty` when the tree has local
// changes) for a build not stamped from a release tag, so an installed debug
// APK says exactly what it was built from. The version is the root
// Cargo.toml's `[workspace.package]` one. The commit comes from
// `-PcodedeckGitRev` when given (the Docker build copies the tree into its
// container without `.git`), else from git itself; without either the name
// is just `<version>-dev`.
fun devVersionName(): String {
    val cargoToml = rootProject.layout.projectDirectory.file("../../Cargo.toml")
    val version = providers.fileContents(cargoToml).asText.orNull
        ?.lineSequence()
        ?.dropWhile { it.trim() != "[workspace.package]" }
        ?.drop(1)
        ?.takeWhile { !it.trimStart().startsWith("[") }
        ?.firstNotNullOfOrNull { Regex("""^version\s*=\s*"([^"]+)"""").find(it.trim())?.groupValues?.get(1) }
        ?: "0.0.0"
    val rev = (findProperty("codedeckGitRev") as String?)?.trim()
        ?: runCatching {
            providers.exec {
                // --exclude=* ignores every tag, so this is the abbreviated
                // commit hash plus the --dirty suffix.
                commandLine("git", "describe", "--always", "--dirty", "--exclude=*")
                isIgnoreExitValue = true
            }.standardOutput.asText.get().trim()
        }.getOrNull()
    return if (rev.isNullOrEmpty()) "$version-dev" else "$version-dev+$rev"
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
        // The same identity the frozen Tauri app (apps/mobile) shipped under;
        // see versionCode below for why it still cannot install over it.
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
        // A plain counter, raised by one in every release's version commit
        // (see the cut-release skill). It restarted at 1 with 1.0.0, below
        // the Tauri app's codes (major*1_000_000 + minor*1_000 + patch, so
        // 12000 for its last 0.12.0): Android refuses to install over that
        // app, and the uninstall it forces drops state no protocol v11 peer
        // can use.
        versionCode = 2
        // A release stamps its name from the tag (`-PcodedeckVersion=1.2.3`,
        // or `1.2.3-rc1` for a prerelease); any other build is named after
        // the tree it came from, see devVersionName().
        versionName = (findProperty("codedeckVersion") as String?)?.removePrefix("v")
            ?: devVersionName()
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
    // preview/analysis pipeline, ZXing's core decoder for the QR code — a
    // plain Java library with no dependencies of its own. Not ML Kit: it
    // brings Play Services, Firebase components and a usage-reporting
    // transport (a startup provider, a background upload job) into every
    // launch, all to read one QR code. Neither library is covered by the
    // Compose BOM, so they are pinned explicitly.
    val camerax = "1.6.2"
    implementation("androidx.camera:camera-camera2:$camerax")
    implementation("androidx.camera:camera-lifecycle:$camerax")
    implementation("androidx.camera:camera-view:$camerax")
    implementation("com.google.zxing:core:3.5.4")

    // Compose-native Markdown for assistant/plan transcript rows.
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
