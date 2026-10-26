/**
 * The one assertion every secret-carrying path is tested with: no value of a
 * credential may reach a diagnostic log line or a frame the host relays to
 * the bridge.
 *
 * A leak is rarely the whole token. An error that quotes a request may carry
 * the token inside a header (`Bearer …`, `x-api-key: …`), an encoder may
 * transform it, and a message that truncates it still exposes enough to use.
 * The values here are long and distinctive, so a random 12-character window
 * of one cannot occur in an ordinary sentence — checking every window catches
 * a partial leak as surely as the whole value, and the common encodings catch
 * the same value in a form the raw check would miss.
 */

/** How much of a secret is enough to count as a leak. */
export const LEAK_WINDOW = 12;

/**
 * Distinctive credentials, one per kind a host process handles. They are
 * long enough for the window check and unrelated to each other, so a line
 * that leaks one is never mistaken for a line that merely names another.
 */
export const TEST_SECRETS = {
  /** A provider profile's API token. */
  providerToken: 'sk-cdx-7Qm2Lp9Rt4Vb8Nz1Kx5Jr3Hd',
  /** A stored API key (Anthropic's, DeepSeek's). */
  apiKey: 'ant-cdx-3Vn8Kq2Ws6Ye1Pu4Tz9Mo7Lb',
  /** A GitHub personal access token handed to a session's environment. */
  githubPat: 'ghp_cdx9Rt4Vb8Nz1Kx5Jr3Hd7Qm',
  /** The secret half of an OAuth paste-back address. */
  sessionCode: 'cdx-code-6Ye1Pu4Tz9Mo7Lb3Vn8Kq2Ws',
} as const;

/** One way a secret can appear in text. */
interface Encoding {
  form: string;
  text: string;
}

/** The forms a secret is looked for in, beyond its raw characters. */
function encodingsOf(secret: string): Encoding[] {
  const bytes = Buffer.from(secret, 'utf8');
  const base64 = bytes.toString('base64');
  const base64url = bytes.toString('base64url');
  // Longer, more specific forms first: a Bearer value contains the raw
  // secret, so it must be named as the header it leaked in, not as the
  // value alone.
  return [
    { form: 'base64', text: base64 },
    // Some encoders omit the padding.
    { form: 'base64 without padding', text: base64.replace(/=+$/, '') },
    { form: 'base64url', text: base64url },
    { form: 'a Bearer header value', text: `Bearer ${secret}` },
    { form: 'the value', text: secret },
  ];
}

/**
 * What `text` leaks of `secrets`, in words for the failure message; undefined
 * when it carries none of them.
 */
export function findSecretLeak(text: string, secrets: readonly string[] = Object.values(TEST_SECRETS)): string | undefined {
  for (const secret of secrets) {
    for (const encoding of encodingsOf(secret)) {
      if (text.includes(encoding.text)) return `${encoding.form} of '${secret}'`;
    }
    for (let at = 0; at + LEAK_WINDOW <= secret.length; at++) {
      const part = secret.slice(at, at + LEAK_WINDOW);
      if (text.includes(part)) return `a ${LEAK_WINDOW}-character part of '${secret}' ('${part}')`;
    }
  }
  return undefined;
}

/** Everything a test captured from one path. */
export interface CapturedTraffic {
  /** Diagnostic lines the host or a driver logged. */
  logs?: readonly string[];
  /** Frames written to the bridge, or values a driver returned. */
  frames?: readonly unknown[];
  /** Events a session reported; these reach the phone too. */
  events?: readonly unknown[];
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Fail — naming the exact log line, frame or event — when any captured text
 * carries a secret in any of the forms above.
 */
export function expectNoSecretLeaks(
  traffic: CapturedTraffic,
  secrets: readonly string[] = Object.values(TEST_SECRETS),
): void {
  const leaks: string[] = [];
  const check = (label: string, value: unknown): void => {
    const text = asText(value);
    const leak = findSecretLeak(text, secrets);
    if (leak) leaks.push(`${label} contains ${leak}: ${JSON.stringify(text)}`);
  };
  (traffic.logs ?? []).forEach((line, index) => check(`log line ${index + 1}`, line));
  (traffic.frames ?? []).forEach((frame, index) => check(`wire frame ${index + 1}`, frame));
  (traffic.events ?? []).forEach((event, index) => check(`session event ${index + 1}`, event));
  if (leaks.length > 0) throw new Error(`secret leak:\n${leaks.join('\n')}`);
}
