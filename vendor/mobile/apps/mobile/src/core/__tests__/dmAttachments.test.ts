/**
 * CDX-011: DM image attachments — the pure Blossom logic (ported from the old
 * app's blossomUpload.ts): wire-format parse/build, AES-256-GCM round-trip,
 * BUD-02 upload with an injected fetch (auth event verified, hash checked),
 * retry semantics, download+decrypt.
 */
import { describe, it, expect } from 'vitest';
import { verifyEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/core';
import { generateKeypair } from '../crypto';
import {
  BLOSSOM_AUTH_KIND,
  buildImageRef,
  decryptImage,
  downloadEncryptedImage,
  encryptImage,
  parseDmContent,
  previewText,
  sha256Hex,
  uploadEncryptedImage,
} from '../dmAttachments';

const REF = {
  url: 'https://blossom.example/abc123',
  key: 'a'.repeat(64),
  iv: 'b'.repeat(24),
};

describe('parseDmContent (wire format unchanged from the old app)', () => {
  it('round-trips buildImageRef and splits text around it', () => {
    const content = `look at this\n${buildImageRef(REF)}\nnice right?`;
    expect(parseDmContent(content)).toEqual([
      { kind: 'text', text: 'look at this' },
      { kind: 'image', ref: REF },
      { kind: 'text', text: 'nice right?' },
    ]);
  });

  it('image-only message and bare image URLs from foreign clients', () => {
    expect(parseDmContent(buildImageRef(REF))).toEqual([{ kind: 'image', ref: REF }]);
    expect(parseDmContent('https://img.example/cat.jpg?w=200')).toEqual([
      { kind: 'imageUrl', url: 'https://img.example/cat.jpg?w=200' },
    ]);
  });

  it('malformed refs and mid-sentence URLs stay honest text', () => {
    // short key, wrong iv length, url inside prose — none may become an image
    const cases = [
      `https://x.example/y key=${'a'.repeat(10)} iv=${'b'.repeat(24)}`,
      `https://x.example/y key=${'a'.repeat(64)} iv=${'b'.repeat(10)}`,
      'see https://img.example/cat.png for the picture',
      'not a url at all key=aa iv=bb',
    ];
    for (const content of cases) {
      expect(parseDmContent(content)).toEqual([{ kind: 'text', text: content }]);
    }
  });

  it('previewText: attachment lines read as an image marker', () => {
    expect(previewText(`dinner?\n${buildImageRef(REF)}`)).toBe('dinner? 📷 image');
    expect(previewText('plain words')).toBe('plain words');
  });
});

describe('encrypt/decrypt round-trip', () => {
  it('AES-256-GCM round-trips and hashes the CIPHERTEXT (the blob id)', async () => {
    const raw = new Uint8Array([1, 2, 3, 250, 251, 252]);
    const enc = await encryptImage(raw);
    expect(enc.keyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(enc.ivHex).toMatch(/^[0-9a-f]{24}$/);
    expect(enc.encrypted).not.toEqual(raw);
    expect(enc.sha256Hex).toBe(await sha256Hex(enc.encrypted));
    expect(await decryptImage(enc.encrypted, enc.keyHex, enc.ivHex)).toEqual(raw);
  });
});

describe('uploadEncryptedImage (injected fetch)', () => {
  const phone = generateKeypair();
  const raw = new Uint8Array([9, 8, 7, 6]);

  it('PUTs the ciphertext with a SIGNED BUD-02 auth event whose x tag is the blob hash', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const ref = await uploadEncryptedImage(raw, {
      secretKey: phone.secretKey,
      server: 'https://blossom.example/',
      fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init! });
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
      sleep: async () => {},
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://blossom.example/upload');
    const body = calls[0]!.init.body as Uint8Array;
    const bodyHash = await sha256Hex(body);
    // The auth header decodes to a valid signed kind-24242 event over that hash.
    const auth = (calls[0]!.init.headers as Record<string, string>).Authorization!;
    expect(auth.startsWith('Nostr ')).toBe(true);
    const event = JSON.parse(atob(auth.slice('Nostr '.length))) as NostrEvent;
    expect(event.kind).toBe(BLOSSOM_AUTH_KIND);
    expect(event.pubkey).toBe(phone.pubkeyHex);
    expect(verifyEvent(event)).toBe(true);
    expect(event.tags).toContainEqual(['t', 'upload']);
    expect(event.tags).toContainEqual(['x', bodyHash]);
    // The returned ref points at server/<hash> and carries usable key+iv.
    expect(ref.url).toBe(`https://blossom.example/${bodyHash}`);
    expect(await decryptImage(body, ref.key, ref.iv)).toEqual(raw);
  });

  it('retries transient 5xx then succeeds; non-retryable status throws at once', async () => {
    let attempts = 0;
    const ref = await uploadEncryptedImage(raw, {
      secretKey: phone.secretKey,
      fetchFn: (async () => {
        attempts++;
        return attempts === 1
          ? new Response('bad gateway', { status: 502, statusText: 'Bad Gateway' })
          : new Response('{}', { status: 200 });
      }) as typeof fetch,
      sleep: async () => {},
    });
    expect(attempts).toBe(2);
    expect(ref.url).toContain('blossom.descendant.io/'); // default server

    let attempts2 = 0;
    await expect(
      uploadEncryptedImage(raw, {
        secretKey: phone.secretKey,
        fetchFn: (async () => {
          attempts2++;
          return new Response('nope', { status: 403, statusText: 'Forbidden' });
        }) as typeof fetch,
        sleep: async () => {},
      }),
    ).rejects.toThrow('403');
    expect(attempts2).toBe(1); // 403 is definitive — no retry storm
  });
});

describe('downloadEncryptedImage', () => {
  it('fetches the blob and decrypts with the ref key/iv; non-ok throws', async () => {
    const raw = new Uint8Array([42, 43, 44]);
    const enc = await encryptImage(raw);
    const fetchFn = (async (url: string | URL | Request) => {
      expect(String(url)).toBe('https://blossom.example/blob');
      return new Response(enc.encrypted.slice().buffer as ArrayBuffer, { status: 200 });
    }) as typeof fetch;
    const bytes = await downloadEncryptedImage(
      { url: 'https://blossom.example/blob', key: enc.keyHex, iv: enc.ivHex },
      fetchFn,
    );
    expect(bytes).toEqual(raw);

    await expect(
      downloadEncryptedImage(
        { url: 'https://blossom.example/blob', key: enc.keyHex, iv: enc.ivHex },
        (async () => new Response('gone', { status: 404 })) as typeof fetch,
      ),
    ).rejects.toThrow('404');
  });
});
