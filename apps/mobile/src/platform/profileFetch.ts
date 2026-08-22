/**
 * Kind-0 profile resolution for DM peers — ported from the old app's
 * profileService.ts (outbox-ish discovery model).
 *
 * Why this is a platform module with its OWN pool: the DM subscription rides
 * the app transport (settings relay list), but profiles live all over the
 * network — resolution is a one-shot query against indexer/aggregator relays
 * plus the target's own NIP-65 write relays, with fallback rounds. The core
 * dmStore only sees the `ProfileFetcher` port; concurrency-dedup and cache TTL
 * live in the store.
 *
 * Strategy (ported):
 *   Round 1 (outbox): fetch the target's kind-10002 relay list from the
 *     indexers, then query kind 0 from union(write relays, fallback set).
 *   Rounds 2–3: fallback set only, longer timeout, small backoff.
 * Always resolves — total miss returns status 'notfound'.
 */
import { SimplePool } from 'nostr-tools/pool';
import { Metadata, RelayList } from 'nostr-tools/kinds';
import type { DmProfile, ProfileFetcher } from '../core/stores/dm';
import type { Logger } from '../core/ports';
import { profilePoolOptions } from './poolOptions';

/** Indexer/aggregator relays queried FIRST (kind 10002 + kind 0) — ported. */
export const PROFILE_INDEXER_RELAYS = [
  'wss://purplepag.es',
  'wss://relay.nostr.band',
  'wss://user.kindpag.es',
];

/**
 * Broad, high-uptime fallback set for the kind-0 fetch — ported.
 *
 * CDX-081 deliberately did NOT evict damus.io or nos.lol from this list, even
 * though both were disqualified as the shipped publish fallback. This list is
 * READ-ONLY (kind-0 lookups) and their disqualifying faults are write-side —
 * damus rate-limits publishes, nos.lol demands PoW on publishes. For reads, a
 * big well-populated relay is an asset, and dropping them would make profile
 * resolution worse for no benefit. Reviewed rather than swept.
 */
export const PROFILE_FALLBACK_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.oxtr.dev',
  'wss://purplepag.es',
  'wss://relay.nostr.band',
];

// Field clamps — garbage/huge kind-0 content must not bloat the persisted store.
const MAX_SHORT = 200;
const MAX_ABOUT = 500;
const MAX_PICTURE = 2048;

const ROUND1_TIMEOUT_MS = 8_000;
const ROUND_TIMEOUT_MS = 10_000;
const BACKOFF_MS = 1_500;
const RELAYLIST_TIMEOUT_MS = 6_000;
const MAX_WRITE_RELAYS = 6;

/** The slice of SimplePool the fetcher uses (injectable for tests). */
export interface ProfilePoolLike {
  get(
    relays: string[],
    filter: { kinds: number[]; authors: string[] },
  ): Promise<{ content: string; tags: string[][] } | null>;
}

function clampStr(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined;
}

function sanitizePicture(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length > MAX_PICTURE) return undefined;
  if (!/^https?:\/\//i.test(value)) return undefined;
  return value;
}

function normalizeRelay(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!/^wss?:\/\//i.test(trimmed)) return null;
  return trimmed.replace(/\/+$/, '');
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse + sanitize kind-0 content into a DmProfile; null on bad content. */
export function parseProfileMetadata(content: string, fetchedAt: number): DmProfile | null {
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!meta || typeof meta !== 'object') return null;
  const profile: DmProfile = { fetchedAt, status: 'ok' };
  const name = clampStr(meta.name, MAX_SHORT);
  const displayName = clampStr(meta.display_name, MAX_SHORT);
  const picture = sanitizePicture(meta.picture);
  const nip05 = clampStr(meta.nip05, MAX_SHORT);
  const about = clampStr(meta.about, MAX_ABOUT);
  if (name !== undefined) profile.name = name;
  if (displayName !== undefined) profile.displayName = displayName;
  if (picture !== undefined) profile.picture = picture;
  if (nip05 !== undefined) profile.nip05 = nip05;
  if (about !== undefined) profile.about = about;
  return profile;
}

export interface ProfileFetcherDeps {
  pool?: ProfilePoolLike;
  now?(): number;
  log?: Logger;
}

export function createProfileFetcher(deps: ProfileFetcherDeps = {}): ProfileFetcher {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  let pool: ProfilePoolLike | null = deps.pool ?? null;
  const getPool = (): ProfilePoolLike => {
    // Lazy: no sockets until the first profile is actually resolved. Options
    // come from the ONE phone pool-options module (CDX-020) so this pool can
    // never drift from the transport's.
    if (!pool) pool = new SimplePool(profilePoolOptions()) as unknown as ProfilePoolLike;
    return pool;
  };

  async function fetchWriteRelays(pubkeyHex: string): Promise<string[]> {
    try {
      const event = await withTimeout(
        getPool().get(PROFILE_INDEXER_RELAYS, { kinds: [RelayList], authors: [pubkeyHex] }),
        RELAYLIST_TIMEOUT_MS,
        null,
      );
      if (!event) return [];
      const writeRelays: string[] = [];
      for (const tag of event.tags) {
        if (tag[0] !== 'r') continue;
        const url = normalizeRelay(tag[1]);
        if (!url) continue;
        // No marker = read+write; 'write' = write. Skip read-only relays.
        if (tag[2] === undefined || tag[2] === 'write') writeRelays.push(url);
      }
      return Array.from(new Set(writeRelays)).slice(0, MAX_WRITE_RELAYS);
    } catch (err) {
      log(`[Profile] kind-10002 fetch failed for ${pubkeyHex.slice(0, 8)}…: ${err}`);
      return [];
    }
  }

  async function queryKind0(pubkeyHex: string, relays: string[], timeoutMs: number): Promise<DmProfile | null> {
    if (relays.length === 0) return null;
    const event = await withTimeout(
      getPool().get(relays, { kinds: [Metadata], authors: [pubkeyHex] }),
      timeoutMs,
      null,
    );
    if (!event?.content) return null;
    return parseProfileMetadata(event.content, now());
  }

  return async (pubkeyHex: string): Promise<DmProfile> => {
    // Round 1 — outbox: union(write relays, fallback set).
    try {
      const writeRelays = await fetchWriteRelays(pubkeyHex);
      const round1 = Array.from(new Set([...writeRelays, ...PROFILE_FALLBACK_RELAYS]));
      const meta = await queryKind0(pubkeyHex, round1, ROUND1_TIMEOUT_MS);
      if (meta) return meta;
    } catch (err) {
      log(`[Profile] round 1 error for ${pubkeyHex.slice(0, 8)}…: ${err}`);
    }

    // Rounds 2–3 — fallback set, longer timeout, small backoff.
    for (let round = 2; round <= 3; round++) {
      await sleep(BACKOFF_MS);
      try {
        const meta = await queryKind0(pubkeyHex, PROFILE_FALLBACK_RELAYS, ROUND_TIMEOUT_MS);
        if (meta) return meta;
      } catch (err) {
        log(`[Profile] round ${round} error for ${pubkeyHex.slice(0, 8)}…: ${err}`);
      }
    }

    log(`[Profile] no kind-0 found for ${pubkeyHex.slice(0, 8)}… after 3 rounds`);
    return { fetchedAt: now(), status: 'notfound' };
  };
}
