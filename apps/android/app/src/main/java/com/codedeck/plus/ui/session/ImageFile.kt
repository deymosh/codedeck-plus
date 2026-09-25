package com.codedeck.plus.ui.session

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Session image attachment processing — the Android port of the reference
 * `ui/imageFile.ts` contract. Screenshots stay PNG (lossless — text must
 * survive); a JPEG that needs a resize re-encodes as JPEG at quality 92; any
 * other source format keeps its ORIGINAL bytes when no resize is needed and
 * is merely DECLARED PNG, the same quirk as the reference. Only images over
 * 3840 px on a side are downscaled — oversized uploads strain the relay-chunk
 * fallback (200 chunks / a 55 s assembly window inside a 120 s total send
 * budget).
 *
 * Everything here blocks (BitmapFactory decodes, stream reads), so callers
 * must run it off the main thread. Wrap it in `runInterruptible` — a plain
 * coroutine timeout cannot preempt a blocked stream read, so a stalled
 * content provider would otherwise ride through the deadline untouched.
 */

/** Longest edge allowed before downscaling (`imageFile.ts` MAX_DIMENSION). */
internal const val IMAGE_MAX_DIMENSION = 3840

/**
 * Wall-clock budget for reading the picked image's bytes (and the metadata +
 * thumbnail read at pick time). A local `content://` read returns in tens of
 * milliseconds; the honest slow tail is a cloud-backed provider that must
 * download the file before it can hand over a byte. Past this a read is not
 * slow, it is stuck: the deadline turns a permanently wedged composer into a
 * recoverable banner with the attachment still staged.
 */
internal const val IMAGE_READ_TIMEOUT_MS = 30_000L

/** Overall wall clock for a send — all stages together. The Rust core
 *  enforces the same number internally; the UI races its dispatch against
 *  this plus a grace so the inner stages report first. */
internal const val SESSION_IMAGE_SEND_BUDGET_MS = 120_000L

/** JPEG re-encode quality — the reference's `canvas.toDataURL(mime, 0.92)`.
 *  PNG ignores quality (lossless), as in the reference. */
private const val JPEG_REENCODE_QUALITY = 92

/** Chip thumbnail target edge in pixels (the chip renders at 48 dp). */
private const val THUMBNAIL_PX = 128

/** A staged attachment: everything the chip needs before any processing. */
internal data class PickedImage(
    val uri: Uri,
    val displayName: String,
    val sizeBytes: Long,
    val thumbnail: ImageBitmap?,
    /** Provider-reported mime, or empty when the provider names none — the
     *  format rule treats anything that is not exactly JPEG as PNG. */
    val rawMimeType: String,
)

/** The bytes that go on the wire, with their declared name and mime. */
internal class ProcessedImage(
    val bytes: ByteArray,
    val filename: String,
    val mimeType: String,
)

/**
 * Stage a picked image for the chip: display name, size, provider mime, and
 * a mini decode for the thumbnail. All best-effort — a query that fails or a
 * bitmap that will not decode still stages, just without a preview or with
 * the name derived from the Uri (the reference's `previewUrl: null` case).
 * Blocking; run on a worker dispatcher.
 */
internal fun readPickedImage(resolver: ContentResolver, uri: Uri): PickedImage {
    var displayName: String? = null
    var sizeBytes = 0L
    try {
        resolver.query(
            uri,
            arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
            null,
            null,
            null,
        )?.use { cursor ->
            if (cursor.moveToFirst()) {
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (nameIndex >= 0 && !cursor.isNull(nameIndex)) {
                    displayName = cursor.getString(nameIndex)
                }
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) {
                    sizeBytes = cursor.getLong(sizeIndex)
                }
            }
        }
    } catch (_: Exception) {
        // Metadata is best-effort; the decode below decides success.
    }
    val name = displayName
        ?: uri.lastPathSegment?.substringAfterLast('/')
        ?: "image"
    val rawMimeType = try {
        resolver.getType(uri) ?: ""
    } catch (_: Exception) {
        ""
    }
    return PickedImage(uri, name, sizeBytes, decodeMiniBitmap(resolver, uri), rawMimeType)
}

