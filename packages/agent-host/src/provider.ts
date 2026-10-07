/**
 * The rule a custom-provider base URL must satisfy, shared by every driver
 * whose agent is pointed at one. The bridge applies the same rule when a
 * profile is saved, so a value that reaches a driver has normally been
 * checked already — a driver checks again because it is the one that would
 * put an API token on the connection.
 */

/** The message shown when a base URL is refused (the bridge shows the same). */
export const PROVIDER_BASE_URL_ERROR =
  'Base URL must be https:// (http:// is allowed only for localhost, 127.0.0.1 or [::1])';

/** https anywhere, or http ONLY on loopback — a local model server has no
 *  cert and its traffic never leaves the machine; anything else is a network
 *  hop carrying a bearer token. */
export function isValidProviderBaseUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return url.host !== '';
  if (url.protocol !== 'http:') return false;
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
}
