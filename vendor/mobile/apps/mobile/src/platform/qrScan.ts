/**
 * In-app QR scan seam (CDX-011, the Phase-3 "QR camera scan" deferral).
 *
 * Android/iOS: @tauri-apps/plugin-barcode-scanner (official Tauri v2 mobile
 * plugin) — full-screen system camera view, QR format only. Camera permission
 * is requested on first use through the plugin (Android runtime prompt).
 *
 * Desktop / browser / permission denied / user backed out: resolves null and
 * `qrScanAvailable()` is false — the pairing screen hides the button entirely
 * (desktop pairing pastes the URL or uses the codedeck:// deep link; the
 * plugin is not even registered there).
 */

const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const isMobileUa = (): boolean =>
  typeof navigator !== 'undefined' && /android|iphone|ipad/i.test(navigator.userAgent);

/** True where the scan button should render (mobile Tauri only). */
export function qrScanAvailable(): boolean {
  return isTauri() && isMobileUa();
}

/**
 * One scan: permission check/request → full-screen QR scan → the decoded
 * string. Null on unavailable / denied / cancelled — never a thrown error.
 */
export async function scanQrCode(): Promise<string | null> {
  if (!qrScanAvailable()) return null;
  try {
    const scanner = await import('@tauri-apps/plugin-barcode-scanner');
    let permission = await scanner.checkPermissions();
    if (permission === 'prompt') {
      permission = await scanner.requestPermissions();
    }
    if (permission !== 'granted') return null;
    const result = await scanner.scan({
      cameraDirection: 'back',
      formats: [scanner.Format.QRCode],
      windowed: false,
    });
    const content = result?.content?.trim();
    return content ? content : null;
  } catch (err) {
    // Backed out of the camera view, no camera, plugin missing — all "no scan".
    console.log(`[QR] scan unavailable: ${err}`);
    return null;
  }
}
