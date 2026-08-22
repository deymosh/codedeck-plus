/**
 * Screenshot delivery — downscale a captured device PNG and deliver it to the
 * phone inline. Ported verbatim from codedeck-bridge-vscode/src/screenshotDelivery.ts.
 *
 * Spike 0B established that the *transfer* (not capture) is the bottleneck on
 * weak links, so we never ship the raw multi-MB PNG: we downscale to a small
 * PNG (default max 720px on the long edge) with pngjs (pure JS — no fragile
 * native deps), base64-embed it in an output entry's metadata, and publish
 * over the existing output path. The phone's transcript view renders the
 * inline image from metadata.
 *
 * Retention: these ride the normal stored output events. Payloads are bounded
 * by the downscale, so no reaper is needed; old events age out of the relay
 * normally (NIP-40 expiry on the 4516 class).
 */

import { PNG } from 'pngjs';
import * as fs from 'node:fs';
import type { OutputEntry } from '@codedeck/protocol';

export interface ScreenshotDeliveryOptions {
  /** Long-edge cap for the delivered image. Default 720px. */
  maxEdge?: number;
}

/** Nearest-neighbour downscale of an RGBA PNG to a long-edge cap. Returns a new PNG buffer. */
export function downscalePng(
  input: Buffer,
  maxEdge = 720,
): { buffer: Buffer; width: number; height: number } {
  const src = PNG.sync.read(input);
  const { width: sw, height: sh } = src;
  const longEdge = Math.max(sw, sh);
  const scale = longEdge > maxEdge ? maxEdge / longEdge : 1;
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));

  if (scale === 1) {
    // Already small enough — re-emit as-is.
    return { buffer: PNG.sync.write(src), width: sw, height: sh };
  }

  const dst = new PNG({ width: dw, height: dh });
  for (let y = 0; y < dh; y++) {
    const syRow = Math.min(sh - 1, Math.floor(y / scale)) * sw;
    const dyRow = y * dw;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor(x / scale));
      const si = (syRow + sx) << 2;
      const di = (dyRow + x) << 2;
      dst.data[di] = src.data[si]!;
      dst.data[di + 1] = src.data[si + 1]!;
      dst.data[di + 2] = src.data[si + 2]!;
      dst.data[di + 3] = src.data[si + 3]!;
    }
  }
  return { buffer: PNG.sync.write(dst), width: dw, height: dh };
}

/**
 * Build an OutputEntry carrying a downscaled screenshot as a base64 data URI
 * in metadata. The phone renders `metadata.imageDataUri` inline. Returns null
 * if the file can't be read.
 */
export function buildScreenshotEntry(
  artifactPath: string,
  serial: string,
  opts?: ScreenshotDeliveryOptions,
): { entry: OutputEntry; sizeBytes: number } | null {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(artifactPath);
  } catch {
    return null;
  }
  let small: { buffer: Buffer; width: number; height: number };
  try {
    small = downscalePng(raw, opts?.maxEdge ?? 720);
  } catch {
    // If decode fails for any reason, fall back to the raw bytes (still works, just larger).
    small = { buffer: raw, width: 0, height: 0 };
  }
  const dataUri = `data:image/png;base64,${small.buffer.toString('base64')}`;
  return {
    entry: {
      entryType: 'tool_result',
      content: `Screenshot of ${serial} (${small.width}x${small.height})`,
      timestamp: new Date().toISOString(),
      metadata: {
        special: 'device_screenshot',
        imageDataUri: dataUri,
        imageWidth: small.width,
        imageHeight: small.height,
        deviceSerial: serial,
      },
    },
    sizeBytes: small.buffer.length,
  };
}
