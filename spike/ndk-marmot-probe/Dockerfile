# Lean Android cross-compile env for F0 probe-2: Rust + one NDK + the
# aarch64-linux-android target + cargo-ndk. No full Android SDK, no Gradle.
FROM rust:1-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends unzip curl file \
 && rm -rf /var/lib/apt/lists/*

# NDK r28c == 28.2.13676358, the exact revision apps/mobile/src-tauri pins.
ARG NDK=android-ndk-r28c
RUN curl -fsSL -o /tmp/ndk.zip "https://dl.google.com/android/repository/${NDK}-linux.zip" \
 && unzip -q /tmp/ndk.zip -d /opt \
 && mv "/opt/${NDK}" /opt/ndk \
 && rm /tmp/ndk.zip
ENV ANDROID_NDK_HOME=/opt/ndk

RUN rustup target add aarch64-linux-android \
 && cargo install cargo-ndk --locked
