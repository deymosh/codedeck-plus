# One image for the whole bgprobe build: Rust + NDK r28c + cargo-ndk (both
# android ABIs), plus JDK 17 + Android cmdline-tools so Gradle can assemble the
# APK. `platforms;android-37` is bind-mounted from the host at build time
# (android.jar is pure Java — mounting the host copy is fine); everything else
# is installed here for Linux.
FROM rust:1-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      unzip curl file openjdk-17-jdk-headless \
 && rm -rf /var/lib/apt/lists/*

# --- Rust / Android cross-compile ---
ARG NDK=android-ndk-r28c
RUN curl -fsSL -o /tmp/ndk.zip "https://dl.google.com/android/repository/${NDK}-linux.zip" \
 && unzip -q /tmp/ndk.zip -d /opt && mv "/opt/${NDK}" /opt/ndk && rm /tmp/ndk.zip
ENV ANDROID_NDK_HOME=/opt/ndk
RUN rustup target add aarch64-linux-android x86_64-linux-android \
 && cargo install cargo-ndk --locked

# --- Android SDK (Gradle) ---
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=/opt/android-sdk
RUN mkdir -p "$ANDROID_HOME/cmdline-tools" \
 && curl -fsSL -o /tmp/clt.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
 && unzip -q /tmp/clt.zip -d "$ANDROID_HOME/cmdline-tools" && rm /tmp/clt.zip \
 && mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
ENV PATH="$PATH:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools"
RUN yes | sdkmanager --licenses >/dev/null \
 && sdkmanager "platform-tools" "build-tools;36.0.0" "platforms;android-36" >/dev/null
