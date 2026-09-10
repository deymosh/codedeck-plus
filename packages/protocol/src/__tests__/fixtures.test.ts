/**
 * TS half of the shared codec conformance corpus (`fixtures/corpus.json`).
 * The Rust half is `crates/client-core/tests/codec_conformance.rs` and runs the
 * identical assertions on the identical bytes. A zod-schema change that isn't
 * mirrored in the Rust `wire` codec (or vice versa) fails CI on one side.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  decodeBridgeToPhone,
  decodePhoneToBridge,
  encodeBridgeToPhone,
  encodePhoneToBridge,
} from '../codec';

const corpusPath = fileURLToPath(new URL('../../fixtures/corpus.json', import.meta.url));
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as {
  phoneToBridge: { valid: unknown[]; rejected: unknown[] };
  bridgeToPhone: { valid: unknown[]; rejected: unknown[] };
  forwardCompatible: { dir: 'p2b' | 'b2p'; msg: unknown }[];
};

describe('codec conformance corpus — phoneToBridge', () => {
  corpus.phoneToBridge.valid.forEach((msg, i) => {
    it(`valid[${i}] decodes + semantic round-trips: ${JSON.stringify(msg).slice(0, 70)}`, () => {
      const r = decodePhoneToBridge(JSON.stringify(msg));
      expect(r.ok, r.ok ? '' : r.error).toBe(true);
      if (!r.ok) return;
      const back = decodePhoneToBridge(encodePhoneToBridge(r.msg));
      expect(back.ok).toBe(true);
      if (back.ok) expect(back.msg).toEqual(r.msg);
    });
  });

  corpus.phoneToBridge.rejected.forEach((msg, i) => {
    it(`rejected[${i}] is an error: ${JSON.stringify(msg).slice(0, 70)}`, () => {
      expect(decodePhoneToBridge(JSON.stringify(msg)).ok).toBe(false);
    });
  });
});

describe('codec conformance corpus — bridgeToPhone', () => {
  corpus.bridgeToPhone.valid.forEach((msg, i) => {
    it(`valid[${i}] decodes + semantic round-trips: ${JSON.stringify(msg).slice(0, 70)}`, () => {
      const r = decodeBridgeToPhone(JSON.stringify(msg));
      expect(r.ok, r.ok ? '' : r.error).toBe(true);
      if (!r.ok) return;
      const back = decodeBridgeToPhone(encodeBridgeToPhone(r.msg));
      expect(back.ok).toBe(true);
      if (back.ok) expect(back.msg).toEqual(r.msg);
    });
  });

  corpus.bridgeToPhone.rejected.forEach((msg, i) => {
    it(`rejected[${i}] is an error: ${JSON.stringify(msg).slice(0, 70)}`, () => {
      expect(decodeBridgeToPhone(JSON.stringify(msg)).ok).toBe(false);
    });
  });
});

describe('codec conformance corpus — forward compatibility (extra fields ignored)', () => {
  corpus.forwardCompatible.forEach((entry, i) => {
    it(`forwardCompatible[${i}] (${entry.dir}) still decodes`, () => {
      const json = JSON.stringify(entry.msg);
      const r = entry.dir === 'p2b' ? decodePhoneToBridge(json) : decodeBridgeToPhone(json);
      expect(r.ok, r.ok ? '' : r.error).toBe(true);
    });
  });
});
