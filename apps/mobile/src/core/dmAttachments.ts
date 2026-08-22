/**
 * DM image attachments (CDX-011, the 5b Blossom deferral) — the pure logic,
 * ported from the old app's blossomUpload.ts + DmConversationView send path.
 *
 * Wire format (unchanged from the old app, so old↔new clients interop):
 * an attachment is ONE LINE appended to the plain NIP-17 message content:
 *
 *     <blossom-url> key=<aes-key-hex 64> iv=<gcm-iv-hex 24>
 *
 * The blob on the Blossom server is the AES-256-GCM ciphertext; the key+iv
 * travel only inside the NIP-44/NIP-59 encrypted DM. Upload auth is BUD-02: a
 * signed kind-24242 event in the Authorization header, signed with the
 * phone's own nostr key.
 *
 * The old app rendered received refs as raw text — the new renderer parses
 * them into inline images (parseDmContent below) with tap-to-open.
 *
 * Everything here is injectable-fetch and unit-tested; the platform layer
 * (platform/dmImages.ts) binds real fetch + object URLs.
 */
import { finalizeEvent } from 'nostr-tools/pure';
import { isCancelled, remainingBudget, throwIfCancelled, withDeadline } from './deadline';

export const DEFAULT_BLOSSOM_SERVER = 'https://blossom.descendant.io';

/** Fail fast when the host is unreachable, separately from the body timeout. */
const BLOSSOM_CONNECT_TIMEOUT_MS = 10_000;

/** BUD-02 authorization event kind. */
export const BLOSSOM_AUTH_KIND = 24242;

// --- Content parsing (render side) ---

export interface EncryptedImageRef {
  url: string;
  /** AES-256 key, 64 hex chars. */
  key: string;
  /** AES-GCM IV, 24 hex chars. */
  iv: string;
}

export type DmSegment =
  | { kind: 'text'; text: string }
  | { kind: 'image'; ref: EncryptedImageRef }
  | { kind: 'imageUrl'; url: string };

/** One encrypted-attachment line, exactly as the old app emitted it. */
const IMAGE_REF_LINE = /^(https?:\/\/\S+)\s+key=([0-9a-f]{64})\s+iv=([0-9a-f]{24})$/i;

/** A bare image URL on its own line (foreign clients send these). */
const PLAIN_IMAGE_LINE = /^https?:\/\/\S+\.(png|jpe?g|gif|webp|avif)(\?\S*)?$/i;

/** Build the attachment line for the send path. */
export function buildImageRef(ref: EncryptedImageRef): string {
  return `${ref.url} key=${ref.key} iv=${ref.iv}`;
}

/**
 * Split DM content into text / inline-image segments, line-based: only lines
 * that are EXACTLY an attachment ref or a bare image URL become images —
 * anything else (malformed key, URL mid-sentence) stays honest text.
 * Consecutive text lines merge back into one segment.
 */
export function parseDmContent(content: string): DmSegment[] {
  const segments: DmSegment[] = [];
  let textRun: string[] = [];
  const flush = (): void => {
    const text = textRun.join('\n');
    if (text.trim() !== '') segments.push({ kind: 'text', text });
    textRun = [];
  };
  for (const line of content.split('\n')) {
    const refMatch = IMAGE_REF_LINE.exec(line.trim());
    if (refMatch) {
      flush();
      segments.push({
        kind: 'image',
        ref: { url: refMatch[1]!, key: refMatch[2]!.toLowerCase(), iv: refMatch[3]!.toLowerCase() },
      });
      continue;
    }
    if (PLAIN_IMAGE_LINE.test(line.trim())) {
      flush();
      segments.push({ kind: 'imageUrl', url: line.trim() });
      continue;
    }
    textRun.push(line);
  }
  flush();
  return segments;
}

/** Conversation-list preview: attachment/image lines read as "📷 image". */
export function previewText(content: string): string {
  const segments = parseDmContent(content);
  const parts = segments.map((s) => (s.kind === 'text' ? s.text : '📷 image'));
  return parts.join(' ').trim() || content;
}

// --- Crypto (WebCrypto; identical parameters to the old app) ---

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export interface EncryptedImage {
  encrypted: Uint8Array;
  keyHex: string;
  ivHex: string;
  /** SHA-256 of the ENCRYPTED payload — the Blossom blob id. */
  sha256Hex: string;
}

/** WebCrypto wants ArrayBuffer-backed views; TS 5.7's generic typed arrays
 *  make a plain Uint8Array param `ArrayBufferLike` — this cast is the seam. */
const asBufferSource = (bytes: Uint8Array): BufferSource => bytes as unknown as BufferSource;

/** SHA-256 of raw bytes as hex (shared by encrypt + tests). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', asBufferSource(bytes))));
}

/** AES-256-GCM encrypt raw image bytes; hash the ciphertext (the blob id). */
export async function encryptImage(raw: Uint8Array): Promise<EncryptedImage> {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, asBufferSource(raw)),
  );
  return {
    encrypted,
    keyHex: bytesToHex(key),
    ivHex: bytesToHex(iv),
    sha256Hex: await sha256Hex(encrypted),
  };
}

