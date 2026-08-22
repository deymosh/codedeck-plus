// @vitest-environment jsdom
/**
 * CDX-064 — "Image upload failed: Failed to read file" on the session
 * composer (Tauri v2 Android WebView, content://-backed picked File:
 * FileReader.onerror fired and the whole flow died).
 *
 * processImageFile is now robust in order: bytes via `file.arrayBuffer()`
 * first, FileReader (readAsArrayBuffer) only as the last resort; the
 * dimension probe uses `URL.createObjectURL(file)` (revoked in all outcomes)
 * with a data: URL from the already-read bytes as fallback; and a total read
 * failure throws with the underlying DOMException name/message appended so
 * the banner is diagnosable.
 *
 * jsdom never decodes images (Image.onload would hang forever), so the Image
 * element and, per-path, FileReader/createObjectURL are stubbed; the REAL
 * jsdom File/Blob arrayBuffer feeds the primary path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IMAGE_READ_TIMEOUT_MS, processImageFile } from '../imageFile';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const PNG_B64 = btoa(String.fromCharCode(...PNG_BYTES));

/** Image stub: reports fixed dimensions, "loads" on next microtask, and
 *  records every src it was asked to decode. */
const decodedSrcs: string[] = [];
class FakeImage {
  width = 640;
  height = 480;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(value: string) {
    decodedSrcs.push(value);
    queueMicrotask(() => this.onload?.());
  }
}

class BrokenImage extends FakeImage {
  override set src(value: string) {
    decodedSrcs.push(value);
    queueMicrotask(() => this.onerror?.());
  }
}

const realImage = globalThis.Image;
const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;
const realFileReader = globalThis.FileReader;

beforeEach(() => {
  decodedSrcs.length = 0;
  (globalThis as Record<string, unknown>)['Image'] = FakeImage;
});

afterEach(() => {
  vi.useRealTimers();
  (globalThis as Record<string, unknown>)['Image'] = realImage;
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
  (globalThis as Record<string, unknown>)['FileReader'] = realFileReader;
});

/** A File whose arrayBuffer() rejects like a dead content:// stream. */
function fileWithBrokenArrayBuffer(err: unknown): File {
  const file = new File([PNG_BYTES], 'shot.png', { type: 'image/png' });
  Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.reject(err) });
  return file;
}

/** A File whose arrayBuffer() never settles — the CDX-068 provider: it does
 *  not fail, it STALLS, so no rejection ever reaches the fallback. */
function fileWithStalledArrayBuffer(): File {
  const file = new File([PNG_BYTES], 'shot.png', { type: 'image/png' });
  Object.defineProperty(file, 'arrayBuffer', {
    value: () => new Promise<ArrayBuffer>(() => {}),
  });
  return file;
}

function domException(name: string, message: string): DOMException {
  return new DOMException(message, name);
}

