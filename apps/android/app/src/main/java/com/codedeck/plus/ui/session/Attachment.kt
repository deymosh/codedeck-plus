package com.codedeck.plus.ui.session

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.core.graphics.scale
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.util.Locale
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Session attachments: any file, sent as its own bytes under its own name
 * and MIME type. The one exception is a very large still image — over
 * [IMAGE_MAX_DIMENSION] px on a side — which is downscaled first (JPEG stays
 * JPEG at quality 92, anything else becomes PNG), since a phone photo at full
 * size can weigh more than an attachment may. An animated GIF is never
 * re-encoded (that would drop the animation), and an image that will not
 * decode goes as it is.
 *
 * Everything here blocks (BitmapFactory decodes, stream reads), so callers
 * must run it off the main thread. Wrap it in `runInterruptible` — a plain
 * coroutine timeout cannot preempt a blocked stream read, so a stalled
 * content provider would otherwise ride through the deadline untouched.
 */

/** Longest edge an attached image may have before it is downscaled. */
internal const val IMAGE_MAX_DIMENSION = 3840

/**
 * Wall-clock budget for reading the picked file's bytes (and the metadata +
 * thumbnail read at pick time). A local `content://` read returns in tens of
 * milliseconds; the honest slow tail is a cloud-backed provider that must
 * download the file before it can hand over a byte. Past this a read is not
 * slow, it is stuck: the deadline turns a permanently wedged composer into a
 * recoverable banner with the attachment still staged.
 */
internal const val FILE_READ_TIMEOUT_MS = 30_000L

/** Overall wall clock for a send — all stages together. The Rust core
 *  enforces the same number internally; the UI races its dispatch against
 *  this plus a grace so the inner stages report first. */
internal const val SESSION_FILE_SEND_BUDGET_MS = 120_000L

private const val JPEG_REENCODE_QUALITY = 92

/** Chip thumbnail target edge in pixels (the chip renders at 48 dp). */
private const val THUMBNAIL_PX = 128

/** What a file whose provider names no type is sent as. */
private const val UNKNOWN_MIME = "application/octet-stream"

/** Image types BitmapFactory can decode and re-encode without losing more
 *  than resolution. */
private val RESIZABLE_IMAGES = setOf("image/jpeg", "image/png", "image/webp", "image/bmp", "image/heic", "image/heif")

/** A staged attachment: everything the chip needs before any processing. */
internal data class PickedFile(
    val uri: Uri,
    val displayName: String,
    /** 0 when the provider does not say. */
    val sizeBytes: Long,
    /** A preview for an image; null for any other file. */
    val thumbnail: ImageBitmap?,
    /** The provider's MIME type, or [UNKNOWN_MIME] when it names none. */
    val mimeType: String,
)

/** The bytes that go on the wire, with their name and MIME type. */
internal class ProcessedFile(
    val bytes: ByteArray,
    val filename: String,
    val mimeType: String,
)

/** A size the way the chip and the errors say it, in the 1024-based units
 *  a phone's own file manager uses: KB below a megabyte. */
internal fun formatSize(bytes: Long): String = when {
    bytes >= 1024 * 1024 -> String.format(Locale.US, "%.1f MB", bytes / (1024.0 * 1024.0))
    else -> "${maxOf(1, (bytes / 1024.0).roundToInt())} KB"
}

/** Why a file of [size] bytes cannot be attached under [limit], or null. */
internal fun tooLargeReason(name: String, size: Long, limit: Long, blossom: Boolean): String? {
    if (size <= limit) return null
    val hint = if (blossom) "" else " Set a Blossom server under Settings › Uploads to send files up to 25 MB."
    return "$name is ${formatSize(size)}; attachments can be up to ${formatSize(limit)}.$hint"
}

/** [name] reduced to letters, digits, dot, underscore and hyphen. */
internal fun safeFilename(name: String): String = name.replace(Regex("[^a-zA-Z0-9._-]"), "_")

/**
 * Stage a picked file for the chip: display name, size, MIME type, and for
 * an image a mini decode for the thumbnail. All best-effort — a query that
 * fails or an image that will not decode still stages, just without a
 * preview or with the name derived from the Uri. Blocking; run on a worker.
 */
internal fun readPickedFile(resolver: ContentResolver, uri: Uri): PickedFile {
    var displayName: String? = null
    var sizeBytes = 0L
    try {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (nameIndex >= 0 && !cursor.isNull(nameIndex)) displayName = cursor.getString(nameIndex)
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) sizeBytes = cursor.getLong(sizeIndex)
            }
        }
    } catch (_: Exception) {
        // Metadata is best-effort.
    }
    val name = displayName ?: uri.lastPathSegment?.substringAfterLast('/') ?: "file"
    val mimeType = try {
        resolver.getType(uri)?.takeIf { it.isNotBlank() } ?: UNKNOWN_MIME
    } catch (_: Exception) {
        UNKNOWN_MIME
    }
    val thumbnail = if (mimeType.startsWith("image/")) decodeMiniBitmap(resolver, uri) else null
    return PickedFile(uri, name, sizeBytes, thumbnail, mimeType)
}

