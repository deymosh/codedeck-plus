/**
 * Phase 5 (CDX-029): api.uploadImageBlossom / api.uploadImageChunk publish
 * real kind-4515 events whose decrypted payloads validate against the exact
 * protocol schemas (blossom variant + legacy chunk variant of upload-image).
 */
import { describe, expect, it } from 'vitest';
import {
  COMMAND_KIND,
  uploadImageBlossomMessageSchema,
  uploadImageChunkMessageSchema,
} from '@codedeck/protocol';
import type { NostrEvent } from 'nostr-tools/core';
import { BridgeApi } from '../services/bridgeApi';
import { decryptFrom, generateKeypair, type Keypair } from '../crypto';
import type { Timers } from '../ports';

const timers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

function makeApi(): { api: BridgeApi; published: NostrEvent[]; phone: Keypair; machine: Keypair } {
  const phone = generateKeypair();
  const machine = generateKeypair();
  const published: NostrEvent[] = [];
  const api = new BridgeApi({
    identity: () => phone,
    isKnownMachine: () => true,
    publish: async (event) => {
      published.push(event);
      return true;
    },
    handlers: {},
    now: () => Date.now(),
    timers,
  });
  return { api, published, phone, machine };
}

/** Decrypt the published event the way the bridge would. */
function decryptPayload(event: NostrEvent, machine: Keypair, phone: Keypair): unknown {
  return JSON.parse(decryptFrom(machine.secretKey, phone.pubkeyHex, event.content));
}

describe('upload-image publishing', () => {
  it('uploadImageBlossom → payload validates against the blossom schema', async () => {
    const { api, published, phone, machine } = makeApi();
    const ok = await api.uploadImageBlossom(machine.pubkeyHex, {
      sessionId: 's1',
      hash: 'c'.repeat(64),
      url: `https://blossom.descendant.io/${'c'.repeat(64)}`,
      key: 'a'.repeat(64),
      iv: 'b'.repeat(24),
      filename: 'shot.png',
      mimeType: 'image/png',
      text: 'look at this',
      sizeBytes: 1234,
    });

    expect(ok.verdict).toBe('accepted'); // CDX-086: a verdict, not a boolean
    expect(published).toHaveLength(1);
    expect(published[0]!.kind).toBe(COMMAND_KIND);
    expect(published[0]!.tags).toContainEqual(['p', machine.pubkeyHex]);

    const payload = decryptPayload(published[0]!, machine, phone);
    const parsed = uploadImageBlossomMessageSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('upload-image');
      expect(parsed.data.hash).toBe('c'.repeat(64));
      expect(parsed.data.key).toBe('a'.repeat(64));
      expect(parsed.data.iv).toBe('b'.repeat(24));
      expect(parsed.data.text).toBe('look at this');
      expect(parsed.data.v).toBeGreaterThan(0); // version-stamped by send()
    }
  });

  it('uploadImageChunk → payload validates against the chunk schema', async () => {
    const { api, published, phone, machine } = makeApi();
    const ok = await api.uploadImageChunk(machine.pubkeyHex, {
      sessionId: 's1',
      uploadId: 'u-1',
      filename: 'shot.png',
      mimeType: 'image/png',
      base64Data: 'AAAA',
      text: 'first chunk carries the text',
      chunkIndex: 0,
      totalChunks: 3,
    });

    expect(ok.verdict).toBe('accepted'); // CDX-086: a verdict, not a boolean
    const payload = decryptPayload(published[0]!, machine, phone);
    const parsed = uploadImageChunkMessageSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.uploadId).toBe('u-1');
      expect(parsed.data.chunkIndex).toBe(0);
      expect(parsed.data.totalChunks).toBe(3);
    }
  });
});
