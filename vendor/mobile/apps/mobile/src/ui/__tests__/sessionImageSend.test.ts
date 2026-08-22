/**
 * Phase 5 (CDX-029): sendSessionImage orchestration, headless —
 * - Blossom success (REAL encrypt/hash pipeline, injected fake fetch) → one
 *   blossom message carrying hash/key/iv that match the uploaded blob;
 * - fetch failure → ordered relay-chunk fallback, ceil(n/35000) chunks, text
 *   only on the first, 200ms inter-chunk sleeps;
 * - total failure → throws, nothing delivered.
 */
import { describe, expect, it, vi } from 'vitest';
import { generateKeypair } from '../../core/crypto';
import { sha256Hex, uploadEncryptedImage } from '../../core/dmAttachments';
import { IMAGE_CHUNK_BYTES, IMAGE_CHUNK_DELAY_MS } from '../../core/imageChunks';
import type { PublishResult } from '../../core/ports';
import { MAX_FALLBACK_CHUNKS, sendSessionImage, type ProcessedImage, type SessionImageSendDeps } from '../imageFile';

const bytesToB64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

function image(over: Partial<ProcessedImage> = {}): ProcessedImage {
  return {
    base64: bytesToB64(new Uint8Array([1, 2, 3, 4])),
    mimeType: 'image/png',
    filename: 'shot.png',
    sizeBytes: 4,
    ...over,
  };
}

type BlossomPayload = Parameters<SessionImageSendDeps['sendBlossom']>[0];
type ChunkPayload = Parameters<SessionImageSendDeps['sendChunk']>[0];

function capture() {
  const blossom: BlossomPayload[] = [];
  const chunks: ChunkPayload[] = [];
  return {
    blossom,
    chunks,
    // CDX-086: verdicts, not booleans. `accepted` is the happy path.
    sendBlossom: async (p: BlossomPayload): Promise<PublishResult> => {
      blossom.push(p);
      return { verdict: 'accepted' };
    },
    sendChunk: async (p: ChunkPayload): Promise<PublishResult> => {
      chunks.push(p);
      return { verdict: 'accepted' };
    },
    // The signal is a REQUIRED dep so cancellation cannot be forgotten; these
    // tests are not exercising cancellation, so hand over a live one.
    signal: new AbortController().signal,
  };
}

describe('sendSessionImage — Blossom success', () => {
  it('runs the real encrypt pipeline through an injected fetch and emits one blossom message', async () => {
    const { secretKey } = generateKeypair();
    let uploadedBody: Uint8Array | null = null;
    let sawAuth = '';
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      uploadedBody = init?.body as unknown as Uint8Array;
      sawAuth = (init?.headers as Record<string, string>)['Authorization'] ?? '';
      return { ok: true, status: 200, statusText: 'OK' };
    }) as unknown as typeof fetch;

    const cap = capture();
    const outcome = await sendSessionImage(image(), 'here you go', {
      uploadToBlossom: (bytes: Uint8Array) =>
        uploadEncryptedImage(bytes, {
          secretKey,
          server: 'https://blossom.descendant.io',
          fetchFn: fakeFetch,
          sleep: async () => {},
        }),
      ...cap,
    });

    expect(outcome).toBe('blossom');
    expect(cap.chunks).toHaveLength(0);
    expect(cap.blossom).toHaveLength(1);
    const msg = cap.blossom[0]!;
    expect(sawAuth.startsWith('Nostr ')).toBe(true);
    // hash is the sha256 of the ENCRYPTED body that actually left over fetch,
    // and the ref URL ends in it.
    expect(msg.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(msg.hash).toBe(await sha256Hex(uploadedBody!));
    expect(msg.url).toBe(`https://blossom.descendant.io/${msg.hash}`);
    expect(msg.key).toMatch(/^[0-9a-f]{64}$/);
    expect(msg.iv).toMatch(/^[0-9a-f]{24}$/);
    expect(msg.text).toBe('here you go');
    expect(msg.filename).toBe('shot.png');
    expect(msg.mimeType).toBe('image/png');
    expect(msg.sizeBytes).toBe(4);
  });
});

