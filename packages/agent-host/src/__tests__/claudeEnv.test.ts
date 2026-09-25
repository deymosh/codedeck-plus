/**
 * buildClaudeEnv — how stored credentials and a provider binding become the
 * Claude Code subprocess environment. Cases ported from the TS bridge's
 * buildSessionEnv tests; the rules are unchanged.
 */
import { describe, it, expect } from 'vitest';
import {
  buildClaudeEnv,
  PROVIDER_BASE_URL_ERROR,
  sanitizeProviderBaseEnv,
} from '../drivers/claude/env';
import type { ProviderBinding, StartSession } from '../types';

const KIMI_TOKEN = 'sk-kimi-TESTSECRET-000';

function kimi(over: Partial<ProviderBinding> = {}): ProviderBinding {
  return {
    id: 'kimi',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    authToken: KIMI_TOKEN,
    models: [{ id: 'kimi-k3', label: 'Kimi K3' }, { id: 'kimi-k3-turbo' }],
    defaultModel: 'kimi-k3',
    ...over,
  };
}

type Stored = { anthropicApiKey?: string; githubPat?: string };

/** The bridge's stored credentials as the driver receives them. */
function params(stored: Stored = {}, provider?: ProviderBinding): Pick<StartSession, 'credentials' | 'env' | 'provider'> {
  return {
    ...(stored.anthropicApiKey ? { credentials: { anthropic_api_key: stored.anthropicApiKey } } : {}),
    ...(stored.githubPat ? { env: { GITHUB_TOKEN: stored.githubPat } } : {}),
    ...(provider ? { provider } : {}),
  };
}

describe('buildClaudeEnv without a provider', () => {
  it('env ANTHROPIC_API_KEY wins over stored; GITHUB_TOKEN is stored-wins', () => {
    const env = buildClaudeEnv(
      params({ anthropicApiKey: 'sk-stored', githubPat: 'ghp_stored' }),
      { ANTHROPIC_API_KEY: 'sk-env', GITHUB_TOKEN: 'ghp_env', PATH: '/bin', UNDEF: undefined },
    );
    expect(env).toEqual({ ANTHROPIC_API_KEY: 'sk-env', GITHUB_TOKEN: 'ghp_stored', PATH: '/bin' });
  });

  it('nothing stored → undefined (inherit), even with env vars present', () => {
    expect(buildClaudeEnv(params(), { ANTHROPIC_API_KEY: 'sk-env' })).toBeUndefined();
  });

  it('a stored key alone is used; the subscription OAuth token is untouched', () => {
    expect(buildClaudeEnv(params({ anthropicApiKey: 'sk-stored' }), { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'oat' }))
      .toEqual({ ANTHROPIC_API_KEY: 'sk-stored', PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'oat' });
  });
});

describe('buildClaudeEnv with a provider', () => {
  const base = { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-env', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-env', GITHUB_TOKEN: 'ghp_env', UNDEF: undefined };

  it('scrubs the vendor namespace, then sets the base URL, token and background model', () => {
    const env = buildClaudeEnv(params({ githubPat: 'ghp_stored' }, kimi()), base)!;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(KIMI_TOKEN);
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('kimi-k3');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-k3');
    expect(env.GITHUB_TOKEN).toBe('ghp_stored');
    expect(env.PATH).toBe('/bin');
    expect('UNDEF' in env).toBe(false);
  });

  it('without a default model the first listed one is the background model', () => {
    const env = buildClaudeEnv(params({}, kimi({ defaultModel: undefined })), base)!;
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('kimi-k3');
  });

  it('refuses a binding without a token', () => {
    expect(() => buildClaudeEnv(params({}, kimi({ authToken: '' })), base)).toThrow(/no stored auth token/);
  });

  it('refuses an insecure base URL, naming it, before looking at the token', () => {
    for (const bad of ['http://api.moonshot.ai/anthropic', 'http://evil.localhost:8080', 'http://0.0.0.0:11434', 'ftp://api.moonshot.ai', 'not-a-url']) {
      expect(() => buildClaudeEnv(params({}, kimi({ baseUrl: bad })), base)).toThrow(PROVIDER_BASE_URL_ERROR);
      expect(() => buildClaudeEnv(params({}, kimi({ baseUrl: bad })), base)).toThrow(bad);
    }
    for (const ok of ['http://localhost:11434', 'http://127.0.0.1:1234', 'http://[::1]:8080']) {
      expect(buildClaudeEnv(params({}, kimi({ baseUrl: ok })), base)!.ANTHROPIC_BASE_URL).toBe(ok);
    }
    expect(() => buildClaudeEnv(params({}, kimi({ baseUrl: 'http://api.moonshot.ai', authToken: '' })), base))
      .toThrow(/insecure base URL/);
  });
});

