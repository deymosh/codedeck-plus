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

/** The forms one secret may appear in, longest first. */
function formsOf(secret: string): string[] {
  const bytes = Buffer.from(secret, 'utf8');
  const forms = new Set([
    secret,
    `Bearer ${secret}`,
    bytes.toString('base64'),
    bytes.toString('base64').replace(/=+$/, ''),
    bytes.toString('base64url'),
  ]);
  return [...forms].filter((form) => form.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
}

/** `text` with every occurrence of each secret (and its encodings) removed. */
export function redactSecrets(text: string, secrets: Iterable<string | null | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) continue;
    for (const form of formsOf(secret)) out = out.split(form).join(REDACTED);
  }
  return out;
}
