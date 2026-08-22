/**
 * Phase 5 (CDX-029): pure image helpers — base64 chunking (old-app 35KB port),
 * base64→bytes, Blossom hash extraction.
 */
import { describe, expect, it } from 'vitest';
import {
  IMAGE_CHUNK_BYTES,
  base64ToBytes,
  blossomHashFromUrl,
  chunkBase64,
} from '../imageChunks';

describe('chunkBase64', () => {
  it('short input → a single chunk (identity)', () => {
    expect(chunkBase64('abc')).toEqual(['abc']);
  });

  it('input exactly at the limit stays one chunk', () => {
    const b64 = 'a'.repeat(IMAGE_CHUNK_BYTES);
    expect(chunkBase64(b64)).toHaveLength(1);
  });

  it('splits into ceil(n/35000) ordered chunks that concat back losslessly', () => {
    const b64 = 'x'.repeat(90_000) + 'TAIL';
    const chunks = chunkBase64(b64);
    expect(chunks).toHaveLength(Math.ceil(b64.length / IMAGE_CHUNK_BYTES)); // 3
    expect(chunks[0]).toHaveLength(IMAGE_CHUNK_BYTES);
    expect(chunks[1]).toHaveLength(IMAGE_CHUNK_BYTES);
    expect(chunks.join('')).toBe(b64);
  });

  it('honours a custom chunk size', () => {
    expect(chunkBase64('abcdefgh', 3)).toEqual(['abc', 'def', 'gh']);
  });
});

describe('base64ToBytes', () => {
  it('round-trips arbitrary bytes through btoa', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128]);
    const b64 = btoa(String.fromCharCode(...bytes));
    expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(bytes));
  });

  it('empty string → empty bytes', () => {
    expect(base64ToBytes('')).toHaveLength(0);
  });
});

describe('blossomHashFromUrl', () => {
  it('extracts the trailing sha256 segment', () => {
    const hash = 'f'.repeat(64);
    expect(blossomHashFromUrl(`https://blossom.descendant.io/${hash}`)).toBe(hash);
  });
});
