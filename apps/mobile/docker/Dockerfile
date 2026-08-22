# Dev-only Android build environment for apps/mobile — NOT part of the
# codedeck-bridge deployment (root docker-compose.yml never touches this).
# Produces a DEBUG apk (Android auto-generates a debug keystore — no signing
# setup needed) so a local checkout can be built and side-loaded onto a test
# device without installing Android Studio/NDK/Rust on the host.
#
# For a signed RELEASE build you'd additionally need a real keystore at
# apps/mobile/src-tauri/gen/android/keystore.properties (see
# vendor/mobile/scripts/build-release-apk.sh for that path) — out of scope
# here since nobody has generated one yet.
FROM eclipse-temurin:21-jdk-jammy

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl unzip git build-essential clang ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# --- Node 22 + pnpm ---
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g pnpm@10.8.0 \
    && rm -rf /var/lib/apt/lists/*

# --- Android SDK (cmdline-tools) + NDK 28 + platform 36 ---
# Matches apps/mobile/src-tauri/gen/android/app/build.gradle.kts
# (compileSdk/targetSdk 36) and vendor/mobile/scripts/build-release-apk.sh
# (NDK 28.2.13676358 — the exact version the RANLIB_/AR_ exports below target).
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_NDK_HOME=${ANDROID_HOME}/ndk/28.2.13676358
ENV NDK_HOME=${ANDROID_NDK_HOME}
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
       "platforms;android-36" \
       "build-tools;36.0.0" \
       "ndk;28.2.13676358"

# --- Rust + Android cross-compile targets ---
ENV RUSTUP_HOME=/opt/rustup
ENV CARGO_HOME=/opt/cargo
ENV PATH=${CARGO_HOME}/bin:${PATH}
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain stable \
    && rustup target add aarch64-linux-android

# Gradle's rustBuildArm64Debug task shells out to `cargo tauri ...` (a Cargo
# SUBCOMMAND, from the tauri-cli crate) -- separate from the npm
# @tauri-apps/cli used to kick off `tauri android build` from the terminal.
# Without this, the build fails deep inside Gradle with
# "error: no such command: `tauri`".
RUN cargo install tauri-cli --version "^2" --locked

# CDX-012 NDK trap (see vendor/mobile/scripts/build-release-apk.sh): these
# exports only matter on the tauri-CLI-drives-cargo path — gen/android's
# BuildTask.kt sets them itself when GRADLE drives the CLI, but a plain
# `tauri android build` from the CLI does not.
ENV TOOLBIN=${ANDROID_NDK_HOME}/toolchains/llvm/prebuilt/linux-x86_64/bin
ENV RANLIB_aarch64_linux_android=${TOOLBIN}/llvm-ranlib
ENV AR_aarch64_linux_android=${TOOLBIN}/llvm-ar

WORKDIR /workspace
CMD ["bash"]
