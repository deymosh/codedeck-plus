package com.codedeck.plus.ui.screens

import android.content.Context
import android.util.Size
import androidx.activity.compose.BackHandler
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.codedeck.plus.ui.theme.Tokens
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * Full-screen in-app QR camera scan for the pairing screen — port of
 * `apps/mobile/src/platform/qrScan.ts`'s contract: back camera, QR format
 * only, and "no scan" on every exit path. Cancel (close button or system
 * back), a denied CAMERA prompt, missing camera hardware, or a failed
 * camera-provider init all simply fold back to the caller via [onDismiss];
 * this surface never renders an error of its own. A decode fires [onDecoded]
 * exactly once per opening — the analyzer disarms itself on the first read
 * so already-queued frames cannot produce a second result.
 *
 * Threading invariant: everything that touches the camera or the scanner
 * client (provider await, binding, the analyzer, dispose-time unbind/close)
 * runs on the main executor. That makes the disposed-flag check before
 * [ProcessCameraProvider.bindToLifecycle] and the dispose-time teardown
 * atomic with respect to each other — Compose can only interleave them at a
 * suspension point, and there is none between the check and the bind.
 *
 * The caller composes this only while the scan is open AND the CAMERA
 * permission is granted (PairingScreen's launcher gates composition), so the
 * bind effect below runs once per granted+open window and the dispose-time
 * cleanup always observes the provider that was bound.
 */
@Composable
fun PairingScanView(
    onDecoded: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val mainExecutor = remember { ContextCompat.getMainExecutor(context) }

    val previewView = remember {
        PreviewView(context).apply { scaleType = PreviewView.ScaleType.FILL_CENTER }
    }
    val scanner = remember {
        // QR only: the pairing QR is the only payload this surface decodes.
        BarcodeScanning.getClient(
            BarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .build(),
        )
    }
    // Plain atomics, not Compose state: the analyzer's entry point is called
    // from camera executor callbacks outside the snapshot system.
    val delivered = remember { AtomicBoolean(false) }
    val disposed = remember { AtomicBoolean(false) }
    val boundProvider = remember { mutableStateOf<ProcessCameraProvider?>(null) }

    BackHandler(onBack = onDismiss)

    DisposableEffect(Unit) {
        onDispose {
            // Order matters: disarm the analyzer before closing the scanner
            // client so no in-flight frame can touch a closed client, then
            // release the camera. bindToLifecycle only auto-releases when
            // its LifecycleOwner stops — the activity — which does NOT
            // happen between two scan openings, so an explicit unbind here
            // is what actually frees the camera.
            disposed.set(true)
            boundProvider.value?.unbindAll()
            scanner.close()
        }
    }

    LaunchedEffect(lifecycleOwner) {
        val provider = awaitCameraProvider(context, mainExecutor)
        if (provider == null || disposed.get()) {
            // Provider init failed (e.g. no camera hardware) — or the surface
            // was torn down while the provider was still resolving. Both are
            // the reference's "unavailable" outcome: fold back, no error UI.
            onDismiss()
            return@LaunchedEffect
        }
        boundProvider.value = provider

        val preview = Preview.Builder().build().also { useCase ->
            useCase.setSurfaceProvider(previewView.surfaceProvider)
        }
        val analysis = ImageAnalysis.Builder()
            .setResolutionSelector(
                ResolutionSelector.Builder()
                    .setResolutionStrategy(
                        ResolutionStrategy(
                            Size(640, 640),
                            ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER,
                        ),
                    )
                    .build(),
            )
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()
        // Read once at bind: CameraX derives each frame's rotationDegrees
        // from this, which is what the ML Kit input consumes. A pairing scan
        // is a seconds-long gesture; mid-scan device rotation is not a case
        // worth an orientation listener.
        previewView.display?.let { display -> analysis.targetRotation = display.rotation }
        analysis.setAnalyzer(
            mainExecutor,
            PairingQrAnalyzer(scanner, delivered, disposed, onQr = onDecoded),
        )
        try {
            provider.unbindAll()
            provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
        } catch (e: Exception) {
            // Back camera busy or absent — same "unavailable" outcome.
            onDismiss()
        }
    }

    Surface(Modifier.fillMaxSize(), color = Tokens.Bg) {
        Box(Modifier.fillMaxSize()) {
            AndroidView(modifier = Modifier.fillMaxSize(), factory = { previewView })
            Box(Modifier.fillMaxSize().background(Tokens.Bg.copy(alpha = 0.55f)))
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Box(
                        Modifier
                            .size(240.dp)
                            .border(2.dp, Tokens.Text, RoundedCornerShape(Tokens.RadiusMd)),
                    )
                    Text(
                        "Point the camera at the bridge's pairing QR",
                        color = Tokens.TextMuted,
                        fontSize = Tokens.TextSm,
                        modifier = Modifier.padding(top = Tokens.Space3),
                    )
                }
            }
            IconButton(
                onClick = onDismiss,
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .padding(Tokens.Space3),
            ) {
                Icon(Icons.Outlined.Close, contentDescription = "Cancel scan", tint = Tokens.Text)
            }
        }
    }
}

/**
 * Feeds CameraX frames to the QR-only scanner. The [delivered] guard is
 * checked before any work so a decode that already closed the surface turns
 * queued frames into no-ops, and [disposed] does the same during teardown —
 * a frame in flight when the surface closes is still released through the
 * process listener's completion callback, so CameraX never sees a stuck
 * buffer and ML Kit never receives input after its client is closed.
 */
private class PairingQrAnalyzer(
    private val scanner: BarcodeScanner,
    private val delivered: AtomicBoolean,
    private val disposed: AtomicBoolean,
    private val onQr: (String) -> Unit,
) : ImageAnalysis.Analyzer {
    override fun analyze(imageProxy: ImageProxy) {
        if (delivered.get() || disposed.get()) {
            imageProxy.close()
            return
        }
        val mediaImage = imageProxy.image
        if (mediaImage == null) {
            imageProxy.close()
            return
        }
        val input = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
        try {
            scanner.process(input)
                .addOnSuccessListener { barcodes ->
                    val text = barcodes.firstNotNullOfOrNull { it.rawValue }?.trim()
                    if (!text.isNullOrEmpty() && delivered.compareAndSet(false, true) && !disposed.get()) {
                        // ML Kit task listeners default to the main thread,
                        // so handing the result up here is main-thread safe.
                        onQr(text)
                    }
                }
                .addOnCompleteListener { imageProxy.close() }
        } catch (e: Exception) {
            // The scanner client can already be closed during teardown; the
            // proxy must still be released or CameraX wedges the stream.
            imageProxy.close()
        }
    }
}

/**
 * One-shot bridge from CameraX's ListenableFuture into coroutine land.
 * Returns null on provider failure AND when the surface was disposed while
 * the future was still resolving (the continuation is already cancelled
 * then) — the caller folds both into the same no-scan outcome. The resume
 * happens on [executor]; callers pass the main executor to keep the
 * threading invariant documented on [PairingScanView].
 */
private suspend fun awaitCameraProvider(context: Context, executor: Executor): ProcessCameraProvider? {
    val future = ProcessCameraProvider.getInstance(context)
    return suspendCancellableCoroutine { cont ->
        future.addListener(
            {
                val provider = try {
                    future.get()
                } catch (e: Exception) {
                    null
                }
                if (cont.isActive) cont.resume(provider)
            },
            executor,
        )
    }
}
