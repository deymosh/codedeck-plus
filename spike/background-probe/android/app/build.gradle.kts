plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.codedeck.bgprobe"
    // The real apps/android targets SDK 37 (maintainer's choice). This probe
    // pins 36: the API-37 platform ships SDK XML v4, which the sdklib bundled in
    // the Dockerized AGP 8.11.1 cannot parse ("Failed to find target android-37").
    // A native Android Studio build (matching newer sdklib) handles 37 fine.
    // The probe measures background delivery, not the SDK level.
    compileSdk = 36

    defaultConfig {
        applicationId = "com.codedeck.bgprobe"
        minSdk = 34            // typed FOREGROUND_SERVICE_DATA_SYNC
        targetSdk = 36
        versionCode = 1
        versionName = "0.0"
        // relay the probe connects to; 10.0.2.2 = host loopback from the emulator
        buildConfigField("String", "RELAY_URL", "\"ws://10.0.2.2:7447\"")
    }
    buildFeatures { buildConfig = true; viewBinding = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    // libheartbeat_core.so is produced by ../build.sh (cargo-ndk) into here
    sourceSets["main"].jniLibs.srcDir("src/main/jniLibs")
    // uniffi-bindgen output also lands under src/main/kotlin
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    // UniFFI-generated Kotlin needs JNA — the @aar variant on Android
    implementation("net.java.dev.jna:jna:5.15.0@aar")
}
