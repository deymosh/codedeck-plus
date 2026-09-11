/**
 * Session image attachment helpers — DOM-bound file processing
 * (arrayBuffer/object-URL first, FileReader only as a fallback since
 * CDX-064; canvas for oversize resizes — so it lives in ui/).
 *
 * Ported from the old app's imageUtils.processImageFile. Screenshots stay
 * PNG (lossless — text must survive); only images exceeding 3840px on a
 * side are resized via canvas.
 *
 * The send orchestration this module used to also host (Blossom-first,
 * legacy relay-chunk fallback) is Rust's job now
 * (`Intent::SendSessionImage`, dispatched directly by
 * `SessionScreen.tsx` via `PhoneCore.sendSessionImageNative` — see git
 * history for the retired local orchestrator).
 */
import { describeError, remainingBudget, withDeadline } from '../core/deadline';

const MAX_DIMENSION = 3840;

/**
 * CDX-068 — wall-clock budget for reading the picked file's bytes.
 *
 * 30 s. A local `content://` read of a phone photo returns in tens of
 * milliseconds; the honest slow tail is a cloud-backed provider (a Google
 * Photos original that is not on the device) that must fetch the file before it
 * can hand over a byte, so the budget has to cover a real download, not a disk
 * read. 30 s carries a ~50 MB image at under 2 MB/s — comfortably past any
 * genuinely large picture over slow storage, and past every gallery photo by an
 * order of magnitude. Past that a read is not slow, it is stuck: the broken-
 * provider class CDX-064 exists for fires neither `onload` nor `onerror`, ever.
 *
 * The budget errs short because the two outcomes are not symmetric. A false
 * trip is fully recoverable — the banner names the timeout, the attachment is
 * still staged, ✕ and Send are live, retry is one tap. A missing deadline is
 * not recoverable at all: pre-fix it pinned the spinner forever and disabled
 * the very button that removes the attachment.
 */
export const IMAGE_READ_TIMEOUT_MS = 30_000;

/**
 * The budget is spent across BOTH read paths, so a stalled primary cannot
 * double the user's wait — except that the FileReader fallback always gets at
 * least this much, or a primary that burned the whole budget would leave the
 * CDX-064 recovery path no time to run at all. Worst case is therefore ~35 s,
 * and the common CDX-064 case (arrayBuffer REJECTS in milliseconds) leaves the
 * fallback essentially the full 30 s.
 */
const FALLBACK_MIN_BUDGET_MS = 5_000;

/**
 * CDX-086 — budget for the dimension probe, shared across its two paths.
 * Shorter than the read budget: by this point the bytes are already in hand, so
 * this is a pure in-process decode, not a possible network fetch.
 */
export const IMAGE_PROBE_TIMEOUT_MS = 10_000;
const PROBE_FALLBACK_MIN_BUDGET_MS = 3_000;

export interface ProcessedImage {
  /** Raw base64 (no data: prefix). */
  base64: string;
  mimeType: string;
  filename: string;
  /** Approximate decoded size. */
  sizeBytes: number;
}

/**
 * Process a File from an `<input type="file">`. Keeps the original format;
 * only loads into canvas when a resize is needed (>3840px on a side) — a
 * normal screenshot's bytes pass through un-re-encoded.
 *
 * CDX-064: on the Tauri v2 Android WebView the picked File is content://-
 * backed and `FileReader.readAsDataURL` can fail outright ("Image upload
 * failed: Failed to read file" on device). Robust order:
 * - bytes via `file.arrayBuffer()` first (the reliable path), FileReader
 *   (readAsArrayBuffer) only as the last resort;
 * - the dimension probe via a short-lived `URL.createObjectURL(file)` —
 *   revoked either way — with a data: URL built from the already-read bytes
 *   as its fallback;
 * - every throw carries the underlying DOMException name/message so the
 *   composer banner is diagnosable instead of a bare "Failed to read file".
 *
 * CDX-068: neither read path had a deadline, so a provider that STALLS (the
 * same broken-provider class, in its worse shape: arrayBuffer never settles,
 * the FileReader over the same dead stream fires neither onload nor onerror)
 * left this function hanging forever and the composer wedged. Both paths now
 * share one wall-clock budget and the FileReader is `abort()`ed when it trips.
 */
export async function processImageFile(file: File): Promise<ProcessedImage> {
  const mimeType = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const filename = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');

  const buffer = await readFileBytes(file);
  const img = await probeImage(file, buffer, mimeType);
  const needsResize = img.width > MAX_DIMENSION || img.height > MAX_DIMENSION;

  let base64: string;
  if (needsResize) {
    const scale = Math.min(MAX_DIMENSION / img.width, MAX_DIMENSION / img.height);
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    ctx.drawImage(img, 0, 0, w, h);
    const resizedDataUrl = canvas.toDataURL(mimeType, mimeType === 'image/jpeg' ? 0.92 : undefined);
    base64 = resizedDataUrl.split(',')[1] ?? '';
  } else {
    base64 = arrayBufferToBase64(buffer);
  }

  return { base64, mimeType, filename, sizeBytes: Math.round(base64.length * 0.75) };
}

