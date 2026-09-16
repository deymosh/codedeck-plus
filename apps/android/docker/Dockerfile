# Dev-only Android + Rust build environment for apps/android — NOT part of
# the codedeck-bridge deployment (root docker-compose.yml never touches
# this). Builds a debug APK without installing Android Studio/NDK/Rust on
# the host. See build-apk.sh.
FROM gradle:9.7.1-jdk21

ENV DEBIAN_FRONTEND=noninteractive
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl unzip ca-certificates build-essential \
    && rm -rf /var/lib/apt/lists/*

# --- Android SDK (cmdline-tools) + NDK 28 + platform 37 ---
# NDK pin matches apps/mobile/docker/Dockerfile's — one cross-compile target
# triple, two consumers. Platform is versioned "37.2" (Android 17 ships
# minor platform revisions, not one fixed "android-37" the way earlier API
# levels did); build-tools keeps the older "37.0.0" scheme.
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_NDK_HOME=${ANDROID_HOME}/ndk/28.2.13676358
ENV PATH=${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${PATH}

RUN mkdir -p ${ANDROID_HOME}/cmdline-tools \
    && curl -fsSL -o /tmp/cmdline-tools.zip \
       https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
    && unzip -q /tmp/cmdline-tools.zip -d ${ANDROID_HOME}/cmdline-tools \
    && mv ${ANDROID_HOME}/cmdline-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
    && rm /tmp/cmdline-tools.zip

RUN yes | sdkmanager --licenses > /dev/null \
    && sdkmanager --install \
       "platform-tools" \
       "platforms;android-37.2" \
       "build-tools;37.0.0" \
       "ndk;28.2.13676358"

# --- Rust + Android cross-compile targets ---
ENV RUSTUP_HOME=/opt/rustup
ENV CARGO_HOME=/opt/cargo
ENV PATH=${CARGO_HOME}/bin:${PATH}
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain stable \
    && rustup target add aarch64-linux-android x86_64-linux-android

WORKDIR /workspace
