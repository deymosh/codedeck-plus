/**
 * ImageUploadHandler — both wire forms ported from the old bridge:
 * chunked assembly (order-independent, out-of-range guard, timeout) and the
 * Blossom path (download via injected fetch, sha256 verification, AES-256-GCM
 * decrypt). Assertions run against the real filesystem in a temp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import { readdirSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ImageUploadHandler } from '../images';
import type { UploadImageMessage } from '@codedeck/protocol';

// Assigned inside the Blossom describe so the CDX-086 block can reuse them.
let encryptBlobOuter: (blob: Buffer) => { blob: Uint8Array; key: string; iv: string; hash: string };
let blossomMsgOuter: (enc: { blob: Uint8Array; key: string; iv: string; hash: string }, over?: Record<string, unknown>) => UploadImageMessage;

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); // PNG magic + header start

interface Ctx {
  dir: string;
  uploads: string;
  handler: ImageUploadHandler;
  inputs: Array<{ sessionId: string; text: string }>;
  logs: string[];
  liveSession: string | null;
  fetchQueue: Array<{ status: number; body: Uint8Array }>;
  fetched: string[];
}

let ctx: Ctx;

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codedeck-images-'));
  const c: Ctx = {
    dir,
    uploads: path.join(dir, '.codedeck', 'uploads'),
    inputs: [],
    logs: [],
    liveSession: 's1',
    fetchQueue: [],
    fetched: [],
    handler: null as unknown as ImageUploadHandler,
  };
  c.handler = new ImageUploadHandler({
    uploadsDir: () => c.uploads,
    sendInput: (sessionId, text) => {
      if (sessionId !== c.liveSession) return false;
      c.inputs.push({ sessionId, text });
      return true;
    },
    log: (msg) => c.logs.push(msg),
    fetchFn: (async (url: string | URL | Request) => {
      c.fetched.push(String(url));
      const next = c.fetchQueue.shift() ?? { status: 404, body: new Uint8Array() };
      return new Response(new Uint8Array(next.body), {
        status: next.status,
        statusText: next.status === 200 ? 'OK' : 'ERR',
      });
    }) as typeof fetch,
    assemblyTimeoutMs: 50,
  });
  ctx = c;
});

afterEach(async () => {
  ctx.handler.dispose();
  await fs.rm(ctx.dir, { recursive: true, force: true });
});

async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function chunkMsg(over: Partial<Extract<UploadImageMessage, { uploadId: string }>>): UploadImageMessage {
  return {
    type: 'upload-image',
    sessionId: 's1',
    uploadId: 'u1',
    filename: 'shot.png',
    mimeType: 'image/png',
    base64Data: '',
    text: '',
    chunkIndex: 0,
    totalChunks: 1,
    ...over,
  };
}

describe('ImageUploadHandler — chunked', () => {
  it('assembles out-of-order chunks, writes the file, and injects the path into the session', async () => {
    const b64 = PNG.toString('base64');
    const parts = [b64.slice(0, 8), b64.slice(8, 16), b64.slice(16)];
    ctx.handler.handle(chunkMsg({ chunkIndex: 2, totalChunks: 3, base64Data: parts[2]! }));
    ctx.handler.handle(chunkMsg({ chunkIndex: 0, totalChunks: 3, base64Data: parts[0]!, text: 'what is this?' }));
    ctx.handler.handle(chunkMsg({ chunkIndex: 1, totalChunks: 3, base64Data: parts[1]! }));

    await waitFor(() => ctx.inputs.length === 1);
    const files = readdirSync(ctx.uploads);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/shot\.png$/);
    expect(readFileSync(path.join(ctx.uploads, files[0]!))).toEqual(PNG);
    expect(ctx.inputs[0]!.text).toContain('what is this?');
    expect(ctx.inputs[0]!.text).toContain('[Attached image: ');
    expect(ctx.inputs[0]!.text).toContain(files[0]!);
  });

  it('sanitizes hostile filenames and appends the mime extension', async () => {
    ctx.handler.handle(chunkMsg({
      filename: '../../../etc/passwd',
      mimeType: 'image/jpeg',
      base64Data: PNG.toString('base64'),
    }));
    await waitFor(() => ctx.inputs.length === 1);
    const files = readdirSync(ctx.uploads);
    expect(files[0]).toMatch(/^\d+-\.\._\.\._\.\._etc_passwd\.jpg$/);
  });

  it('skips out-of-range chunk indexes without corrupting the tracker', async () => {
    ctx.handler.handle(chunkMsg({ chunkIndex: 5, totalChunks: 2, base64Data: 'AAAA' }));
    expect(ctx.logs.some((l) => l.includes('out of range'))).toBe(true);
    expect(ctx.inputs).toHaveLength(0);
  });

  it('abandons an incomplete upload after the assembly timeout', async () => {
    ctx.handler.handle(chunkMsg({ chunkIndex: 0, totalChunks: 2, base64Data: 'AAAA' }));
    await waitFor(() => ctx.logs.some((l) => l.includes('timed out')));
    expect(ctx.inputs).toHaveLength(0);
  });

  it('logs (does not throw) when there is no live session for the finished image', async () => {
    ctx.liveSession = null;
    ctx.handler.handle(chunkMsg({ base64Data: PNG.toString('base64') }));
    await waitFor(() => ctx.logs.some((l) => l.includes('No live session')));
    // The file is still written (matches old behavior — write, then inject).
    expect(readdirSync(ctx.uploads)).toHaveLength(1);
  });
});

describe('ImageUploadHandler — Blossom', () => {
  function encryptBlob(plaintext: Buffer): { blob: Uint8Array; key: string; iv: string; hash: string } {
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const blob = Buffer.concat([ciphertext, cipher.getAuthTag()]); // tag appended (wire format)
    return {
      blob: new Uint8Array(blob),
      key: key.toString('hex'),
      iv: iv.toString('hex'),
      hash: crypto.createHash('sha256').update(blob).digest('hex'),
    };
  }

  function blossomMsg(enc: ReturnType<typeof encryptBlob>, over: Record<string, unknown> = {}): UploadImageMessage {
    return {
      type: 'upload-image',
      sessionId: 's1',
      hash: enc.hash,
      url: 'https://blossom.example/blob',
      key: enc.key,
      iv: enc.iv,
      filename: 'photo.png',
      mimeType: 'image/png',
      text: 'look at this',
      sizeBytes: enc.blob.length,
      ...over,
    } as UploadImageMessage;
  }

  encryptBlobOuter = encryptBlob;
  blossomMsgOuter = blossomMsg;

  it('downloads, verifies the hash, decrypts, writes, and injects', async () => {
    const enc = encryptBlob(PNG);
    ctx.fetchQueue.push({ status: 200, body: enc.blob });

    ctx.handler.handle(blossomMsg(enc));
    await waitFor(() => ctx.inputs.length === 1);

    expect(ctx.fetched).toEqual(['https://blossom.example/blob']);
    const files = readdirSync(ctx.uploads);
    expect(files).toHaveLength(1);
    expect(readFileSync(path.join(ctx.uploads, files[0]!))).toEqual(PNG);
    expect(ctx.inputs[0]!.text).toContain('look at this');
    expect(ctx.inputs[0]!.text).toContain(files[0]!);
    // The decryption key/iv are secrets: never logged.
    expect(ctx.logs.join('\n')).not.toContain(enc.key);
    expect(ctx.logs.join('\n')).not.toContain(enc.iv);
  });

  it('rejects a blob whose sha256 does not match the claimed hash', async () => {
    const enc = encryptBlob(PNG);
    ctx.fetchQueue.push({ status: 200, body: enc.blob });
    ctx.handler.handle(blossomMsg(enc, { hash: 'f'.repeat(64) }));

    await waitFor(() => ctx.logs.some((l) => l.includes('Hash mismatch')));
    expect(ctx.inputs).toHaveLength(0);
    let files: string[] = [];
    try { files = readdirSync(ctx.uploads); } catch { /* dir never created */ }
    expect(files).toHaveLength(0);
  });

  it('surfaces a failed download as a log, never a throw', async () => {
    const enc = encryptBlob(PNG);
    ctx.fetchQueue.push({ status: 500, body: new Uint8Array() });
    ctx.handler.handle(blossomMsg(enc));
    await waitFor(() => ctx.logs.some((l) => l.includes('Blossom image handling failed')));
    expect(ctx.inputs).toHaveLength(0);
  });

  // --- CDX-013: SSRF / OOM hardening on the phone-supplied URL ---

  it('refuses a non-https URL without fetching (SSRF guard)', async () => {
    const enc = encryptBlob(PNG);
    ctx.fetchQueue.push({ status: 200, body: enc.blob });
    ctx.handler.handle(blossomMsg(enc, { url: 'http://169.254.169.254/latest/meta-data' }));
    await waitFor(() => ctx.logs.some((l) => l.includes('https required')));
    expect(ctx.fetched).toHaveLength(0);
    expect(ctx.inputs).toHaveLength(0);
  });

  it('refuses a garbage URL without fetching', async () => {
    const enc = encryptBlob(PNG);
    ctx.handler.handle(blossomMsg(enc, { url: 'not a url' }));
    await waitFor(() => ctx.logs.some((l) => l.includes('invalid URL')));
    expect(ctx.fetched).toHaveLength(0);
  });

  it('refuses a claimed size over the cap without fetching (OOM guard)', async () => {
    const enc = encryptBlob(PNG);
    ctx.handler.handle(blossomMsg(enc, { sizeBytes: ImageUploadHandler.MAX_BLOSSOM_BYTES + 1 }));
    await waitFor(() => ctx.logs.some((l) => l.includes('exceeds the')));
    expect(ctx.fetched).toHaveLength(0);
  });
});

