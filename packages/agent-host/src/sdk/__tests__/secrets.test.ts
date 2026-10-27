/**
 * The secret guard itself: a clean line passes, and every way a credential
 * commonly escapes — whole, truncated, in a Bearer header, base64-encoded —
 * is caught with a message that names what leaked and where.
 */
import { describe, expect, it } from 'vitest';
import { LEAK_WINDOW, TEST_SECRETS, expectNoSecretLeaks, findSecretLeak } from './secrets';

const token = TEST_SECRETS.providerToken;

describe('the secret guard', () => {
  it('passes an ordinary diagnostic line', () => {
    expect(() =>
      expectNoSecretLeaks({
        logs: ['[agent-host] dropped frame: malformed frame: no kind'],
        frames: [{ kind: 'error', payload: { message: 'the provider refused the token (HTTP 401)' } }],
      }),
    ).not.toThrow();
  });

  it('catches the whole value, a truncated value, a Bearer header and base64', () => {
    expect(findSecretLeak(`token=${token}`)).toMatch(/the value/);
    expect(findSecretLeak(`token=${token.slice(0, LEAK_WINDOW)}`)).toMatch(/12-character part/);
    expect(findSecretLeak(`authorization: Bearer ${token}`)).toMatch(/Bearer/);
    expect(findSecretLeak(`encoded ${Buffer.from(token).toString('base64')}`)).toMatch(/base64/);
  });

  it('names the leaking log line and the secret', () => {
    expect(() =>
      expectNoSecretLeaks({ logs: ['clean', `provider failed: ${token}`] }),
    ).toThrow(/log line 2 contains the value of/);
  });

  it('checks frames and session events, not only logs', () => {
    expect(() => expectNoSecretLeaks({ frames: [{ message: `Bearer ${token}` }] })).toThrow(/wire frame 1/);
    expect(() => expectNoSecretLeaks({ events: [{ type: 'ended', error: `key ${TEST_SECRETS.apiKey}` }] })).toThrow(
      /session event 1/,
    );
  });
});
