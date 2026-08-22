/**
 * Pure helpers for the session image-upload path (Phase 5, CDX-029): base64
 * chunking for the legacy relay fallback transport plus small conversions.
 * Ported from the old app's imageUtils.ts — 35KB per chunk leaves room for
 * the JSON envelope + NIP-44 encryption overhead within the ~48KB relay
 * event limit. No DOM, no network — unit-tested headless.
 */

export const IMAGE_CHUNK_BYTES = 35_000;

/** Inter-chunk publish delay (relay rate-limit courtesy; old app value). */
export const IMAGE_CHUNK_DELAY_MS = 200;

/** Split a base64 string into relay-safe pieces, in order, lossless. */
export function chunkBase64(base64: string, maxChunkBytes: number = IMAGE_CHUNK_BYTES): string[] {
  if (base64.length <= maxChunkBytes) {
    return [base64];
  }
  const chunks: string[] = [];
  for (let i = 0; i < base64.length; i += maxChunkBytes) {
    chunks.push(base64.slice(i, i + maxChunkBytes));
  }
  return chunks;
}

/** Decode base64 (no data: prefix) to raw bytes — the Blossom upload input. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Blossom blob id from a ref URL — `uploadEncryptedImage` builds the URL as
 * `${server}/${sha256Hex}`, so the id is the last path segment (the
 * upload-image blossom message carries it as `hash`).
 */
export function blossomHashFromUrl(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1);
}
