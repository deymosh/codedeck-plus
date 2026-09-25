/**
 * The host's own outbound HTTP (credential checks). Plain `fetch`: the
 * bridge's Tor proxy covers its relay traffic only, not agent-side requests.
 * A seam so tests never touch the network.
 */

export interface HttpResponse {
  status: number;
}

export type HttpPost = (url: string, headers: Record<string, string>, body: string) => Promise<HttpResponse>;

export const httpPost: HttpPost = async (url, headers, body) => {
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) });
  return { status: res.status };
};
