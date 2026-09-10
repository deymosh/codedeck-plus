plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("app.cash.paparazzi")
}

android {
    namespace = "probe.markdown"
    compileSdk = 35
    defaultConfig { minSdk = 26 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
}

dependencies {
    val compose = "1.7.6"
    implementation("androidx.compose.ui:ui:$compose")
    implementation("androidx.compose.foundation:foundation:$compose")
    implementation("androidx.compose.material3:material3:1.3.1")
    implementation("androidx.compose.ui:ui-tooling-preview:$compose")
    implementation("androidx.compose.ui:ui-tooling:$compose")

    // Compose-native Markdown: GFM tables / task lists / nested lists / code,
    // Material3 typography. (The -code syntax-highlight module is left out of
    // this probe iteration — it dragged in a version-skewed transitive renderer;
    // highlighting is called out in the README as integration work.)
    implementation("com.mikepenz:multiplatform-markdown-renderer-android:0.35.0")
    implementation("com.mikepenz:multiplatform-markdown-renderer-m3:0.35.0")

    testImplementation("junit:junit:4.13.2")
}
