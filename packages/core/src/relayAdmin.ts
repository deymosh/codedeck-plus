/**
 * Relay admin — auto-register a paired phone's pubkey on a WRITE-RESTRICTED
 * private relay so the phone can publish high-frequency session traffic there.
 * Ported from the old bridge's relayAdmin.ts; the only change is an injectable
 * fetch (tests) and a timeout seam.
 *
 * The two-channel relay model this enables:
 *   - PAIRING (rare, low-volume): rides an OPEN relay, because a fresh phone's
 *     key is not yet registered on the private relay and its pair-request would
 *     be rejected ("restricted: not a registered user").
 *   - SESSIONS (high-frequency): once the bridge registers the phone here,
 *     both directions can use the private relay.
 *
 * The endpoint is an admin API speaking that contract: POST /api/register-agent,
 * Bearer token, body {pubkey:<64-hex>}; idempotent — 200 already_registered /
 * 201 registered. No-op when no endpoint/token is configured.
 *
 * CDX-093: TWO services implement it identically — the relay (apps/relay) and
 * the Blossom media server (nostr-relays/blossom-server) — so this function is
 * called once per service. It is named for the relay only because that is where
 * it started; nothing in it is relay-specific.
 */

export interface RelayRegisterConfig {
  endpoint: string; // e.g. https://relay2.descendant.io/api/register-agent
  token: string;    // Bearer admin token — NEVER logged
  /** Injectable for tests. Defaults to global fetch. */
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export type RelayRegisterResult =
  | { ok: true; status: 'registered' | 'already_registered' }
  | { ok: false; reason: string };

/**
 * Register a phone pubkey (hex) on the private relay's whitelist. Returns a
 * structured result so the caller can surface a clear notice. Best-effort:
 * never throws.
 */
export async function registerPhoneOnRelay(
  pubkeyHex: string,
  config: RelayRegisterConfig,
): Promise<RelayRegisterResult> {
  if (!config.endpoint || !config.token) {
    return { ok: false, reason: 'not-configured' };
  }
  if (!/^[0-9a-f]{64}$/i.test(pubkeyHex)) {
    return { ok: false, reason: 'invalid-pubkey' };
  }
  // CDX-013: the request carries the relay ADMIN bearer token — never send it
  // over plaintext. Loopback http is allowed for local dev (wrangler dev).
  try {
    const parsed = new URL(config.endpoint);
    const loopback =
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]' ||
      parsed.hostname === '::1';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
      return { ok: false, reason: 'insecure-endpoint (admin token requires https)' };
    }
  } catch {
    return { ok: false, reason: 'invalid-endpoint-url' };
  }

  const fetchFn = config.fetchFn ?? fetch;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 10_000);
    let res: Response;
    try {
      res = await fetchFn(config.endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ pubkey: pubkeyHex.toLowerCase() }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 201) return { ok: true, status: 'registered' };
    if (res.status === 200) return { ok: true, status: 'already_registered' };
    if (res.status === 401) return { ok: false, reason: 'unauthorized (bad admin token)' };
    return { ok: false, reason: `relay returned HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
