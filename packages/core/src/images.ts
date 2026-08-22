/**
 * Image upload — phone → bridge image delivery, ported from the old bridge's
 * core.ts (handleBlossomImage / handleImageChunk / assembleAndWriteImage).
 *
 * Two wire forms (see uploadImageMessageSchema):
 * - Blossom: the phone uploaded an AES-256-GCM-encrypted blob to a Blossom
 *   server and sends {hash, url, key, iv}. The bridge downloads, verifies the
 *   sha256 of the ciphertext, decrypts (auth tag = last 16 bytes), writes the
 *   image under `<uploadsDir>` and injects the path into the session input so
 *   Claude can Read it.
 * - Legacy chunked: base64 split into N chunks assembled in memory with a 60s
 *   timeout; same write + inject on completion.
 *
 * The decryption key/iv are secrets in transit — they are NEVER logged.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  UploadImageMessage,
} from '@codedeck/protocol';

type BlossomMsg = Extract<UploadImageMessage, { hash: string }>;
type ChunkMsg = Extract<UploadImageMessage, { uploadId: string }>;

interface ImageUploadTracker {
  /** Kept for the injection-dedup identity (CDX-086). */
  uploadId: string;
  sessionId: string;
  filename: string;
  mimeType: string;
  text: string;
  totalChunks: number;
  received: Map<number, string>;
  timeoutId: ReturnType<typeof setTimeout>;
}

export interface ImageUploadDeps {
  /** Where finished images land (created on demand). Old bridge:
   *  `<workspaceRoot>/.codedeck/uploads`. */
  uploadsDir(): string;
  /** Inject the "[Attached image: …]" text into the session. False = no live session. */
  sendInput(sessionId: string, text: string): boolean;
  log(msg: string): void;
  /** Injectable for tests (Blossom download). Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Chunk-assembly timeout override (tests). Default 60s. */
  assemblyTimeoutMs?: number;
  now?: () => number;
}

const DEFAULT_ASSEMBLY_TIMEOUT_MS = 60_000;

/** How long a (session, image, caption) triple counts as a duplicate. */
const INJECT_DEDUP_WINDOW_MS = 10 * 60_000;
const INJECT_DEDUP_CAP = 200;

/** Wall clock for the bridge's own download of an uploaded blob. */
const BRIDGE_BLOSSOM_TIMEOUT_MS = 60_000;

/** Build the text injected into the session for a saved image (ported). */
function imageInputText(userText: string, filePath: string): string {
  const trimmed = userText.trim();
  return trimmed
    ? `${trimmed}\n\n[Attached image: ${filePath} — use the Read tool to view it]`
    : `Please examine this image: ${filePath}`;
}

export class ImageUploadHandler {
  /** CDX-013: hard cap on a Blossom blob (phone photos are a few MB; 25MB
   *  leaves headroom without letting a hostile message buffer the bridge into
   *  an OOM). */
  static readonly MAX_BLOSSOM_BYTES = 25 * 1024 * 1024;

  private readonly imageChunks = new Map<string, ImageUploadTracker>();
  /** injectKey -> timestamp. Bounded; see alreadyInjected (CDX-086). */
  private readonly injected = new Map<string, number>();

  constructor(private readonly deps: ImageUploadDeps) {}

  /** Route one upload-image message. Never throws (async work is contained). */
  handle(msg: UploadImageMessage): void {
    if ('hash' in msg) {
      void this.handleBlossomImage(msg).catch((err) => {
        this.deps.log(`[Images] Blossom image handling failed: ${err}`);
      });
    } else {
      this.handleImageChunk(msg);
    }
  }

  /** Abandon in-flight chunk assemblies (shutdown). */
  dispose(): void {
    for (const tracker of this.imageChunks.values()) {
      clearTimeout(tracker.timeoutId);
    }
    this.imageChunks.clear();
  }

  // --- Blossom (encrypted blob) ---