/** An operator shell configured for several clouds at once. */
const OPERATOR_ENV: Record<string, string | undefined> = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/home/op',
  HTTPS_PROXY: 'http://proxy.corp:3128',
  NODE_EXTRA_CA_CERTS: '/etc/ssl/corp-ca.pem',
  GITHUB_TOKEN: 'ghp_env',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_VERTEX: '1',
  CLOUD_ML_REGION: 'us-east5',
  ANTHROPIC_BASE_URL: 'https://gateway.corp/v1',
  ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock.corp',
  ANTHROPIC_API_KEY: 'sk-env',
  ANTHROPIC_AUTH_TOKEN: 'sk-gateway-token',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-env',
  AWS_ACCESS_KEY_ID: 'AKIAOPERATOR',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  GOOGLE_APPLICATION_CREDENTIALS: '/home/op/gcp.json',
  ANTHROPIC_CUSTOM_HEADERS: 'X-Gateway-Key: gw-secret-abc\nX-Tenant: acme',
  CLAUDE_CODE_CLIENT_KEY_PASSPHRASE: 'passphrase',
  ANTHROPIC_MODEL: 'claude-opus-4-5',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
  CLAUDE_CONFIG_DIR: '/home/op/.config/claude',
  CLAUDE_CODE_SHELL: '/bin/zsh',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  UNSET: undefined,
};

const OPERATOR_SECRETS = ['sk-env', 'sk-gateway-token', 'sk-ant-oat-env', 'AKIAOPERATOR', 'aws-secret', 'gw-secret-abc', 'passphrase'];

describe('provider env sanitization', () => {
  it('a cloud-configured operator shell cannot outrank the profile, and none of its secrets survive', () => {
    const env = buildClaudeEnv(params({}, kimi()), OPERATOR_ENV)!;
    for (const flag of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLOUD_ML_REGION', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_MODEL']) {
      expect(env[flag], flag).toBeUndefined();
    }
    const serialized = JSON.stringify(env);
    for (const secret of OPERATOR_SECRETS) expect(serialized.includes(secret), secret).toBe(false);
    expect(serialized).toContain(KIMI_TOKEN);
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-k3');
  });

  it('legitimate env and the keep-list survive', () => {
    const env = buildClaudeEnv(params({}, kimi()), OPERATOR_ENV)!;
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin:/bin');
    expect(env.HTTPS_PROXY).toBe('http://proxy.corp:3128');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/corp-ca.pem');
    expect(env.GITHUB_TOKEN).toBe('ghp_env');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/op/.config/claude');
    expect(env.CLAUDE_CODE_SHELL).toBe('/bin/zsh');
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    expect('UNSET' in env).toBe(false);
  });

  it('a vendor var invented after this code was written is dropped by default', () => {
    expect(sanitizeProviderBaseEnv({
      PATH: '/bin',
      CLAUDE_CODE_USE_SOME_CLOUD_2027: '1',
      ANTHROPIC_FUTURE_ROUTING_HINT: 'x',
      AWS_NEW_CREDENTIAL_THING: 'x',
      GOOGLE_NEXT_THING: 'x',
      AZURE_SOMETHING: 'x',
    })).toEqual({ PATH: '/bin' });
  });

  it('is case-insensitive about names (Windows env is)', () => {
    const env = sanitizeProviderBaseEnv({ Path: 'C:\\bin', anthropic_api_key: 'sk', claude_config_dir: '/c' });
    expect(env).toEqual({ Path: 'C:\\bin', claude_config_dir: '/c' });
  });

  it('the Anthropic (no-provider) path keeps the operator configuration as it is', () => {
    const env = buildClaudeEnv(params({ anthropicApiKey: 'sk-stored' }), OPERATOR_ENV)!;
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Gateway-Key: gw-secret-abc\nX-Tenant: acme');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-env');
  });
});
