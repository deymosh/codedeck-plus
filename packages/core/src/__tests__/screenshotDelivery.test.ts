/** screenshotDelivery — downscale + inline-entry building (pngjs, pure JS). */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PNG } from 'pngjs';
import { buildScreenshotEntry, downscalePng } from '../mesh/screenshotDelivery';

function makePng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 200; // R
    png.data[i + 1] = 50; // G
    png.data[i + 2] = 50; // B
    png.data[i + 3] = 255; // A
  }
  return PNG.sync.write(png);
}

describe('downscalePng', () => {
  it('caps the long edge and keeps aspect ratio', () => {
    const input = makePng(100, 50);
    const out = downscalePng(input, 10);
    expect(out.width).toBe(10);
    expect(out.height).toBe(5);
    const decoded = PNG.sync.read(out.buffer);
    expect(decoded.width).toBe(10);
    expect(decoded.data[0]).toBe(200); // pixel content survives
  });

  it('leaves already-small images untouched dimensionally', () => {
    const input = makePng(30, 20);
    const out = downscalePng(input, 720);
    expect(out.width).toBe(30);
    expect(out.height).toBe(20);
  });
});

describe('buildScreenshotEntry', () => {
  it('builds a tool_result entry with an inline data URI + device metadata', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-'));
    const file = path.join(dir, 'cap.png');
    fs.writeFileSync(file, makePng(1080, 2400));
    try {
      const built = buildScreenshotEntry(file, '10.44.0.9:37123', { maxEdge: 240 });
      expect(built).not.toBeNull();
      expect(built!.entry.entryType).toBe('tool_result');
      const meta = built!.entry.metadata!;
      expect(meta.special).toBe('device_screenshot');
      expect(String(meta.imageDataUri)).toMatch(/^data:image\/png;base64,/);
      expect(meta.imageWidth).toBe(108);
      expect(meta.imageHeight).toBe(240);
      expect(meta.deviceSerial).toBe('10.44.0.9:37123');
      expect(built!.sizeBytes).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when the artifact cannot be read', () => {
    expect(buildScreenshotEntry('/definitely/not/here.png', 'x')).toBeNull();
  });
});
