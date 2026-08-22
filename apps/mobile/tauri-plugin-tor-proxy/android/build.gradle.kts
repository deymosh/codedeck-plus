plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.codedeck.torproxy"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }

    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    // ProxyController / ProxyConfig — androidx.webkit, not the platform
    // android.webkit package, so PROXY_OVERRIDE works down to minSdk 24 via
    // WebViewFeature's compat shim (guarded at call time either way).
    implementation("androidx.webkit:webkit:1.12.1")
    implementation(project(":tauri-android"))
}
