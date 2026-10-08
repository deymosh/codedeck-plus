/**
 * The APIs a provider profile's endpoint can speak, as an agent speaks
 * them: how it signs in, how its models are listed, and the smallest
 * request that proves the token. A profile belongs to one agent, and a
 * driver picks the API its agent uses — an endpoint compatible with one is
 * not necessarily compatible with another.
 */
import type { HttpGet, HttpPost } from './net';
import { providerApiRoot, readProviderModels, type EndpointModel } from './providerModels';
import type { ProviderBinding } from './types';

export interface ProviderApi {
  /** The headers that carry `token` on this API. */
  auth(token: string): Record<string, string>;
  /** The path under the endpoint's `/v1` root a one-token request goes to. */
  completionPath: string;
}

/** OpenAI's API (chat completions), as OpenAI-compatible clients call it. */
export const OPENAI_API: ProviderApi = {
  auth: (token) => ({ authorization: `Bearer ${token}` }),
  completionPath: 'chat/completions',
};

/** Anthropic's Messages API. The token goes in both headers Anthropic-style
 *  endpoints read it from: `x-api-key` (Anthropic's own) and
 *  `Authorization` (most gateways). */
export const ANTHROPIC_API: ProviderApi = {
  auth: (token) => ({ 'x-api-key': token, authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' }),
  completionPath: 'messages',
};

/** The models the endpoint lists, read the way `api` signs in. Rejects
 *  with the reason (see `readProviderModels`). */
export function listModels(api: ProviderApi, baseUrl: string, token: string, get: HttpGet): Promise<EndpointModel[]> {
  return readProviderModels(baseUrl, { headers: api.auth(token), httpGet: get });
}

/**
 * What a check's HTTP status says about the token. 401/403: rejected.
 * Success, or an error the provider only returns once it has accepted the
 * credentials (a malformed request, a rate limit): valid. Anything else —
 * 404 from a wrong base URL or an API the endpoint does not speak, a
 * redirect, a 5xx — never reached the credential check, so it proves
 * nothing either way.
 */
export function tokenVerdict(status: number): boolean | undefined {
  if (status === 401 || status === 403) return false;
  if ((status >= 200 && status < 300) || status === 400 || status === 422 || status === 429) return true;
  return undefined;
}

/** Check a profile's token with one token of `model` on `api`. Undefined
 *  when it could not be checked. */
export async function checkToken(
  api: ProviderApi,
  provider: ProviderBinding,
  model: string,
  post: HttpPost,
): Promise<boolean | undefined> {
  const body = JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
  try {
    const res = await post(
      `${providerApiRoot(provider.baseUrl)}/${api.completionPath}`,
      { 'content-type': 'application/json', ...api.auth(provider.authToken) },
      body,
    );
    return tokenVerdict(res.status);
  } catch {
    return undefined;
  }
}