/**
 * Turn a staged image into wire bytes. At or under [IMAGE_MAX_DIMENSION] on
 * both sides the original bytes pass through un-re-encoded — a normal
 * screenshot is never re-compressed. Over the cap on either side, decode
 * with power-of-two subsampling down near the target and then exactly scale
 * it, so the exact-scale draw never starts from a full-size decode of a
 * huge photo. Blocking; run on a worker dispatcher.
 *
 * Thrown messages carry the reference's two read-stage prefixes
 * ("Failed to read file" for a dead provider stream, "Failed to load image"
 * for an undecodeable one) so the composer banner stays diagnosable.
 */
internal fun processPickedImage(resolver: ContentResolver, picked: PickedImage): ProcessedImage {
    // The reference's format rule, verbatim: declared JPEG stays JPEG;
    // everything else — including a provider that names no type at all —
    // is declared PNG. The provider mime only feeds this decision.
    val mimeType = if (picked.rawMimeType == "image/jpeg") "image/jpeg" else "image/png"
    // Same character whitelist as the reference: letters, digits, dot,
    // underscore, hyphen — anything else becomes '_'.
    val filename = picked.displayName.replace(Regex("[^a-zA-Z0-9._-]"), "_")

    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    val boundsStream = openStream(resolver, picked.uri)
        ?: throw IOException("Failed to read file (provider returned no stream)")
    boundsStream.use { BitmapFactory.decodeStream(it, null, bounds) }
    val width = bounds.outWidth
    val height = bounds.outHeight
    if (width <= 0 || height <= 0) {
        throw IOException("Failed to load image (image decode failed)")
    }

    if (width <= IMAGE_MAX_DIMENSION && height <= IMAGE_MAX_DIMENSION) {
        val bytes = openStream(resolver, picked.uri)?.use { it.readBytes() }
            ?: throw IOException("Failed to read file (provider returned no stream)")
        return ProcessedImage(bytes, filename, mimeType)
    }

    val scale = min(
        IMAGE_MAX_DIMENSION.toFloat() / width,
        IMAGE_MAX_DIMENSION.toFloat() / height,
    )
    val targetWidth = (width * scale).roundToInt()
    val targetHeight = (height * scale).roundToInt()
    var sampleSize = 1
    while (width / (sampleSize * 2) >= targetWidth && height / (sampleSize * 2) >= targetHeight) {
        sampleSize *= 2
    }
    val decodeOptions = BitmapFactory.Options().apply { inSampleSize = sampleSize }
    val decoded = openStream(resolver, picked.uri)?.use {
        BitmapFactory.decodeStream(it, null, decodeOptions)
    } ?: throw IOException("Failed to load image (image decode failed)")
    val scaled = if (decoded.width != targetWidth || decoded.height != targetHeight) {
        Bitmap.createScaledBitmap(decoded, targetWidth, targetHeight, true)
    } else {
        decoded
    }
    val output = ByteArrayOutputStream()
    val format = if (mimeType == "image/jpeg") {
        Bitmap.CompressFormat.JPEG
    } else {
        Bitmap.CompressFormat.PNG
    }
    scaled.compress(format, JPEG_REENCODE_QUALITY, output)
    return ProcessedImage(output.toByteArray(), filename, mimeType)
}

/** Downsampled chip preview; `null` when the provider or decoder fails —
 *  the chip then shows name and size only. Blocking; run on a worker. */
private fun decodeMiniBitmap(resolver: ContentResolver, uri: Uri): ImageBitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    val boundsStream = openStream(resolver, uri) ?: return null
    boundsStream.use { BitmapFactory.decodeStream(it, null, bounds) }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sampleSize = 1
    while (
        bounds.outWidth / (sampleSize * 2) >= THUMBNAIL_PX &&
        bounds.outHeight / (sampleSize * 2) >= THUMBNAIL_PX
    ) {
        sampleSize *= 2
    }
    val options = BitmapFactory.Options().apply { inSampleSize = sampleSize }
    val decoded = openStream(resolver, uri)?.use {
        BitmapFactory.decodeStream(it, null, options)
    } ?: return null
    return decoded.asImageBitmap()
}

/** `openInputStream` catches its own failures so every caller gets one
 *  uniform "provider returned no stream" shape. */
private fun openStream(resolver: ContentResolver, uri: Uri): InputStream? = try {
    resolver.openInputStream(uri)
} catch (_: Exception) {
    null
}
