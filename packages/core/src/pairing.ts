/**
 * Pairing URL builder — ported from codedeck-bridge-vscode/src/pairing.ts
 * (host-agnostic part; rendering lives in the hosts: webview QR in VSCode,
 * terminal QR in the CLI).
 *
 * Payload format (the phone's deep-link handler parses this):
 *   codedeck://pair?npub=<npub>&relays=<comma-separated-encoded>&machine=<name>&token=<token>[&netid=<id>&meshadmin=<npub>]
 *
 * `token` is a one-time secret embedded in this window's QR; the phone echoes
 * it back in its pair-request and the bridge accepts only a matching token.
 *
 * CDX-028 (nvpn 4.1.x manual-join): the QR's mesh payload is now the PUBLIC
 * pair `netid` (active network id) + `meshadmin` (the bridge machine's mesh
 * admin device id, an npub) — the phone feeds both to its engine's
 * `manual_add_network`. The old `mesh=<nvpn://invite/…>` bearer token is gone
 * (nvpn removed `create-invite`), and with it the displayUrl redaction:
 * nothing in the mesh params is secret anymore, so displayUrl === url.
 */

export interface PairingUrlParts {
  npub: string;
  relays: readonly string[];
  machine: string;
  token: string;
  /** Mesh admin device id (npub) for the phone's manual-join, when the mesh is available. */
  meshAdmin?: string;
  /** Active mesh network id (pairs with meshAdmin). */
  netid?: string;
}

export interface PairingUrl {
  /** Full URL for the QR (mesh join info included when present). */
  url: string;
  /** Human-displayable URL. Since CDX-028 the mesh params are public
   *  (netid + admin npub, no secret), so this equals `url`; the field stays
   *  because hosts render it and a future param may need redaction again. */
  displayUrl: string;
}

/** How long an open pairing window accepts pair-requests (ported: 10 min). */
export const DEFAULT_PAIRING_WINDOW_MS = 10 * 60_000;

export function buildPairingUrl(parts: PairingUrlParts): PairingUrl {
  const relaysParam = parts.relays.map((r) => encodeURIComponent(r)).join(',');
  const tokenParam = `&token=${encodeURIComponent(parts.token)}`;
  const meshParam = parts.meshAdmin && parts.netid
    ? `&netid=${encodeURIComponent(parts.netid)}&meshadmin=${encodeURIComponent(parts.meshAdmin)}`
    : '';
  const base = `codedeck://pair?npub=${parts.npub}&relays=${relaysParam}&machine=${encodeURIComponent(parts.machine)}${tokenParam}`;
  const url = `${base}${meshParam}`;
  return { url, displayUrl: url };
}