describe('sendSessionImage — chunk fallback', () => {
  it('fetch failure → ceil(n/35000) ordered chunks, text on the first only, 200ms sleeps', async () => {
    const b64 = 'x'.repeat(2 * IMAGE_CHUNK_BYTES + 100); // → 3 chunks
    const cap = capture();
    const sleep = vi.fn(async () => {});

    const outcome = await sendSessionImage(image({ base64: b64 }), 'caption', {
      uploadToBlossom: async () => {
        throw new Error('Failed to fetch'); // the CDX-029 symptom
      },
      ...cap,
      sleep,
      newUploadId: () => 'upload-1',
    });

    expect(outcome).toBe('chunks');
    expect(cap.blossom).toHaveLength(0);
    expect(cap.chunks).toHaveLength(3);
    expect(cap.chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
    expect(cap.chunks.every((c) => c.totalChunks === 3 && c.uploadId === 'upload-1')).toBe(true);
    expect(cap.chunks.map((c) => c.text)).toEqual(['caption', '', '']);
    expect(cap.chunks.map((c) => c.base64Data).join('')).toBe(b64); // lossless
    expect(sleep).toHaveBeenCalledTimes(2); // between chunks only
    expect(sleep).toHaveBeenCalledWith(IMAGE_CHUNK_DELAY_MS);
  });

  // This test is the INVERSE of the one it replaces, which asserted that a
  // non-accepted reference publish fell back to chunks. That assertion WAS the
  // founder's bug: a late relay OK re-uploaded a 3 MB photo the bridge already
  // had, as ~115 sequential relay events.
  it('an UNCONFIRMED reference publish is never chunked', async () => {
    const cap = capture();
    const uploads: number[] = [];
    const outcome = await sendSessionImage(image(), 'hi', {
      ...cap,
      uploadToBlossom: async () => {
        uploads.push(1);
        return { url: 'https://b/' + 'c'.repeat(64), key: 'a'.repeat(64), iv: 'b'.repeat(24) };
      },
      sendBlossom: async () => ({ verdict: 'unconfirmed', detail: 'publish timed out' }),
      sleep: async () => {},
    });
    expect(outcome).toBe('blossom-unconfirmed');
    expect(cap.chunks).toHaveLength(0);
    expect(uploads).toHaveLength(1);
  });

  it('a REJECTED reference publish fails loudly and still never chunks', async () => {
    const cap = capture();
    await expect(
      sendSessionImage(image(), 'hi', {
        ...cap,
        uploadToBlossom: async () => ({
          url: 'https://b/' + 'c'.repeat(64),
          key: 'a'.repeat(64),
          iv: 'b'.repeat(24),
        }),
        sendBlossom: async () => ({ verdict: 'rejected', detail: 'rate-limited' }),
        sleep: async () => {},
      }),
      // The bytes are ON the server; re-sending them over relays is pure waste.
    ).rejects.toThrow(/uploaded but no relay would carry/);
    expect(cap.chunks).toHaveLength(0);
  });

  it('existingRef skips the upload entirely (a retry never re-uploads)', async () => {
    const cap = capture();
    const uploads: number[] = [];
    const outcome = await sendSessionImage(image(), 'hi', {
      ...cap,
      existingRef: { url: 'https://b/' + 'c'.repeat(64), key: 'a'.repeat(64), iv: 'b'.repeat(24) },
      uploadToBlossom: async () => {
        uploads.push(1);
        throw new Error('should not be called');
      },
    });
    expect(outcome).toBe('blossom');
    expect(uploads).toHaveLength(0);
  });
});

describe('sendSessionImage — cancellation (CDX-086)', () => {
  it('a cancel during the upload publishes nothing at all', async () => {
    const cap = capture();
    const ctl = new AbortController();
    await expect(
      sendSessionImage(image(), 'hi', {
        ...cap,
        signal: ctl.signal,
        uploadToBlossom: async () => {
          // The user hits ✕ while the PUT is in flight.
          ctl.abort();
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        },
        sleep: async () => {},
      }),
    ).rejects.toThrow(/abort/i);
    // Pre-fix this fell through to the chunk fallback and delivered the image
    // anyway — the founder's "then it turns out that the image is included".
    expect(cap.blossom).toHaveLength(0);
    expect(cap.chunks).toHaveLength(0);
  });

  it('a cancel mid-chunk-run stops publishing immediately', async () => {
    const chunks: unknown[] = [];
    const ctl = new AbortController();
    await expect(
      sendSessionImage(image({ base64: 'A'.repeat(35_000 * 5) }), 'hi', {
        signal: ctl.signal,
        uploadToBlossom: async () => {
          throw new Error('Failed to fetch');
        },
        sendBlossom: async () => ({ verdict: 'accepted' }),
        sendChunk: async (p) => {
          chunks.push(p);
          if (chunks.length === 3) ctl.abort();
          return { verdict: 'accepted' };
        },
        sleep: async () => {},
      }),
    ).rejects.toThrow(/cancelled/i);
    // Exactly the three that were already in flight — not all of them.
    expect(chunks).toHaveLength(3);
  });

  it('refuses a chunk run that cannot finish inside the bridge assembly window', async () => {
    const cap = capture();
    await expect(
      sendSessionImage(image({ base64: 'A'.repeat(35_000 * (MAX_FALLBACK_CHUNKS + 5)) }), 'hi', {
        ...cap,
        uploadToBlossom: async () => {
          throw new Error('Failed to fetch');
        },
        sleep: async () => {},
      }),
      // Fast honest failure beats a minute of spinner proving the same thing.
    ).rejects.toThrow(/too large for the relay fallback/);
    expect(cap.chunks).toHaveLength(0);
  });

  it('reports chunk progress in order', async () => {
    const seen: Array<[number, number]> = [];
    await sendSessionImage(image({ base64: 'A'.repeat(35_000 * 3) }), 'hi', {
      ...capture(),
      uploadToBlossom: async () => {
        throw new Error('Failed to fetch');
      },
      onProgress: (done, total) => seen.push([done, total]),
      sleep: async () => {},
    });
    expect(seen).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });
});

describe('sendSessionImage — total failure', () => {
  it('throws when the fallback fails too; nothing was delivered', async () => {
    const delivered: unknown[] = [];
    await expect(
      sendSessionImage(image(), 'kept draft', {
        signal: new AbortController().signal,
        uploadToBlossom: async () => {
          throw new Error('Failed to fetch');
        },
        sendBlossom: async (p) => {
          delivered.push(p);
          return { verdict: 'accepted' };
        },
        sendChunk: async () => ({ verdict: 'rejected', detail: 'no relay accepted it' }),
        sleep: async () => {},
      }),
    ).rejects.toThrow(/chunk 1\/1 failed/);
    expect(delivered).toHaveLength(0);
  });
});