/** Overall wall clock for a send — the outer backstop `SessionScreen.tsx`
 *  races the single `sendSessionImageNative` dispatch against. */
export const SESSION_IMAGE_SEND_BUDGET_MS = 120_000;

// --- File plumbing (CDX-064: arrayBuffer-first, diagnosable errors) ---
// The deadline/cancel primitives moved to core/deadline.ts (CDX-086) so the
// DOM-free upload layer can share them. Re-exported here because this
// module was their public surface.
export { describeError, withDeadline };

/**
 * Bytes of the picked File. `file.arrayBuffer()` is the primary path — it
 * works on the content://-backed Files the Android WebView hands out where
 * FileReader errors — with FileReader (readAsArrayBuffer) as the last-resort
 * fallback. The thrown message keeps the pre-fix "Failed to read file" prefix
 * (the banner oracle) and appends the underlying failure.
 *
 * CDX-068: BOTH paths carry a deadline. A `content://` provider that stalls
 * rather than fails resolves neither path's promise and fires neither
 * `onload` nor `onerror` — pre-fix that meant this function never returned,
 * the composer's `finally` never ran, and the spinner and the disabled
 * ✕/Send stayed put until the user left the screen. A read that outlives its
 * budget now throws like any other read failure, through the same banner.
 *
 * Exported for the DM image path too (CDX-086), which shares this reader.
 */
export async function readFileBytes(file: File): Promise<ArrayBuffer> {
  const startedAt = Date.now();
  let primaryError: unknown;
  if (typeof file.arrayBuffer === 'function') {
    try {
      return await withDeadline(file.arrayBuffer(), IMAGE_READ_TIMEOUT_MS, 'File.arrayBuffer');
    } catch (err) {
      primaryError = err;
    }
  } else {
    primaryError = new Error('File.arrayBuffer unavailable');
  }
  const fallbackBudget = Math.max(
    FALLBACK_MIN_BUDGET_MS,
    IMAGE_READ_TIMEOUT_MS - (Date.now() - startedAt),
  );
  try {
    return await readFileViaReader(file, fallbackBudget);
  } catch (fallbackError) {
    throw new Error(
      `Failed to read file (${describeError(primaryError)}; FileReader fallback: ${describeError(fallbackError)})`,
    );
  }
}

function readFileViaReader(file: File, budgetMs: number): Promise<ArrayBuffer> {
  const reader = new FileReader();
  const read = new Promise<ArrayBuffer>((resolve, reject) => {
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
    reader.onabort = () => reject(new Error('FileReader aborted'));
    reader.readAsArrayBuffer(file);
  });
  return withDeadline(read, budgetMs, 'FileReader.readAsArrayBuffer', () => {
    try {
      reader.abort();
    } catch {
      // A reader too broken to abort is precisely the case we are escaping —
      // the deadline has already fired, and nothing else depends on it.
    }
  });
}

/**
 * Dimension probe. Primary: a short-lived object URL over the File (no
 * megabyte data: string), revoked in all outcomes. Fallback: a data: URL
 * built from the bytes we already read successfully.
 */
async function probeImage(
  file: File,
  buffer: ArrayBuffer,
  mimeType: string,
): Promise<HTMLImageElement> {
  const startedAt = Date.now();
  let objectUrlError: unknown;
  if (typeof URL.createObjectURL === 'function') {
    const url = URL.createObjectURL(file);
    try {
      return await loadImage(url, IMAGE_PROBE_TIMEOUT_MS);
    } catch (err) {
      objectUrlError = err;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  // Share ONE budget across both paths, floored so a primary that burned it all
  // still leaves the fallback a chance (same reasoning as the read budget).
  const left = Math.max(
    PROBE_FALLBACK_MIN_BUDGET_MS,
    remainingBudget(startedAt, IMAGE_PROBE_TIMEOUT_MS, Date.now),
  );
  try {
    return await loadImage(`data:${mimeType};base64,${arrayBufferToBase64(buffer)}`, left);
  } catch (err) {
    throw new Error(
      `Failed to load image (${describeError(objectUrlError ?? err)})`,
    );
  }
}

/**
 * CDX-086: the one read stage CDX-068 left unbounded.
 *
 * `probeImage` only fell through to the data: URL when `loadImage` REJECTED, so a
 * provider that fires neither `onload` nor `onerror` hung inside the primary
 * branch forever — and the composer's spinner with it. With a deadline the
 * primary rejects, the existing fallback runs, and the whole thing terminates.
 * processImageFile.test.ts documents the hazard directly: "jsdom never decodes
 * images (Image.onload would hang forever)".
 */
function loadImage(src: string, budgetMs: number): Promise<HTMLImageElement> {
  const img = new Image();
  const work = new Promise<HTMLImageElement>((resolve, reject) => {
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = src;
  });
  return withDeadline(work, budgetMs, 'image decode', () => {
    // Teardown symmetrical to the FileReader.abort() above: drop the callbacks
    // and cancel the load so a stalled decode is not left holding the source.
    img.onload = null;
    img.onerror = null;
    try {
      img.src = '';
    } catch {
      // Some engines throw on an empty src; the deadline has already fired.
    }
  });
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}
