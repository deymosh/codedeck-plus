/**
 * Session image attachment helpers (Phase 5, CDX-029) — DOM-bound file
 * processing (arrayBuffer/object-URL first, FileReader only as a fallback
 * since CDX-064; canvas for oversize resizes — so it lives in ui/) plus the
 * headless send orchestrator: Blossom first, legacy relay chunks as the
 * fallback, a throw on total failure (the screen keeps the draft + staged
 * image).
 *
 * Ported from the old app's imageUtils.processImageFile +
 * bridgeService.sendRemoteImage. Screenshots stay PNG (lossless — text must
 * survive); only images exceeding 3840px on a side are resized via canvas.
 */
import type { EncryptedImageRef } from '../core/dmAttachments';
import {
  describeError,
  isCancelled,
  remainingBudget,
  throwIfCancelled,
  timeoutError,
  withDeadline,
} from '../core/deadline';
import type { PublishResult } from '../core/ports';
import {
  IMAGE_CHUNK_DELAY_MS,
  base64ToBytes,
  blossomHashFromUrl,
  chunkBase64,
} from '../core/imageChunks';

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

// --- Send orchestration (headless; deps injected for tests) ---

/** Overall wall clock for a send, all stages together. */
export const SESSION_IMAGE_SEND_BUDGET_MS = 120_000;

/**
 * Budget for the chunk fallback, measured from the FIRST chunk publish.
 *
 * 55 s, deliberately UNDER the bridge's chunk-assembly window (60 s, armed on
 * the first chunk). Publishing past that window is guaranteed waste: the bridge
 * has already dropped the tracker, so the image can never assemble no matter how
 * many chunks we send. This is the phone half of "it takes forever AND nothing
 * arrives". PAIRED CONSTANT — if the bridge's window moves, move this too.
 */
export const CHUNK_ASSEMBLY_BUDGET_MS = 55_000;

/**
 * Refuse a chunk run that cannot finish inside the window rather than spending a
 * minute proving it. At ~35 KB per chunk plus a 200 ms gap, this is roughly what
 * fits; a bigger image needs Blossom, not patience.
 */
export const MAX_FALLBACK_CHUNKS = 200;

export interface SessionImageSendDeps {
  /** Encrypt + PUT the raw bytes to Blossom (platform/dmImages.uploadDmImage). */
  uploadToBlossom(bytes: Uint8Array, opts: { signal: AbortSignal; budgetMs: number }): Promise<EncryptedImageRef>;
  /** api.uploadImageBlossom — reports the publish verdict (CDX-086). */
  sendBlossom(payload: {
    hash: string;
    url: string;
    key: string;
    iv: string;
    filename: string;
    mimeType: string;
    text: string;
    sizeBytes: number;
  }): Promise<PublishResult>;
  /** api.uploadImageChunk — the legacy relay fallback. */
  sendChunk(payload: {
    uploadId: string;
    filename: string;
    mimeType: string;
    base64Data: string;
    text: string;
    chunkIndex: number;
    totalChunks: number;
  }): Promise<PublishResult>;
  /**
   * REQUIRED, not optional. The founder pressed ✕ on a wedged upload and the
   * image was delivered anyway, because the only guard on this path ran AFTER
   * the publish. Making the signal mandatory is what stops the next author
   * forgetting it.
   */
  signal: AbortSignal;
  /** Fired the moment the blob is on the server, so a retry never re-uploads. */
  onUploaded?(ref: EncryptedImageRef): void;
  /** A previous attempt already uploaded these exact bytes — skip the PUT. */
  existingRef?: EncryptedImageRef;
  onProgress?(done: number, total: number): void;
  budgetMs?: number;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  newUploadId?(): string;
  log?(msg: string): void;
}

export type SessionImageOutcome = 'blossom' | 'blossom-unconfirmed' | 'chunks';

/**
 * Two INDEPENDENT stages, and keeping them independent is the fix.
 *
 * The bug was a collapsed distinction: "get the bytes onto a server" and "tell
 * the bridge where they are" were wrapped in one try, so a failure of EITHER was
 * answered by the same remedy — re-upload every byte over the relays. A relay OK
 * that arrived after nostr-tools' 4.4 s timeout therefore triggered ~115 chunk
 * publishes for an image the bridge had already received and injected.
 *
 * Now:
 *   stage 1  upload bytes      — ONLY its failure can reach the chunk fallback
 *   stage 2  publish reference — accepted / unconfirmed both mean done
 *   stage 3  chunk fallback    — structurally unreachable once a URL exists
 *
 * So "never re-upload bytes the server already holds" is a property of the
 * control flow rather than a rule someone has to remember.
 */