/**
 * CDX-086 — the two bridge-side halves of the founder's stuck upload.
 */
describe('ImageUploadHandler — CDX-086', () => {
  it('the assembly window is IDLE-based: slow-but-progressing chunks still assemble', async () => {
    // assemblyTimeoutMs is 50 ms here. Pre-fix the deadline was armed ONCE on the
    // first chunk, so a run longer than the window was discarded MID-FLIGHT while
    // the phone kept publishing into it — a 3 MB photo is ~115 serial chunks with
    // a 200 ms gap each, so it exceeded 60 s routinely.
    const b64 = PNG.toString('base64');
    const parts = [b64.slice(0, 8), b64.slice(8, 16), b64.slice(16)];
    for (let i = 0; i < parts.length; i++) {
      ctx.handler.handle(
        chunkMsg({ base64Data: parts[i]!, chunkIndex: i, totalChunks: parts.length }),
      );
      // Each gap is under the window, but the TOTAL run is well over it.
      await new Promise((r) => setTimeout(r, 35));
    }
    expect(ctx.inputs).toHaveLength(1);
    expect(ctx.logs.some((l) => l.includes('timed out'))).toBe(false);
  });

  it('the window still expires when the phone actually goes quiet', async () => {
    ctx.handler.handle(chunkMsg({ base64Data: 'AAAA', chunkIndex: 0, totalChunks: 2 }));
    await waitFor(() => ctx.logs.some((l) => l.includes('timed out')));
    expect(ctx.inputs).toHaveLength(0);
  });

  it('a resend of the same image AND caption injects once', async () => {
    // The composer now tells the user "if it doesn't appear, send it again" for an
    // unconfirmed publish. That advice is only safe if a resend is idempotent
    // here — the relay dedup is by event id and a resend is a NEW event.
    const enc = encryptBlobOuter(PNG);
    ctx.fetchQueue.push({ status: 200, body: enc.blob });
    ctx.handler.handle(blossomMsgOuter(enc));
    await waitFor(() => ctx.inputs.length === 1);

    ctx.fetchQueue.push({ status: 200, body: enc.blob });
    ctx.handler.handle(blossomMsgOuter(enc));
    await waitFor(() => ctx.logs.some((l) => l.includes('Duplicate image injection')));
    expect(ctx.inputs).toHaveLength(1);
  });

  it('the SAME image with a DIFFERENT caption is a real second question', async () => {
    const enc = encryptBlobOuter(PNG);
    ctx.fetchQueue.push({ status: 200, body: enc.blob });
    ctx.handler.handle(blossomMsgOuter(enc, { text: 'what is this?' }));
    await waitFor(() => ctx.inputs.length === 1);

    ctx.fetchQueue.push({ status: 200, body: enc.blob });
    ctx.handler.handle(blossomMsgOuter(enc, { text: 'and what colour is it?' }));
    await waitFor(() => ctx.inputs.length === 2);
    expect(ctx.inputs).toHaveLength(2);
  });
});
