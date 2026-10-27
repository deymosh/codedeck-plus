/**
 * Take credential values out of text that is about to be logged or sent to
 * the phone.
 *
 * Some error text is not ours: an HTTP client can quote the request it
 * failed on (headers included), a spawned agent can print its environment,
 * and a provider's own refusal can repeat the key it was given. Those layers
 * must keep their diagnostics, so the value is removed here instead — in the
 * forms it commonly travels in, so neither the raw token nor its base64
 * encoding survives. Only values long enough to be a credential are
 * replaced: a shorter one can occur in ordinary words and would mangle the
 * message without hiding a real secret.
 */

export const REDACTED = '[redacted]';

/** Below this length a value is not treated as a credential. */
const MIN_SECRET_LENGTH = 8;

/** The forms one secret may appear in. */
function formsOf(secret: string): string[] {
  const bytes = Buffer.from(secret, 'utf8');
  return [
    secret,
    `Bearer ${secret}`,
    // A key in an address (a query string, a pasted callback) is escaped.
    encodeURIComponent(secret),
    bytes.toString('base64'),
    bytes.toString('base64').replace(/=+$/, ''),
    bytes.toString('base64url'),
  ];
}

/** `text` with every occurrence of each secret (and its encodings) removed. */
export function redactSecrets(text: string, secrets: Iterable<string | null | undefined>): string {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) continue;
    for (const form of formsOf(secret)) if (form.length >= MIN_SECRET_LENGTH) forms.add(form);
  }
  // Longest first across every secret, not per secret: one secret can be
  // part of another (a token, and a header value built from it), and
  // removing the shorter first would cut the longer apart and leave the rest
  // of it in the text.
  let out = text;
  for (const form of [...forms].sort((a, b) => b.length - a.length)) out = out.split(form).join(REDACTED);
  return out;
}