export async function sendSessionImage(
  image: ProcessedImage,
  text: string,
  deps: SessionImageSendDeps,
): Promise<SessionImageOutcome> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const budgetMs = deps.budgetMs ?? SESSION_IMAGE_SEND_BUDGET_MS;
  const left = (): number => remainingBudget(startedAt, budgetMs, now);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  throwIfCancelled(deps.signal, 'image send');

  // --- Stage 1: the bytes ---------------------------------------------------
  let ref: EncryptedImageRef | null = deps.existingRef ?? null;
  if (ref === null) {
    try {
      ref = await deps.uploadToBlossom(base64ToBytes(image.base64), {
        signal: deps.signal,
        budgetMs: left(),
      });
      deps.onUploaded?.(ref);
    } catch (err) {
      // A cancel is not a failure and must never fall through to stage 3.
      if (isCancelled(err)) throw err;
      deps.log?.(`[Image] Blossom upload failed, falling back to relay chunks: ${err}`);
      ref = null;
    }
  }

  // --- Stage 2: the reference ----------------------------------------------
  if (ref !== null) {
    throwIfCancelled(deps.signal, 'image send');
    const result = await deps.sendBlossom({
      hash: blossomHashFromUrl(ref.url),
      url: ref.url,
      key: ref.key,
      iv: ref.iv,
      filename: image.filename,
      mimeType: image.mimeType,
      text,
      sizeBytes: image.sizeBytes,
    });
    if (result.verdict === 'accepted') return 'blossom';
    // The frame reached an open socket and the bridge dedupes by event id, so
    // this is success with a caveat, not a reason to re-upload megabytes. The
    // honest confirmation the user reads is the image appearing in the
    // transcript; the composer says so.
    if (result.verdict === 'unconfirmed') return 'blossom-unconfirmed';
    // Genuinely refused. The bytes ARE on the server — chunking them again would
    // be pure waste, so fail loudly and let the caller retry with existingRef.
    throw new Error(
      `the image is uploaded but no relay would carry the message (${result.verdict}`
      + `${result.detail ? `: ${result.detail}` : ''})`,
    );
  }

  // --- Stage 3: chunk fallback (nobody holds the bytes) --------------------
  const uploadId = deps.newUploadId?.() ?? crypto.randomUUID();
  const chunks = chunkBase64(image.base64);
  if (chunks.length > MAX_FALLBACK_CHUNKS) {
    throw new Error(
      `image too large for the relay fallback (${chunks.length} chunks; the bridge `
      + `assembles for ${Math.round(CHUNK_ASSEMBLY_BUDGET_MS / 1000)}s) — the upload server is unreachable`,
    );
  }
  const chunksStartedAt = now();
  for (let i = 0; i < chunks.length; i++) {
    throwIfCancelled(deps.signal, 'image send');
    if (remainingBudget(chunksStartedAt, CHUNK_ASSEMBLY_BUDGET_MS, now) <= 0 || left() <= 0) {
      throw timeoutError(`image chunk upload (${i}/${chunks.length} sent)`, budgetMs);
    }
    const result = await deps.sendChunk({
      uploadId,
      filename: image.filename,
      mimeType: image.mimeType,
      // Chunk 0 carries the caption; the rest must not repeat it.
      text: i === 0 ? text : '',
      base64Data: chunks[i]!,
      chunkIndex: i,
      totalChunks: chunks.length,
    });
    // Same late-OK logic per chunk: unconfirmed means the frame went out.
    if (result.verdict !== 'accepted' && result.verdict !== 'unconfirmed') {
      throw new Error(
        `image chunk ${i + 1}/${chunks.length} failed to publish (${result.verdict}`
        + `${result.detail ? `: ${result.detail}` : ''})`,
      );
    }
    deps.onProgress?.(i + 1, chunks.length);
    if (i < chunks.length - 1) await sleep(IMAGE_CHUNK_DELAY_MS);
  }
  return 'chunks';
}

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
 */
/** Exported for the DM path (CDX-086), which had no read fallback at all. */
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
