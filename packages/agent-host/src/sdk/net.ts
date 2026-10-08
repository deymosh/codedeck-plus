/**
 * The host's own outbound HTTP (credential checks, provider endpoints).
 * Plain `fetch`: the bridge's Tor proxy covers its relay traffic only, not
 * agent-side requests. A seam so tests never touch the network.
 */

export interface HttpResponse {
  status: number;
  /** The response body, for a call that asked for it. `net.ts`'s own
   *  fetchers read it; a test's fake may leave it out. */
  text?: string;
}

export type HttpPost = (url: string, headers: Record<string, string>, body: string) => Promise<HttpResponse>;

export const httpPost: HttpPost = async (url, headers, body) => {
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) });
  return { status: res.status };
};

export type HttpGet = (url: string, headers: Record<string, string>) => Promise<HttpResponse>;

export const httpGet: HttpGet = async (url, headers) => {
  const res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(15_000) });
  return { status: res.status, text: await res.text() };
};

/** The most of a provider's answer that is read. Some providers describe
 *  every model at length (OpenRouter's list is a few megabytes); past this
 *  the answer is refused rather than buffered without bound. */
export const MAX_PROVIDER_ANSWER_BYTES = 16 * 1024 * 1024;

/**
 * A GET to a provider profile's endpoint, carrying its token. A redirect is
 * not followed but answered as its own status: it could lead the token to
 * another host, or off https — only the URL the profile names may see it.
 */
export const providerGet: HttpGet = async (url, headers) => {
  const res = await fetch(url, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  return { status: res.status, text: await readCapped(res) };
};

/** A POST to a provider profile's endpoint; redirects as for `providerGet`. */
export const providerPost: HttpPost = async (url, headers, body) => {
  const res = await fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  await res.body?.cancel();
  return { status: res.status };
};

/** Outbound HTTP to provider profiles' endpoints, as drivers take it. */
export interface ProviderHttp {
  get: HttpGet;
  post: HttpPost;
}

export const providerHttp: ProviderHttp = { get: providerGet, post: providerPost };

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PROVIDER_ANSWER_BYTES) {
      await reader.cancel();
      throw new Error('the answer is too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
