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

    // Compose-native Markdown. 0.27.0 = Kotlin 1.9 era (reads fine in a K2
    // project) and still has the SYNCHRONOUS `Markdown(content)` — the async
    // MarkdownState split came later and breaks static screenshot tests.
    val md = "0.27.0"
    implementation("com.mikepenz:multiplatform-markdown-renderer:$md")
    implementation("com.mikepenz:multiplatform-markdown-renderer-android:$md")
    implementation("com.mikepenz:multiplatform-markdown-renderer-m3:$md")

    testImplementation("junit:junit:4.13.2")
}

// keep every mikepenz markdown module on the exact same version (transitive
// pulls otherwise skew and cause runtime NoSuchMethodError)
configurations.all {
    resolutionStrategy.eachDependency {
        if (requested.group == "com.mikepenz" && requested.name.startsWith("multiplatform-markdown-renderer")) {
            useVersion("0.27.0")
        }
    }
}
