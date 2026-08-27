/**
 * Event-content fragmentation — the transport layer BELOW the semantic protocol.
 *
 * Every bridge→phone message rides one Nostr event as `base64(NIP-44(JSON))` in
 * `event.content`. Relays cap `event.content` at 65535 bytes (HAVEN / Fiatjaf
 * eventstore: `MaxContentSize = math.MaxUint16`). A large model reply is a single
 * `OutputEntry` whose `content` string alone can exceed that once serialized and
 * NIP-44-padded — the bridge then fails to publish it at all
 * (`content is too large: 65628, max is 65535`).
 *
 * The fix is fragmentation, the analogue of IP fragmentation: when the encoded
 * message JSON is too large to fit one event, split the JSON STRING into N
 * `chunk` envelopes, each independently NIP-44-encrypted onto its own event with
 * `content <= 65535`. The receiver buffers the fragments by `cid` and, once all
 * `n` are present, concatenates them back into the exact original JSON string and
 * feeds it through the normal decode/dispatch path. `seq` and every other
 * semantic field are untouched — the reassembled message is byte-identical to
 * what the non-fragmented path would have produced, so ordering, dedup, retries,
 * sync, catch-up and reconnection all keep operating on `seq` exactly as before.
 *
 * A small message is never wrapped: `frameEncodedMessage` returns `[json]`
 * unchanged, so the wire for the common case is byte-for-byte what it was.
 */
import { z } from 'zod';

/**
 * The relay's hard limit on `event.content` (bytes). External to CodeDeck —
 * HAVEN and the Fiatjaf eventstore both pin `MaxContentSize = math.MaxUint16`.
 * Every Nostr event CodeDeck publishes must satisfy `utf8Size(content) <= this`.
 */
export const MAX_EVENT_CONTENT_BYTES = 65535;

/**
 * The largest NIP-44 v2 PLAINTEXT (bytes) whose encrypted `content` (base64)
 * stays at or below MAX_EVENT_CONTENT_BYTES.
 *
 * NIP-44 v2 payload = base64( version(1) ‖ nonce(32) ‖ pad(plaintext) ‖ mac(32) ).
 * `calcPaddedLen` rounds the plaintext up to a power-of-two-derived block; in the
 * 32768–65536 band that block is 8192. So:
 *   - plaintext ≤ 40960  → pad = 40960 → content = 4·⌈(65+2+40960)/3⌉ = 54704  ✅
 *   - plaintext 40961..49152 → pad = 49152 → content = 65628                    ❌
 * 65628 is exactly the observed failure. The boundary is a hard step, so any
 * plaintext ≤ 40960 bytes is safe with ~10 KB of headroom. `chunking.test.ts`
 * asserts this against the real `nostr-tools/nip44` implementation.
 */
export const NIP44_SAFE_PLAINTEXT_BYTES = 40960;

/** Reserved headroom inside NIP44_SAFE_PLAINTEXT_BYTES for the `chunk` wrapper's
 *  own JSON overhead + `i`/`n` integer width. Measured framing (below) never
 *  relies on this being exact — it is a lower bound the binary search targets. */
export const CHUNK_ENVELOPE_MARGIN = 64;

/** Wire `type` of a fragment envelope. Deliberately NOT part of
 *  `bridgeToPhoneSchema` — the semantic layer must never see a fragment. */
export const CHUNK_MESSAGE_TYPE = 'chunk' as const;

export const chunkEnvelopeSchema = z.object({
  type: z.literal(CHUNK_MESSAGE_TYPE),
  /** Random id (16 bytes hex) tying one message's fragments together. */
  cid: z.string().min(1),
  /** 0-based fragment index, `0 <= i < n`. */
  i: z.number().int().nonnegative(),
  /** Total fragment count. Always ≥ 2 — a 1-part message is never wrapped. */
  n: z.number().int().min(2),
  /** This fragment's slice of the original encoded-message JSON string. */
  part: z.string(),
});
export type ChunkEnvelope = z.infer<typeof chunkEnvelopeSchema>;

/** UTF-8 byte length of a string, with no dependency on TextEncoder (the
 *  protocol package intentionally has no `@types/node` / DOM lib). */