describe('processImageFile — primary path (CDX-064)', () => {
  it('reads bytes via file.arrayBuffer and probes dimensions via a revoked object URL — FileReader never runs', async () => {
    const created: string[] = [];
    const revoked: string[] = [];
    URL.createObjectURL = ((blob: Blob) => {
      void blob;
      const url = `blob:fake-${created.length}`;
      created.push(url);
      return url;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((url: string) => {
      revoked.push(url);
    }) as typeof URL.revokeObjectURL;
    // Prove the reader is untouched on the happy path.
    (globalThis as Record<string, unknown>)['FileReader'] = class {
      constructor() {
        throw new Error('FileReader must not be constructed on the primary path');
      }
    };

    const file = new File([PNG_BYTES], 'my photo (1).png', { type: 'image/png' });
    const out = await processImageFile(file);

    expect(out.base64).toBe(PNG_B64);
    expect(out.mimeType).toBe('image/png');
    expect(out.filename).toBe('my_photo__1_.png');
    expect(created).toHaveLength(1);
    expect(revoked).toEqual(created); // revoked after the probe
    expect(decodedSrcs).toEqual(created); // probed the object URL, not a data: URL
  });

  it('falls back to a data: URL probe when the object-URL decode fails', async () => {
    (globalThis as Record<string, unknown>)['Image'] = BrokenImage;
    let attempts = 0;
    (globalThis as Record<string, unknown>)['Image'] = class extends FakeImage {
      override set src(value: string) {
        decodedSrcs.push(value);
        attempts++;
        // First (object URL) decode fails; the data: fallback succeeds.
        if (attempts === 1) queueMicrotask(() => this.onerror?.());
        else queueMicrotask(() => this.onload?.());
      }
    };
    const revoked: string[] = [];
    URL.createObjectURL = (() => 'blob:fake-0') as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((url: string) => {
      revoked.push(url);
    }) as typeof URL.revokeObjectURL;

    const out = await processImageFile(new File([PNG_BYTES], 'shot.png', { type: 'image/png' }));
    expect(out.base64).toBe(PNG_B64);
    expect(revoked).toEqual(['blob:fake-0']); // revoked even on failure
    expect(decodedSrcs[1]).toBe(`data:image/png;base64,${PNG_B64}`);
  });
});

describe('processImageFile — FileReader fallback and the error surface', () => {
  it('arrayBuffer rejection falls back to FileReader (readAsArrayBuffer) and still succeeds', async () => {
    URL.createObjectURL = (() => 'blob:fake-0') as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
    (globalThis as Record<string, unknown>)['FileReader'] = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      error: unknown = null;
      result: ArrayBuffer | null = null;
      readAsArrayBuffer(_file: File): void {
        void _file;
        this.result = PNG_BYTES.slice().buffer;
        queueMicrotask(() => this.onload?.());
      }
    };

    const file = fileWithBrokenArrayBuffer(domException('NotReadableError', 'stream gone'));
    const out = await processImageFile(file);
    expect(out.base64).toBe(PNG_B64);
  });

  it('both read paths dead → the throw keeps the "Failed to read file" prefix AND names the DOMException', async () => {
    (globalThis as Record<string, unknown>)['FileReader'] = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      error: unknown = domException('SecurityError', 'denied by provider');
      readAsArrayBuffer(_file: File): void {
        void _file;
        queueMicrotask(() => this.onerror?.());
      }
    };

    const file = fileWithBrokenArrayBuffer(domException('NotReadableError', 'content:// stream closed'));
    const err = await processImageFile(file).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    // Pre-fix the banner read exactly "Image upload failed: Failed to read
    // file" — the prefix survives, the diagnosis is new.
    expect(err!.message).toMatch(/^Failed to read file \(/);
    expect(err!.message).toContain('NotReadableError: content:// stream closed');
    expect(err!.message).toContain('SecurityError: denied by provider');
  });
});

/**
 * CDX-068 — a provider that STALLS rather than fails. Neither read path had a
 * deadline, so `processImageFile` never returned, the composer's `finally`
 * never ran, and the spinner + disabled ✕/Send stayed put until the user left
 * the screen — strictly less recoverable than the CDX-064 failure it replaced.
 */
describe('processImageFile — stalled reads have a deadline (CDX-068)', () => {
  it('a stalled arrayBuffer trips its deadline and the FileReader fallback still completes the read', async () => {
    vi.useFakeTimers();
    URL.createObjectURL = (() => 'blob:fake-0') as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
    (globalThis as Record<string, unknown>)['FileReader'] = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      error: unknown = null;
      result: ArrayBuffer | null = null;
      readAsArrayBuffer(): void {
        this.result = PNG_BYTES.slice().buffer;
        queueMicrotask(() => this.onload?.());
      }
      abort(): void {}
    };

    const pending = processImageFile(fileWithStalledArrayBuffer());
    await vi.advanceTimersByTimeAsync(IMAGE_READ_TIMEOUT_MS + 1);
    // The stall is a read FAILURE, not a hang: the fallback ran and won.
    const out = await pending;
    expect(out.base64).toBe(PNG_B64);
  });

  it('both paths stall → a named timeout through the same banner, and the dead FileReader is aborted', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    (globalThis as Record<string, unknown>)['FileReader'] = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      error: unknown = null;
      result: ArrayBuffer | null = null;
      readAsArrayBuffer(): void {
        calls.push('read'); // the stall: neither onload nor onerror, ever
      }
      abort(): void {
        calls.push('abort');
        this.onabort?.();
      }
    };

    const settled = processImageFile(fileWithStalledArrayBuffer()).then(
      () => null,
      (e: unknown) => e as Error,
    );
    await vi.advanceTimersByTimeAsync(IMAGE_READ_TIMEOUT_MS + 1); // primary deadline
    await vi.advanceTimersByTimeAsync(5_000 + 1); // the fallback's 5 s floor
    const err = await settled;

    expect(err).toBeInstanceOf(Error);
    // Same prefix the banner has always shown, so check 38's oracle still reads.
    expect(err!.message).toMatch(/^Failed to read file \(/);
    expect(err!.message).toContain(
      `TimeoutError: File.arrayBuffer timed out after ${IMAGE_READ_TIMEOUT_MS} ms`,
    );
    // The budget is shared: a primary that burned all 30 s leaves the fallback
    // its 5 s floor, so the whole read is bounded at ~35 s, not 2 × 30 s.
    expect(err!.message).toContain('TimeoutError: FileReader.readAsArrayBuffer timed out after 5000 ms');
    // The stalled reader is torn down, not left holding the dead stream.
    expect(calls).toEqual(['read', 'abort']);
  });
});
