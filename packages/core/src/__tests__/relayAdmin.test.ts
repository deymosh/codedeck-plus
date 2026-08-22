/**
 * registerPhoneOnRelay — ported from the old bridge's relayAdmin.test.ts,
 * driven entirely through the injected fetch. Best-effort contract: every
 * outcome is a structured result, never a throw.
 */
import { describe, it, expect } from 'vitest';
import { registerPhoneOnRelay } from '../relayAdmin';

const PUBKEY = 'a'.repeat(64);

function fetchStub(status: number, capture?: { url?: string; init?: RequestInit }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (capture) {
      capture.url = String(url);
      capture.init = init;
    }
    return new Response('{}', { status });
  }) as typeof fetch;
}

const config = (fetchFn: typeof fetch) => ({
  endpoint: 'https://relay2.example/api/register-agent',
  token: 'admin-secret',
  fetchFn,
});

describe('registerPhoneOnRelay', () => {
  it('POSTs the lowercased pubkey with the Bearer token; 201 = registered', async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const result = await registerPhoneOnRelay(PUBKEY.toUpperCase(), config(fetchStub(201, capture)));
    expect(result).toEqual({ ok: true, status: 'registered' });
    expect(capture.url).toBe('https://relay2.example/api/register-agent');
    expect(capture.init?.method).toBe('POST');
    expect((capture.init?.headers as Record<string, string>)['Authorization']).toBe('Bearer admin-secret');
    expect(JSON.parse(String(capture.init?.body))).toEqual({ pubkey: PUBKEY });
  });

  it('200 = already_registered (idempotent)', async () => {
    expect(await registerPhoneOnRelay(PUBKEY, config(fetchStub(200))))
      .toEqual({ ok: true, status: 'already_registered' });
  });

  it('401 = bad admin token', async () => {
    const result = await registerPhoneOnRelay(PUBKEY, config(fetchStub(401)));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('unauthorized');
  });

  it('other statuses surface the HTTP code', async () => {
    const result = await registerPhoneOnRelay(PUBKEY, config(fetchStub(503)));
    expect(result).toEqual({ ok: false, reason: 'relay returned HTTP 503' });
  });

  // --- CDX-013: the admin bearer token must never travel over plaintext ---

  it('refuses a plain-http endpoint WITHOUT calling fetch (token would leak)', async () => {
    const capture: { url?: string } = {};
    const result = await registerPhoneOnRelay(PUBKEY, {
      endpoint: 'http://relay2.example/api/register-agent',
      token: 'admin-secret',
      fetchFn: fetchStub(201, capture),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('insecure-endpoint');
    expect(capture.url).toBeUndefined();
  });

  it('allows loopback http for local dev (wrangler dev)', async () => {
    expect(await registerPhoneOnRelay(PUBKEY, {
      endpoint: 'http://localhost:8787/api/register-agent',
      token: 'admin-secret',
      fetchFn: fetchStub(201),
    })).toEqual({ ok: true, status: 'registered' });
    expect(await registerPhoneOnRelay(PUBKEY, {
      endpoint: 'http://127.0.0.1:8787/api/register-agent',
      token: 'admin-secret',
      fetchFn: fetchStub(200),
    })).toEqual({ ok: true, status: 'already_registered' });
  });

  it('refuses an unparseable endpoint URL', async () => {
    const result = await registerPhoneOnRelay(PUBKEY, {
      endpoint: 'not a url',
      token: 'admin-secret',
      fetchFn: fetchStub(201),
    });
    expect(result).toEqual({ ok: false, reason: 'invalid-endpoint-url' });
  });

  it('no-ops when endpoint/token is not configured', async () => {
    expect(await registerPhoneOnRelay(PUBKEY, { endpoint: '', token: 'x' }))
      .toEqual({ ok: false, reason: 'not-configured' });
    expect(await registerPhoneOnRelay(PUBKEY, { endpoint: 'https://x', token: '' }))
      .toEqual({ ok: false, reason: 'not-configured' });
  });

  it('rejects malformed pubkeys before any network call', async () => {
    let called = false;
    const fetchFn = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
    expect(await registerPhoneOnRelay('not-a-key', config(fetchFn)))
      .toEqual({ ok: false, reason: 'invalid-pubkey' });
    expect(called).toBe(false);
  });

  it('network errors come back as a structured failure, never a throw', async () => {
    const fetchFn = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    const result = await registerPhoneOnRelay(PUBKEY, config(fetchFn));
    expect(result).toEqual({ ok: false, reason: 'ECONNREFUSED' });
  });
});
