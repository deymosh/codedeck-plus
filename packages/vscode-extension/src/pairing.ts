/**
 * `codedeck-bridge pair --json`: one JSON line per state of a pairing
 * window, `open` first (with the URL and its QR), then `paired`, `expired`
 * or `closed`. The command asks the running bridge for the window and exits
 * 0 only when a phone paired.
 */

export type PairState = 'open' | 'paired' | 'expired' | 'closed';

export interface PairStatus {
  id: string;
  state: PairState;
  /** What the QR encodes, while open. */
  url?: string;
  /** The URL to show as text, while open. */
  displayUrl?: string;
  /** When the open window expires (ms since the Unix epoch). */
  expiresAtMs?: number;
  /** The QR as an SVG document, while open. */
  qrSvg?: string;
  /** The phone that paired. */
  phone?: { label: string; npub: string };
}

const STATES: readonly string[] = ['open', 'paired', 'expired', 'closed'];

const optional = (value: unknown, type: 'string' | 'number'): boolean => value === undefined || typeof value === type;

/**
 * One line of the command's output, or `undefined` for anything else (a
 * log line, a newer field's malformed value): the caller skips it.
 */
export function parsePairLine(line: string): PairStatus | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { id, state, url, displayUrl, expiresAtMs, qrSvg, phone } = raw as Record<string, unknown>;
  if (typeof id !== 'string' || typeof state !== 'string' || !STATES.includes(state)) return undefined;
  if (!optional(url, 'string') || !optional(displayUrl, 'string') || !optional(qrSvg, 'string')) return undefined;
  if (!optional(expiresAtMs, 'number')) return undefined;
  const status: PairStatus = { id, state: state as PairState };
  if (url !== undefined) status.url = url as string;
  if (displayUrl !== undefined) status.displayUrl = displayUrl as string;
  if (expiresAtMs !== undefined) status.expiresAtMs = expiresAtMs as number;
  if (qrSvg !== undefined) status.qrSvg = qrSvg as string;
  if (phone !== undefined) {
    if (typeof phone !== 'object' || phone === null) return undefined;
    const { label, npub } = phone as Record<string, unknown>;
    if (typeof label !== 'string' || typeof npub !== 'string') return undefined;
    status.phone = { label, npub };
  }
  return status;
}
