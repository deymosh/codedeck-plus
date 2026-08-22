/**
 * DM image platform binding (CDX-011) — fetch resolution + object-URL
 * lifecycle for the pure core/dmAttachments logic.
 *
 * Network path (CDX-029): the Blossom server answers the WebView's CORS
 * preflight for PUT /upload with 204 and NO access-control-allow-* headers,
 * so the WebView blocks the authorized upload ("Failed to fetch" on Android).
 * Under Tauri we therefore resolve `fetchFn` to @tauri-apps/plugin-http's
 * fetch — the request runs in Rust, no CORS — for BOTH upload and download
 * (download worked via the root's `allow-origin: *`, but riding the same path
 * keeps one behaviour everywhere). Browser dev keeps the global fetch.
 */
import {
  DEFAULT_BLOSSOM_SERVER,
  downloadEncryptedImage,
  uploadEncryptedImage,
  type EncryptedImageRef,
} from '../core/dmAttachments';

export { DEFAULT_BLOSSOM_SERVER };

const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Resolved once per app run; falls back to the WebView fetch outside Tauri
 *  (browser dev / vitest) or if the plugin fails to load. */
let fetchFnPromise: Promise<typeof fetch> | null = null;

export function resolvePlatformFetch(): Promise<typeof fetch> {
  fetchFnPromise ??= (async () => {
    if (isTauri()) {
      try {
        const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
        return tauriFetch as typeof fetch;
      } catch (err) {
        console.log(`[DM] plugin-http unavailable, using WebView fetch: ${err}`);
      }
    }
    return fetch;
  })();
  return fetchFnPromise;
}

/**
 * Upload one image; resolves the ref for buildImageRef.
 *
 * Named for DMs, used by BOTH composers — the session path calls it too
 * (SessionScreen), which is also why the Settings field that picks the server is
 * no longer labelled "DM image server" (CDX-086).
 */
export async function uploadDmImage(
  raw: Uint8Array,
  secretKey: Uint8Array,
  server: string = DEFAULT_BLOSSOM_SERVER,
  opts?: { signal?: AbortSignal; budgetMs?: number },
): Promise<EncryptedImageRef> {
  const fetchFn = await resolvePlatformFetch();
  return uploadEncryptedImage(raw, {
    secretKey,
    server,
    fetchFn,
    ...(opts?.signal ? { signal: opts.signal } : {}),
    ...(opts?.budgetMs !== undefined ? { budgetMs: opts.budgetMs } : {}),
  });
}

/** ref-url → settled object-URL promise (decrypt once per app run; null = failed). */
const imageCache = new Map<string, Promise<string | null>>();

/**
 * Fetch + decrypt an encrypted attachment into a displayable object URL.
 * Cached per URL; resolves null on any failure (the bubble falls back to a
 * link). Object URLs live for the app session — DM volume is capped smalltalk.
 */
export function fetchDecryptedImage(ref: EncryptedImageRef): Promise<string | null> {
  const cached = imageCache.get(ref.url);
  if (cached) return cached;
  const promise = resolvePlatformFetch()
    .then((fetchFn) => downloadEncryptedImage(ref, fetchFn))
    .then((bytes) => URL.createObjectURL(new Blob([bytes as unknown as BlobPart])))
    .catch((err) => {
      console.log(`[DM] attachment fetch/decrypt failed: ${err}`);
      imageCache.delete(ref.url); // allow a retry on next mount
      return null;
    });
  imageCache.set(ref.url, promise);
  return promise;
}
