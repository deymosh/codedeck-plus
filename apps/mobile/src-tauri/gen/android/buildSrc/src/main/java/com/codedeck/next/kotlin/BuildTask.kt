import java.io.File
import org.apache.tools.ant.taskdefs.condition.Os
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.logging.LogLevel
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction

open class BuildTask : DefaultTask() {
    @Input
    var rootDirRel: String? = null
    @Input
    var target: String? = null
    @Input
    var release: Boolean? = null

    @TaskAction
    fun assemble() {
        val executable = """cargo""";
        try {
            runTauriCli(executable)
        } catch (e: Exception) {
            if (Os.isFamily(Os.FAMILY_WINDOWS)) {
                // Try different Windows-specific extensions
                val fallbacks = listOf(
                    "$executable.exe",
                    "$executable.cmd",
                    "$executable.bat",
                )
                
                var lastException: Exception = e
                for (fallback in fallbacks) {
                    try {
                        runTauriCli(fallback)
                        return
                    } catch (fallbackException: Exception) {
                        lastException = fallbackException
                    }
                }
                throw lastException
            } else {
                throw e;
            }
        }
    }

    fun runTauriCli(executable: String) {
        val rootDirRel = rootDirRel ?: throw GradleException("rootDirRel cannot be null")
        val target = target ?: throw GradleException("target cannot be null")
        val release = release ?: throw GradleException("release cannot be null")
        val args = listOf("tauri", "android", "android-studio-script");

        project.exec {
            workingDir(File(project.projectDir, rootDirRel))
            executable(executable)
            args(args)
            // CDX-012: MDK's rusqlite pulls bundled-sqlcipher-vendored-openssl,
            // and openssl-src's Makefile shells out to `<triple>-ranlib`/`-ar`
            // — GNU binutils names that modern NDKs (r23+) no longer ship. The
            // cc crate honors RANLIB_<triple>/AR_<triple> env, so point them
            // at the NDK's llvm tools (same fix class as yenn's vendored-
            // openssl note). No-op when the NDK env is absent.
            val ndk = System.getenv("NDK_HOME") ?: System.getenv("ANDROID_NDK_HOME")
            val hostDir = ndk?.let { File(it, "toolchains/llvm/prebuilt").listFiles()?.firstOrNull() }
            if (hostDir != null) {
                val bin = File(hostDir, "bin")
                val ranlib = File(bin, "llvm-ranlib").absolutePath
                val ar = File(bin, "llvm-ar").absolutePath
                for (triple in listOf(
                    "aarch64_linux_android",
                    "armv7_linux_androideabi",
                    "i686_linux_android",
                    "x86_64_linux_android",
                )) {
                    environment("RANLIB_$triple", ranlib)
                    environment("AR_$triple", ar)
                }
            }
            if (project.logger.isEnabled(LogLevel.DEBUG)) {
                args("-vv")
            } else if (project.logger.isEnabled(LogLevel.INFO)) {
                args("-v")
            }
            if (release) {
                args("--release")
            }
            args(listOf("--target", target))
        }.assertNormalExitValue()
    }
}