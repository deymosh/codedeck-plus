import org.gradle.api.tasks.Exec

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.codedeck.mesh"
    compileSdk = 36

    defaultConfig {
        // Must be <= CodeDeck app minSdk (24) for manifest merge. The VpnService's API 26+ calls
        // (foreground-service type, notification channels) are all guarded by Build.VERSION.SDK_INT.
        minSdk = 24
        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    // jniLibs/arm64-v8a/libnostr_vpn_app_core.so is produced by the cargo-ndk task below.
    sourceSets["main"].jniLibs.srcDirs("src/main/jniLibs")
}

// ── nostr-vpn mesh engine: cross-compile libnostr_vpn_app_core.so via cargo-ndk ──
// Mirrors nostr-vpn's own android/app/build.gradle.kts buildRustArm64 task. The engine lives in the
// workspace-root checkout (five levels up from this android/ dir in the codedeck-next monorepo).
// cargo-ndk + the Android NDK must be available (ANDROID_NDK_HOME); cargo-ndk is installed via
// `cargo install cargo-ndk`. Override with -PnvpnRepo=/path/to/nostr-vpn if the checkout moves.
val nvpnRepoRoot = (findProperty("nvpnRepo") as String?)?.let { file(it) }
    ?: layout.projectDirectory.dir("../../../../../nostr-vpn").asFile
val jniLibsDir = layout.projectDirectory.dir("src/main/jniLibs")

tasks.register<Exec>("buildMeshEngineArm64") {
    workingDir = nvpnRepoRoot
    // Android 15/16 require shared libs aligned to a 16 KB max page size. NDK r27 still defaults to
    // 4 KB, so force it on the linker; without this the .so fails the ELF alignment check and won't
    // load ("LOAD segment not aligned") on 16 KB-page devices like the Pixel 9.
    environment("RUSTFLAGS", "-C link-arg=-Wl,-z,max-page-size=16384")
    // --output-dir places per-ABI .so under jniLibs/<abi>/ exactly as gradle expects.
    commandLine(
        "cargo", "ndk",
        "--target", "arm64-v8a",
        "--platform", "26",
        "--output-dir", jniLibsDir.asFile.absolutePath,
        "build",
        "--package", "nostr-vpn-app-core",
        "--release",
    )
    // Skip gracefully (with a clear message) if the engine checkout isn't present, so a
    // docs-only / CI clone without the sibling repo still configures.
    onlyIf {
        val present = nvpnRepoRoot.resolve("crates/nostr-vpn-app-core/Cargo.toml").exists()
        if (!present) {
            logger.warn("nostr-vpn checkout not found at ${nvpnRepoRoot.absolutePath}; skipping mesh engine build")
        }
        present
    }
}

tasks.matching { it.name in listOf("mergeDebugJniLibFolders", "mergeReleaseJniLibFolders", "preBuild") }
    .configureEach { dependsOn("buildMeshEngineArm64") }

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation(project(":tauri-android"))
}
