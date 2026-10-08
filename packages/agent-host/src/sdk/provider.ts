/**
 * The rule a custom-provider base URL must satisfy, shared by every driver
 * whose agent is pointed at one. The bridge applies the same rule when a
 * profile is saved, so a value that reaches a driver has normally been
 * checked already — a driver checks again because it is the one that would
 * put an API token on the connection.
 */

/** The message shown when a base URL is refused (the bridge shows the same). */
export const PROVIDER_BASE_URL_ERROR =
  'Base URL must be https:// (http:// is allowed only for this machine — localhost, 127.0.0.1, [::1] — ' +
  'or an address on your own network, such as 192.168.1.10)';

/** https anywhere; http to this machine, whose traffic never leaves it; or
 *  http to an IP address of the user's own network (a gateway at home),
 *  where the user chose to let the token cross that network in cleartext.
 *  Mirrors `crates/protocol`'s `is_valid_provider_base_url`: private means
 *  10/8, 172.16/12, 192.168/16, 100.64/10 and fc00::/7, written as
 *  addresses — never a name, which DNS could point anywhere. */
export function isValidProviderBaseUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return url.host !== '';
  if (url.protocol !== 'http:' || url.username !== '' || url.password !== '') return false;
  const host = url.hostname.toLowerCase();
  return ['localhost', '127.0.0.1', '[::1]'].includes(host) || isPrivateNetworkAddress(host);
}

/** `host` as the URL parser normalises it: dotted IPv4, or bracketed IPv6. */
function isPrivateNetworkAddress(host: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.startsWith('[') && host.endsWith(']')) {
    const first = host.slice(1, -1).split(':')[0] ?? '';
    return first !== '' && (Number.parseInt(first, 16) & 0xfe00) === 0xfc00;
  }
  return false;
}