export function utf8Size(str: string): number {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      // High surrogate: a full pair encodes to 4 UTF-8 bytes. A lone surrogate
      // still costs 3 (WTF-8 / replacement) — close enough for a size budget.
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

function encodeEnvelope(env: ChunkEnvelope): string {
  return JSON.stringify(env);
}

/**
 * Fragment an already-encoded bridge→phone message JSON string for the wire.
 *
 * - Fits in one event (`utf8Size(json) <= NIP44_SAFE_PLAINTEXT_BYTES`): returns
 *   `[json]` UNCHANGED — the caller encrypts + publishes exactly as before.
 * - Too large: returns N `chunk` envelope JSON strings, each guaranteed to
 *   `utf8Size(...) <= NIP44_SAFE_PLAINTEXT_BYTES` (so each encrypts to a
 *   `content` within MAX_EVENT_CONTENT_BYTES). Concatenating the `part` fields in
 *   index order reproduces `json` byte-for-byte.
 *
 * `makeCid` mints the fragment-group id (inject a deterministic one in tests).
 * The split is measured, not arithmetic: a binary search sizes each slice by the
 * real envelope's UTF-8 length, so JSON re-escaping of `part` (quotes,
 * backslashes) can never push a fragment over budget.
 */
export function frameEncodedMessage(json: string, makeCid: () => string): string[] {
  if (utf8Size(json) <= NIP44_SAFE_PLAINTEXT_BYTES) return [json];

  const cid = makeCid();
  const budget = NIP44_SAFE_PLAINTEXT_BYTES - CHUNK_ENVELOPE_MARGIN;
  const parts: string[] = [];
  let pos = 0;

  while (pos < json.length) {
    const remaining = json.length - pos;
    let lo = 1;
    let hi = remaining;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const candidate = json.slice(pos, pos + mid);
      const framed = encodeEnvelope({ type: CHUNK_MESSAGE_TYPE, cid, i: 0, n: 0, part: candidate });
      if (utf8Size(framed) <= budget) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best === 0) {
      // Cannot fit even one character — impossible given the margin, but never loop forever.
      throw new Error('frameEncodedMessage: chunk budget too small to make progress');
    }
    // Never end a slice on a lone high surrogate — keep the pair together in the
    // next slice so `part_a + part_b === json` holds exactly.
    if (best < remaining && isHighSurrogate(json.charCodeAt(pos + best - 1))) {
      best -= 1;
      if (best === 0) {
        throw new Error('frameEncodedMessage: surrogate pair does not fit the chunk budget');
      }
    }
    parts.push(json.slice(pos, pos + best));
    pos += best;
  }

  const n = parts.length;
  return parts.map((part, i) => encodeEnvelope({ type: CHUNK_MESSAGE_TYPE, cid, i, n, part }));
}

/**
 * If `plaintext` is a well-formed `chunk` envelope, return it; otherwise null
 * (the caller then handles `plaintext` as an ordinary message). A string that
 * *looks* like a chunk but fails the schema returns null too — it will fail the
 * normal decode and be recorded as an invalid payload, which is the right
 * outcome for a malformed fragment.
 */
