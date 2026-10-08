/**
 * The environment one harness process runs in, for the native route and for a
 * custom provider (a gateway), in the style of claudeEnv.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { PROVIDER_BASE_URL_ERROR } from '../../../sdk/provider';
import type { ProviderBinding } from '../../../sdk/types';
import {
  DEEPSEEK_API_KEY_CREDENTIAL,
  buildDeepSeekEnv,
  sanitizeDeepSeekBaseEnv,
  takeDeepSeekEnv,
} from '../env';

const BASE: Record<string, string | undefined> = {
  PATH: '/usr/bin',
  HOME: '/home/bridge',
  DSH_HOME: '/data/dsh',
  GITHUB_TOKEN: 'gh',
  DEEPSEEK_BASE_URL: 'https://relay.example/anthropic',
  DEEPSEEK_API_KEY: 'native-key',
};

const provider = (overrides: Partial<ProviderBinding> = {}): ProviderBinding => ({
  id: 'gateway',
  baseUrl: 'https://gateway.example/v1',
  authToken: 'sk-gateway',
  models: [],
  ...overrides,
});

describe('buildDeepSeekEnv', () => {
  it('leaves the operator environment alone when nothing is stored', () => {
    const env = buildDeepSeekEnv({}, BASE);
    expect(env.DEEPSEEK_API_KEY).toBe('native-key');
    expect(env.DEEPSEEK_BASE_URL).toBe('https://relay.example/anthropic');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('adds the stored credential when the operator set none', () => {
    const env = buildDeepSeekEnv({ credentials: { [DEEPSEEK_API_KEY_CREDENTIAL]: 'sk-stored' } }, { PATH: '/usr/bin' });
    expect(env.DEEPSEEK_API_KEY).toBe('sk-stored');
  });

  it('lets the operator’s own key win over a stored one', () => {
    const env = buildDeepSeekEnv({ credentials: { [DEEPSEEK_API_KEY_CREDENTIAL]: 'sk-stored' } }, BASE);
    expect(env.DEEPSEEK_API_KEY).toBe('native-key');
  });

  it('merges the bridge-level environment last', () => {
    const env = buildDeepSeekEnv(
      { credentials: { [DEEPSEEK_API_KEY_CREDENTIAL]: 'sk-stored' }, env: { GITHUB_TOKEN: 'gh-session', DEEPSEEK_API_KEY: 'sk-env' } },
      BASE,
    );
    expect(env.GITHUB_TOKEN).toBe('gh-session');
    expect(env.DEEPSEEK_API_KEY).toBe('sk-env');
  });

  it('points a provider-bound session at the provider, with its own token', () => {
    const env = buildDeepSeekEnv({ provider: provider() }, BASE);
    expect(env.DEEPSEEK_BASE_URL).toBe('https://gateway.example/v1');
    expect(env.DEEPSEEK_API_KEY).toBe('sk-gateway');
  });

  it('leaves nothing of the harness’s own endpoint or key namespace behind', () => {
    const env = buildDeepSeekEnv({ provider: provider() }, BASE);
    // The operator's relay must not survive: the session is bound to the
    // provider profile, and routing it anywhere else would bill the wrong
    // account.
    expect(env.DEEPSEEK_BASE_URL).toBe('https://gateway.example/v1');
    expect(Object.keys(env).filter((key) => key.startsWith('DEEPSEEK_'))).toEqual(['DEEPSEEK_BASE_URL', 'DEEPSEEK_API_KEY']);
    // Everything else — including where the harness keeps its state — is
    // untouched: a session that cannot find its home is not more secure.
    expect(env.DSH_HOME).toBe('/data/dsh');
    expect(env.GITHUB_TOKEN).toBe('gh');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('merges the bridge-level environment into a provider session too', () => {
    const env = buildDeepSeekEnv({ provider: provider(), env: { GITHUB_TOKEN: 'gh-session' } }, BASE);
    expect(env.GITHUB_TOKEN).toBe('gh-session');
  });

  it('refuses an insecure provider base URL', () => {
    expect(() => buildDeepSeekEnv({ provider: provider({ baseUrl: 'http://gateway.example/v1' }) }, BASE)).toThrow(
      PROVIDER_BASE_URL_ERROR,
    );
    expect(() => buildDeepSeekEnv({ provider: provider({ baseUrl: 'ftp://gateway.example' }) }, BASE)).toThrow(PROVIDER_BASE_URL_ERROR);
    expect(() => buildDeepSeekEnv({ provider: provider({ baseUrl: 'not a url' }) }, BASE)).toThrow(PROVIDER_BASE_URL_ERROR);
  });

  it('allows cleartext to a local model server', () => {
    const env = buildDeepSeekEnv({ provider: provider({ baseUrl: 'http://127.0.0.1:11434/v1' }) }, BASE);
    expect(env.DEEPSEEK_BASE_URL).toBe('http://127.0.0.1:11434/v1');
  });

  it('refuses a provider profile with no token', () => {
    expect(() => buildDeepSeekEnv({ provider: provider({ authToken: '' }) }, BASE)).toThrow(/has no stored auth token/);
  });
});

describe('sanitizeDeepSeekBaseEnv', () => {
  it('drops the harness namespace, in any case, and keeps the rest', () => {
    expect(
      sanitizeDeepSeekBaseEnv({
        PATH: '/usr/bin',
        DSH_HOME: '/data/dsh',
        GITHUB_TOKEN: 'gh',
        DEEPSEEK_API_KEY: 'k',
        DEEPSEEK_BASE_URL: 'https://relay.example',
        deepseek_anything_else: 'future',
      }),
    ).toEqual({ PATH: '/usr/bin', DSH_HOME: '/data/dsh', GITHUB_TOKEN: 'gh' });
  });

  it('skips variables an operator left unset', () => {
    expect(sanitizeDeepSeekBaseEnv({ PATH: undefined, HOME: '/home' })).toEqual({ HOME: '/home' });
  });
});

describe('takeDeepSeekEnv', () => {
  it('keeps the harness settings for its driver and out of every other agent', () => {
    const host = {
      PATH: '/bin',
      DEEPSEEK_API_KEY: 'sk-ds',
      DEEPSEEK_BASE_URL: 'https://gateway.example',
      CODEDECK_DEEPSEEK_HOME: '/data/dsh',
    } as NodeJS.ProcessEnv;
    const harness = takeDeepSeekEnv(host);
    expect(harness).toEqual({
      PATH: '/bin',
      DEEPSEEK_API_KEY: 'sk-ds',
      DEEPSEEK_BASE_URL: 'https://gateway.example',
      CODEDECK_DEEPSEEK_HOME: '/data/dsh',
    });
    // What the other agents' processes inherit: the host's own settings for
    // the harness stay, the harness's endpoint and key do not.
    expect(host).toEqual({ PATH: '/bin', CODEDECK_DEEPSEEK_HOME: '/data/dsh' });
  });
});