  private async handleBlossomImage(msg: BlossomMsg): Promise<void> {
    // CDX-013: the URL is phone-supplied — refuse anything that would turn the
    // bridge into a generic HTTP client (SSRF) or an OOM target. https only
    // (the Blossom server is a public https host by design), and the body is
    // size-capped instead of trusting the claimed sizeBytes.
    let parsed: URL;
    try {
      parsed = new URL(msg.url);
    } catch {
      throw new Error('Blossom download refused: invalid URL');
    }
    if (parsed.protocol !== 'https:') {
      throw new Error('Blossom download refused: https required');
    }
    if (msg.sizeBytes > ImageUploadHandler.MAX_BLOSSOM_BYTES) {
      throw new Error(
        `Blossom download refused: ${msg.sizeBytes} bytes exceeds the ${ImageUploadHandler.MAX_BLOSSOM_BYTES}-byte cap`,
      );
    }
    this.deps.log(`[Images] Blossom image: downloading ${msg.url} (${msg.sizeBytes} bytes)`);
    const fetchFn = this.deps.fetchFn ?? fetch;

    // CDX-086: unbounded before — a hung Blossom GET never logged and never
    // resolved, so the handler's promise stayed pending for the process's life.
    const response = await fetchFn(msg.url, {
      signal: AbortSignal.timeout(BRIDGE_BLOSSOM_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Blossom download failed: ${response.status} ${response.statusText}`);
    }
    const encryptedBytes = new Uint8Array(await response.arrayBuffer());
    if (encryptedBytes.byteLength > ImageUploadHandler.MAX_BLOSSOM_BYTES) {
      throw new Error(
        `Blossom download refused: body exceeds the ${ImageUploadHandler.MAX_BLOSSOM_BYTES}-byte cap`,
      );
    }

    const hashHex = crypto.createHash('sha256').update(encryptedBytes).digest('hex');
    if (hashHex !== msg.hash) {
      throw new Error(`Hash mismatch: expected ${msg.hash}, got ${hashHex}`);
    }

    const key = Buffer.from(msg.key, 'hex');
    const iv = Buffer.from(msg.iv, 'hex');
    const authTag = encryptedBytes.slice(-16);
    const ciphertext = encryptedBytes.slice(0, -16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    const filePath = this.writeImage(msg.filename, msg.mimeType, decrypted);
    if (!filePath) return;
    this.deps.log(`[Images] Blossom image saved: ${filePath} (${decrypted.length} bytes)`);
    // The content hash identifies the image for dedup — a resend of the same
    // photo with the same caption is the case worth suppressing (CDX-086).
    this.inject(msg.sessionId, msg.text, filePath, msg.hash);
  }

  // --- Legacy chunk assembly ---

  /**
   * CDX-086: the assembly timeout is IDLE-based, re-armed on every accepted
   * chunk, rather than a single deadline armed once on the first one.
   *
   * The old form meant "60 s total", and the phone's fallback is inherently
   * serial: ~115 chunks for a 3 MB photo, each with a 200 ms courtesy gap, each
   * waiting on a relay OK. That routinely exceeded 60 s, so the bridge discarded
   * the tracker WHILE the phone was still dutifully publishing into it — the
   * bridge half of "it takes forever and nothing arrives". Idle-based means the
   * window only expires when the phone actually goes quiet.
   */
  private armAssemblyTimeout(uploadId: string, totalChunks: number): ReturnType<typeof setTimeout> {
    const timeoutId = setTimeout(() => {
      const t = this.imageChunks.get(uploadId);
      this.deps.log(
        `[Images] Image upload ${uploadId} timed out (received ${t?.received.size ?? 0}/${totalChunks} chunks)`,
      );
      this.imageChunks.delete(uploadId);
    }, this.deps.assemblyTimeoutMs ?? DEFAULT_ASSEMBLY_TIMEOUT_MS);
    timeoutId.unref?.();
    return timeoutId;
  }

  private handleImageChunk(msg: ChunkMsg): void {
    let tracker = this.imageChunks.get(msg.uploadId);

    if (!tracker) {
      tracker = {
        uploadId: msg.uploadId,
        sessionId: msg.sessionId,
        filename: msg.filename,
        mimeType: msg.mimeType,
        text: msg.text,
        totalChunks: msg.totalChunks,
        received: new Map(),
        timeoutId: this.armAssemblyTimeout(msg.uploadId, msg.totalChunks),
      };
      this.imageChunks.set(msg.uploadId, tracker);
    }

    if (msg.chunkIndex < 0 || msg.chunkIndex >= msg.totalChunks) {
      this.deps.log(`[Images] Image chunk ${msg.chunkIndex} out of range [0, ${msg.totalChunks}) — skipping`);
      return;
    }
    tracker.received.set(msg.chunkIndex, msg.base64Data);
    // Progress refreshes the idle window.
    clearTimeout(tracker.timeoutId);
    tracker.timeoutId = this.armAssemblyTimeout(msg.uploadId, tracker.totalChunks);
    if (msg.chunkIndex === 0 && msg.text) {
      tracker.text = msg.text;
    }

    this.deps.log(`[Images] Image chunk ${msg.chunkIndex + 1}/${msg.totalChunks} for upload ${msg.uploadId}`);

    if (tracker.received.size >= tracker.totalChunks) {
      clearTimeout(tracker.timeoutId);
      this.imageChunks.delete(msg.uploadId);
      this.assembleAndWriteImage(tracker);
    }
  }

  private assembleAndWriteImage(tracker: ImageUploadTracker): void {
    const parts: string[] = [];
    for (let i = 0; i < tracker.totalChunks; i++) {
      const chunk = tracker.received.get(i);
      if (chunk === undefined) {
        this.deps.log(`[Images] Missing chunk ${i} for image upload — aborting`);
        return;
      }
      parts.push(chunk);
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(parts.join(''), 'base64');
    } catch (err) {
      this.deps.log(`[Images] Failed to decode image data: ${err}`);
      return;
    }

    const filePath = this.writeImage(tracker.filename, tracker.mimeType, buffer);
    if (!filePath) return;
    this.deps.log(`[Images] Image saved: ${filePath} (${buffer.length} bytes)`);
    this.inject(tracker.sessionId, tracker.text, filePath, `upload:${tracker.uploadId}`);
  }

  // --- Shared write + inject (ported filename hygiene) ---

  private writeImage(filename: string, mimeType: string, data: Buffer): string | null {
    const uploadsDir = this.deps.uploadsDir();
    try {
      fs.mkdirSync(uploadsDir, { recursive: true });
    } catch (err) {
      this.deps.log(`[Images] Failed to create uploads dir: ${err}`);
      return null;
    }

    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const ext = mimeType === 'image/png' ? '.png' : '.jpg';
    const timestamp = (this.deps.now ?? Date.now)();
    const hasExt = safeName.toLowerCase().endsWith(ext);
    const finalName = `${timestamp}-${safeName}${hasExt ? '' : ext}`;
    const filePath = path.join(uploadsDir, finalName);

    try {
      fs.writeFileSync(filePath, data);
      return filePath;
    } catch (err) {
      this.deps.log(`[Images] Failed to write image: ${err}`);
      return null;
    }
  }

  /**
   * CDX-086: inject at most once per (session, image, caption) inside a window.
   *
   * The phone can now report a reference publish as `unconfirmed` — the frame
   * reached an open socket but no relay confirmed it — and the honest advice to
   * the user is "if it doesn't appear, send it again". That advice is only safe
   * if a resend is idempotent HERE too. The relay-level dedup is by event id, and
   * a resend is a genuinely new event, so it cannot help.
   *
   * Keyed on the caption as well as the image, so asking a second question about
   * the SAME photo still works — that is a real thing users do, and it must not
   * be mistaken for a duplicate.
   */
  private injectKey(sessionId: string, identity: string, userText: string): string {
    const textHash = crypto.createHash('sha256').update(userText).digest('hex').slice(0, 16);
    return `${sessionId}|${identity}|${textHash}`;
  }

  private alreadyInjected(key: string, now: number): boolean {
    const at = this.injected.get(key);
    if (at !== undefined && now - at < INJECT_DEDUP_WINDOW_MS) return true;
    this.injected.set(key, now);
    // Bounded, oldest-first — Map preserves insertion order.
    while (this.injected.size > INJECT_DEDUP_CAP) {
      const oldest = this.injected.keys().next();
      if (oldest.done) break;
      this.injected.delete(oldest.value);
    }
    return false;
  }

  private inject(
    sessionId: string,
    userText: string,
    filePath: string,
    identity?: string,
  ): void {
    if (identity !== undefined) {
      const key = this.injectKey(sessionId, identity, userText);
      if (this.alreadyInjected(key, (this.deps.now ?? Date.now)())) {
        this.deps.log(
          `[Images] Duplicate image injection for ${sessionId} suppressed (${identity.slice(0, 16)})`,
        );
        return;
      }
    }
    const sent = this.deps.sendInput(sessionId, imageInputText(userText, filePath));
    if (!sent) {
      this.deps.log(`[Images] No live session for image upload to ${sessionId}`);
    }
  }
}