export function parseChunkEnvelope(plaintext: string): ChunkEnvelope | null {
  // Cheap pre-filter: frameEncodedMessage always emits `type` first, so an
  // ordinary message never matches and skips the parse entirely.
  if (!plaintext.startsWith(`{"type":"${CHUNK_MESSAGE_TYPE}"`)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || (raw as { type?: unknown }).type !== CHUNK_MESSAGE_TYPE) {
    return null;
  }
  const parsed = chunkEnvelopeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export type AssemblerResult =
  /** Not a fragment — process `plaintext` as an ordinary message. */
  | { kind: 'passthrough' }
  /** A fragment was buffered; nothing to dispatch yet. */
  | { kind: 'buffered' }
  /** All fragments present — `json` is the reassembled message. */
  | { kind: 'assembled'; json: string }
  /** A fragment envelope that cannot belong to any valid message. */
  | { kind: 'invalid'; error: string };

interface OpenBuffer {
  n: number;
  parts: Map<number, string>;
  bytes: number;
  firstSeenAt: number;
}

export interface ChunkAssemblerOptions {
  now?: () => number;
  /** Discard an incomplete group after this long (ms). The missing message is
   *  then recovered by the existing gap-heal path (sync / sync-chunk retry). */
  ttlMs?: number;
  /** Cap on concurrently-open groups (oldest evicted past it). */
  maxOpen?: number;
  /** Cap on total buffered `part` bytes across all groups (oldest evicted). */
  maxBytes?: number;
}

export const CHUNK_ASSEMBLY_TTL_MS = 60_000;
const DEFAULT_MAX_OPEN = 64;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Reassembles `chunk` fragments back into whole message JSON. Shared by the
 * phone (`BridgeApi.ingest`) and the testkit `PhoneSimulator` so both exercise
 * the identical client contract.
 *
 * - Out-of-order fragments: assembled by index, arrival order irrelevant.
 * - Duplicate `(cid, i)`: ignored (idempotent).
 * - `i >= n`, or a second fragment for a `cid` with a different `n`: invalid.
 * - Missing fragment: the group never completes and is swept after `ttlMs`;
 *   partial content is NEVER surfaced.
 * - Bounded: at most `maxOpen` groups and `maxBytes` buffered; the oldest group
 *   is evicted past either cap (a broken/hostile bridge cannot exhaust memory).
 */
export class ChunkAssembler {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxOpen: number;
  private readonly maxBytes: number;
  private readonly open = new Map<string, OpenBuffer>();
  private totalBytes = 0;

  constructor(options: ChunkAssemblerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? CHUNK_ASSEMBLY_TTL_MS;
    this.maxOpen = options.maxOpen ?? DEFAULT_MAX_OPEN;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  /** Open (incomplete) fragment groups — diagnostics / tests. */
  get openCount(): number {
    return this.open.size;
  }

  /** Drop groups older than `ttlMs`. Called opportunistically on every offer;
   *  safe to call directly from a timer too. */
  sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [cid, buf] of this.open) {
      if (buf.firstSeenAt <= cutoff) this.drop(cid);
    }
  }

  offer(plaintext: string): AssemblerResult {
    this.sweep();

    const env = parseChunkEnvelope(plaintext);
    if (!env) return { kind: 'passthrough' };
    if (env.i >= env.n) {
      return { kind: 'invalid', error: `chunk index ${env.i} out of range for n=${env.n}` };
    }

    let buf = this.open.get(env.cid);
    if (buf && buf.n !== env.n) {
      // Same cid, different fragment count — a collision or a corrupt sender.
      // Abandon the old group; start fresh from this fragment.
      this.drop(env.cid);
      buf = undefined;
    }
    if (!buf) {
      if (this.open.size >= this.maxOpen) this.evictOldest();
      buf = { n: env.n, parts: new Map(), bytes: 0, firstSeenAt: this.now() };
      this.open.set(env.cid, buf);
    }

    if (!buf.parts.has(env.i)) {
      const size = utf8Size(env.part);
      buf.parts.set(env.i, env.part);
      buf.bytes += size;
      this.totalBytes += size;
      while (this.totalBytes > this.maxBytes && this.open.size > 1) this.evictOldest(env.cid);
    }

    if (buf.parts.size < buf.n) return { kind: 'buffered' };

    const ordered: string[] = [];
    for (let i = 0; i < buf.n; i++) {
      const part = buf.parts.get(i);
      if (part === undefined) return { kind: 'buffered' }; // shouldn't happen (size check above)
      ordered.push(part);
    }
    this.drop(env.cid);
    return { kind: 'assembled', json: ordered.join('') };
  }

  private drop(cid: string): void {
    const buf = this.open.get(cid);
    if (!buf) return;
    this.totalBytes -= buf.bytes;
    this.open.delete(cid);
  }

  private evictOldest(exceptCid?: string): void {
    let oldestCid: string | null = null;
    let oldestAt = Infinity;
    for (const [cid, buf] of this.open) {
      if (cid === exceptCid) continue;
      if (buf.firstSeenAt < oldestAt) {
        oldestAt = buf.firstSeenAt;
        oldestCid = cid;
      }
    }
    if (oldestCid !== null) this.drop(oldestCid);
  }
}
