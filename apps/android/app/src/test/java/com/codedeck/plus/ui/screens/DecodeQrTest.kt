package com.codedeck.plus.ui.screens

import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DecodeQrTest {
    /** A QR code drawn into a luminance frame the way a camera delivers it:
     *  rows padded past the image width, mid-grey and near-white rather
     *  than pure black and white. */
    private fun frame(text: String, width: Int = 480, height: Int = 360, rowStride: Int = 512): ByteArray {
        val side = 300
        val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, side, side)
        val left = (width - side) / 2
        val top = (height - side) / 2
        val bytes = ByteArray(rowStride * height) { 0xE0.toByte() }
        for (y in 0 until side) {
            for (x in 0 until side) {
                if (matrix[x, y]) bytes[(top + y) * rowStride + left + x] = 0x30
            }
        }
        return bytes
    }

    @Test
    fun reads_a_pairing_url_from_a_padded_frame() {
        val url = "codedeck://pair?relay=wss%3A%2F%2Frelay.example.com&npub=npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq&token=7f3a"
        assertEquals(url, decodeQr(frame(url), rowStride = 512, width = 480, height = 360))
    }

    @Test
    fun a_frame_without_a_qr_code_is_null() {
        val blank = ByteArray(512 * 360) { 0x80.toByte() }
        assertNull(decodeQr(blank, rowStride = 512, width = 480, height = 360))
    }
}