/**
 * Turn a staged file into wire bytes: its own bytes, except for an image
 * over [IMAGE_MAX_DIMENSION] on a side, which is downscaled (decoded with
 * power-of-two subsampling near the target, then scaled exactly, so a huge
 * photo is never decoded at full size). Refused when the result is over
 * [maxBytes]. Blocking; run on a worker dispatcher.
 */
internal fun processPickedFile(resolver: ContentResolver, picked: PickedFile, maxBytes: Long, blossom: Boolean): ProcessedFile {
    val filename = safeFilename(picked.displayName)
    tooLargeReason(picked.displayName, picked.sizeBytes, maxBytes, blossom)?.let { throw IOException(it) }
    val processed = if (picked.mimeType in RESIZABLE_IMAGES) {
        downscaledIfHuge(resolver, picked, filename)
    } else {
        null
    } ?: ProcessedFile(readAll(resolver, picked.uri), filename, picked.mimeType)
    tooLargeReason(picked.displayName, processed.bytes.size.toLong(), maxBytes, blossom)?.let { throw IOException(it) }
    return processed
}

/** The downscaled image, or null when it needs none (or will not decode —
 *  it then goes as it is). */
private fun downscaledIfHuge(resolver: ContentResolver, picked: PickedFile, filename: String): ProcessedFile? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    openStream(resolver, picked.uri)?.use { BitmapFactory.decodeStream(it, null, bounds) } ?: return null
    val width = bounds.outWidth
    val height = bounds.outHeight
    if (width <= 0 || height <= 0 || (width <= IMAGE_MAX_DIMENSION && height <= IMAGE_MAX_DIMENSION)) return null

    val scale = min(IMAGE_MAX_DIMENSION.toFloat() / width, IMAGE_MAX_DIMENSION.toFloat() / height)
    val targetWidth = (width * scale).roundToInt()
    val targetHeight = (height * scale).roundToInt()
    var sampleSize = 1
    while (width / (sampleSize * 2) >= targetWidth && height / (sampleSize * 2) >= targetHeight) sampleSize *= 2
    val decoded = openStream(resolver, picked.uri)?.use {
        BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sampleSize })
    } ?: return null
    val scaled = if (decoded.width != targetWidth || decoded.height != targetHeight) {
        decoded.scale(targetWidth, targetHeight, true)
    } else {
        decoded
    }
    val jpeg = picked.mimeType == "image/jpeg"
    val output = ByteArrayOutputStream()
    scaled.compress(if (jpeg) Bitmap.CompressFormat.JPEG else Bitmap.CompressFormat.PNG, JPEG_REENCODE_QUALITY, output)
    // A re-encoded image carries the extension of what it now is.
    val ext = if (jpeg) "jpg" else "png"
    val stem = filename.substringBeforeLast('.', filename)
    return ProcessedFile(output.toByteArray(), "$stem.$ext", if (jpeg) "image/jpeg" else "image/png")
}

private fun readAll(resolver: ContentResolver, uri: Uri): ByteArray =
    openStream(resolver, uri)?.use { it.readBytes() } ?: throw IOException("Failed to read file (provider returned no stream)")

/** Downsampled chip preview; `null` when the provider or decoder fails —
 *  the chip then shows a file icon, name and size. Blocking; run on a worker. */
private fun decodeMiniBitmap(resolver: ContentResolver, uri: Uri): ImageBitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    val boundsStream = openStream(resolver, uri) ?: return null
    boundsStream.use { BitmapFactory.decodeStream(it, null, bounds) }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sampleSize = 1
    while (bounds.outWidth / (sampleSize * 2) >= THUMBNAIL_PX && bounds.outHeight / (sampleSize * 2) >= THUMBNAIL_PX) {
        sampleSize *= 2
    }
    val options = BitmapFactory.Options().apply { inSampleSize = sampleSize }
    val decoded = openStream(resolver, uri)?.use { BitmapFactory.decodeStream(it, null, options) } ?: return null
    return decoded.asImageBitmap()
}

/** `openInputStream` catches its own failures so every caller gets one
 *  uniform "provider returned no stream" shape. */
private fun openStream(resolver: ContentResolver, uri: Uri): InputStream? = try {
    resolver.openInputStream(uri)
} catch (_: Exception) {
    null
}