/** Decrypt a downloaded blob with the key+iv from the message ref. */
export async function decryptImage(
  encrypted: Uint8Array,
  keyHex: string,
  ivHex: string,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', hexToBytes(keyHex), 'AES-GCM', false, [
    'decrypt',
  ]);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: hexToBytes(ivHex) },
      cryptoKey,
      asBufferSource(encrypted),
    ),
  );
}

// --- Upload (BUD-01/02; injectable fetch) ---

export interface UploadDeps {
  /** Phone nostr secret key — signs the BUD-02 auth event. */
  secretKey: Uint8Array;
  server?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  /** Retry backoff sleep (injectable; tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Caller cancellation — the composer's ✕ (CDX-086). */
  signal?: AbortSignal;
  /** Per-attempt and total budgets; tests override. */
  attemptTimeoutMs?: number;
  budgetMs?: number;
}

const RETRYABLE_STATUSES = [502, 520, 522, 523, 524];
const MAX_RETRIES = 2;

/**
 * CDX-086 — the PUT had NO timeout, NO abort signal and no total budget, on a
 * fetch that goes through @tauri-apps/plugin-http where timeouts are opt-in. So
 * the Rust client had none either, and a blackholed connection (a real risk here
 * — the app also runs a mesh VpnService) never settled. That was one of the ways
 * the composer's spinner could be pinned forever.
 *
 * Generous per attempt: this is a multi-megabyte body on mobile data, and a false
 * trip costs the user a retry.
 */
const BLOSSOM_ATTEMPT_TIMEOUT_MS = 45_000;
/** Across all attempts INCLUDING backoff, so 3 × 45 s can't become the wait. */
const BLOSSOM_TOTAL_BUDGET_MS = 60_000;
/** Don't start an attempt that cannot plausibly finish. */
const BLOSSOM_RETRY_FLOOR_MS = 10_000;

/**
 * Encrypt + upload one image; returns the ref for buildImageRef. Throws with a
 * readable message on definitive failure (the UI shows it and keeps the
 * pending attachment for retry).
 */
export async function uploadEncryptedImage(
  raw: Uint8Array,
  deps: UploadDeps,
): Promise<EncryptedImageRef> {
  const server = (deps.server ?? DEFAULT_BLOSSOM_SERVER).replace(/\/$/, '');
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const { encrypted, keyHex, ivHex, sha256Hex } = await encryptImage(raw);

  const nowSec = Math.floor(now() / 1000);
  const authEvent = finalizeEvent(
    {
      kind: BLOSSOM_AUTH_KIND,
      created_at: nowSec,
      tags: [
        ['t', 'upload'],
        ['x', sha256Hex],
        ['expiration', String(nowSec + 300)],
      ],
      content: 'Upload encrypted image via CodeDeck',
    },
    deps.secretKey,
  );
  const authHeader = `Nostr ${btoa(JSON.stringify(authEvent))}`;

  const startedAt = now();
  const totalBudget = deps.budgetMs ?? BLOSSOM_TOTAL_BUDGET_MS;
  const attemptCap = deps.attemptTimeoutMs ?? BLOSSOM_ATTEMPT_TIMEOUT_MS;

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    throwIfCancelled(deps.signal, 'Blossom upload');
    if (attempt > 0) {
      await sleep(1000 * 2 ** (attempt - 1));
      throwIfCancelled(deps.signal, 'Blossom upload');
    }
    const left = remainingBudget(startedAt, totalBudget, now);
    // Starting an attempt with almost no budget just delays the real error.
    if (attempt > 0 && left < BLOSSOM_RETRY_FLOOR_MS) break;

    // One controller per attempt, chained off the caller's signal so ✕ aborts
    // the in-flight request body rather than merely ignoring its result.
    const ctl = new AbortController();
    const onAbort = (): void => ctl.abort();
    deps.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await withDeadline(
        fetchFn(`${server}/upload`, {
          method: 'PUT',
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/octet-stream',
          },
          body: encrypted as unknown as BodyInit,
          signal: ctl.signal,
          // A plugin-http ClientOption; the WebView fetch ignores the extra key,
          // so one call site serves both transports.
          connectTimeout: BLOSSOM_CONNECT_TIMEOUT_MS,
        } as RequestInit),
        Math.max(1, Math.min(attemptCap, left)),
        'Blossom upload',
        () => ctl.abort(),
      );
      if (response.ok) {
        return { url: `${server}/${sha256Hex}`, key: keyHex, iv: ivHex };
      }
      lastError = new Error(`Blossom upload failed: ${response.status} ${response.statusText}`);
      if (!RETRYABLE_STATUSES.includes(response.status)) throw lastError;
    } catch (err) {
      if (err === lastError) throw err; // non-retryable HTTP status
      if (isCancelled(err)) throw err; // a cancel is never retried
      lastError = err instanceof Error ? err : new Error(String(err));
    } finally {
      deps.signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastError ?? new Error('Blossom upload failed after retries');
}

/** Download + decrypt an encrypted attachment. Injectable fetch for tests. */
export async function downloadEncryptedImage(
  ref: EncryptedImageRef,
  fetchFn: typeof fetch = fetch,
): Promise<Uint8Array> {
  const response = await fetchFn(ref.url);
  if (!response.ok) throw new Error(`download failed: ${response.status}`);
  const encrypted = new Uint8Array(await response.arrayBuffer());
  return decryptImage(encrypted, ref.key, ref.iv);
}
