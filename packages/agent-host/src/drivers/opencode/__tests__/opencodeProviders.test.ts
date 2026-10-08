/**
 * Provider profiles as OpenCode providers: the config the server starts
 * with, the password guarding it, and the restart a changed list takes.
 */
import { describe, expect, it, vi } from 'vitest';
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import { OpenCodeDriver } from '../driver';
import { profileModelGroup, providersConfig, serverSetup } from '../providers';
import type { StartOpenCodeServerOptions } from '../server';
import type { ProviderBinding } from '../../../sdk/types';

const router = (over: Partial<ProviderBinding> = {}): ProviderBinding => ({
  id: 'router',
  label: 'Home router',
  baseUrl: 'http://192.168.1.2:3458',
  authToken: 'tok-secret',
  models: [{ id: 'Z.ai/glm-5', label: 'GLM 5' }, { id: 'kimi-k3' }],
  defaultModel: 'kimi-k3',
  ...over,
});

describe('providersConfig', () => {
  it("adds each profile as a provider of its own, beside the operator's, with the token left to the environment", () => {
    const config = providersConfig([router()], { provider: { mine: { npm: 'x' } }, theme: 'dark' });
    expect(config).toEqual({
      theme: 'dark',
      provider: {
        mine: { npm: 'x' },
        'codedeck-router': {
          npm: '@ai-sdk/openai-compatible',
          name: 'Home router',
          options: { baseURL: 'http://192.168.1.2:3458/v1', apiKey: '{env:CODEDECK_PROVIDER_KEY_0}' },
          models: { 'Z.ai/glm-5': { name: 'GLM 5' }, 'kimi-k3': {} },
        },
      },
    });
    expect(JSON.stringify(config)).not.toContain('tok-secret');
  });

  it('names a routed model without its upstream, which its group shows, and gives OpenCode a known context window', () => {
    const routed = router({ models: [{ id: 'OpenCode Go/deepseek-v4.1-flash', provider: 'OpenCode Go', contextWindow: 1_000_000 }] });
    const provider = (providersConfig([routed]).provider as Record<string, { models: Record<string, unknown> }>)['codedeck-router']!;
    expect(provider.models).toEqual({
      'OpenCode Go/deepseek-v4.1-flash': { name: 'deepseek-v4.1-flash', limit: { context: 1_000_000, output: 0 } },
    });
    expect(profileModelGroup('CCR', routed.models[0])).toBe('CCR · OpenCode Go');
    expect(profileModelGroup('CCR', { id: 'kimi-k3' })).toBe('CCR');
  });

  it('does not restrict the providers OpenCode already has', () => {
    const config = providersConfig([router()]);
    expect(config).not.toHaveProperty('enabled_providers');
    expect(config).not.toHaveProperty('disabled_providers');
    expect(config).not.toHaveProperty('model');
  });
});

describe('serverSetup', () => {
  it('passes the tokens in the environment and guards the server with a password of its own', () => {
    const a = serverSetup([router(), router({ id: 'or', authToken: 'tok-2' })], {});
    expect(a.env.CODEDECK_PROVIDER_KEY_0).toBe('tok-secret');
    expect(a.env.CODEDECK_PROVIDER_KEY_1).toBe('tok-2');
    expect(JSON.parse(a.env.OPENCODE_CONFIG_CONTENT!).provider).toHaveProperty('codedeck-or');
    const password = a.env.OPENCODE_SERVER_PASSWORD!;
    expect(password).toMatch(/^[0-9a-f]{48}$/);
    expect(a.headers.authorization).toBe(`Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`);
    expect(serverSetup([], {}).env.OPENCODE_SERVER_PASSWORD).not.toBe(password);
    // No profiles: the operator's config stands as it is.
    expect(serverSetup([], { OPENCODE_CONFIG_CONTENT: '{"theme":"x"}' }).env).not.toHaveProperty('OPENCODE_CONFIG_CONTENT');
  });

  it("keeps the operator's own environment config underneath", () => {
    const { env } = serverSetup([router()], { OPENCODE_CONFIG_CONTENT: '{"provider":{"mine":{"npm":"x"}}}' });
    expect(Object.keys(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).provider)).toEqual(['mine', 'codedeck-router']);
  });
});

describe('an OpenCode driver given provider profiles', () => {
  function managed() {
    const starts: StartOpenCodeServerOptions[] = [];
    const closed: number[] = [];
    const connects: Array<{ baseUrl: string; headers?: Record<string, string> }> = [];
    const driver = OpenCodeDriver.create({
      autoStart: true,
      // Any file stands in for the executable: the start is faked.
      binaryPath: process.execPath,
      log: () => {},
      startServer: async (options) => {
        starts.push(options);
        const n = starts.length;
        return { url: `http://127.0.0.1:${4100 + n}`, pid: n, exited: new Promise(() => {}), close: async () => void closed.push(n) };
      },
      connect: (config) => {
        connects.push(config);
        return {} as OpencodeClient;
      },
    });
    return { driver, starts, closed, connects };
  }

  it('adds them to the server it starts, and restarts it only when they change', async () => {
    const { driver: created, starts, closed, connects } = managed();
    const driver = await created;
    expect(driver.info().supports?.providerModels).toBe(true);
    expect(driver.info().supports?.providers).toBe(false);
    expect(starts).toHaveLength(1);
    expect(starts[0]!.env).not.toHaveProperty('OPENCODE_CONFIG_CONTENT');
    expect(connects[0]!.headers?.authorization).toMatch(/^Basic /);

    await driver.setProviders([router()]);
    expect(starts).toHaveLength(2);
    expect(closed).toEqual([1]);
    expect(starts[1]!.env?.CODEDECK_PROVIDER_KEY_0).toBe('tok-secret');

    await driver.setProviders([router()]);
    expect(starts).toHaveLength(2);

    // One the bridge would not let a session use is left out.
    await driver.setProviders([router(), router({ id: 'bad', baseUrl: 'http://8.8.8.8' })]);
    expect(starts).toHaveLength(2);

    await driver.setProviders([]);
    expect(starts).toHaveLength(3);
    expect(starts[2]!.env).not.toHaveProperty('OPENCODE_CONFIG_CONTENT');
    await driver.shutdown();
    expect(closed).toEqual([1, 2, 3]);
  });

  it('refuses them for a server it does not start', async () => {
    const driver = await OpenCodeDriver.create({ serverUrl: 'http://127.0.0.1:4096', log: () => {}, connect: () => ({}) as OpencodeClient });
    expect(driver.info().supports?.providerModels).toBe(false);
    await expect(driver.setProviders([router()])).rejects.toThrow(/does not start/);
  });

  it('checks and lists a profile as an OpenAI-compatible endpoint', async () => {
    const post = vi.fn().mockResolvedValue({ status: 401 });
    const get = vi.fn().mockResolvedValue({ status: 200, text: JSON.stringify({ data: [{ id: 'kimi-k3' }] }) });
    const driver = await OpenCodeDriver.create({ serverUrl: 'http://x', log: () => {}, providerHttp: { get, post }, connect: () => ({}) as OpencodeClient });
    expect(await driver.checkProvider(router(), 'kimi-k3')).toBe(false);
    const [url, headers, body] = post.mock.calls[0]!;
    expect(url).toBe('http://192.168.1.2:3458/v1/chat/completions');
    expect(headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer tok-secret' });
    expect(JSON.parse(body)).toMatchObject({ model: 'kimi-k3', max_tokens: 1 });
    // Its models are read the same way: the OpenAI sign-in only.
    expect(await driver.listProviderModels('http://192.168.1.2:3458', 'tok-secret')).toEqual([{ id: 'kimi-k3' }]);
    expect(get).toHaveBeenCalledWith('http://192.168.1.2:3458/v1/models', { authorization: 'Bearer tok-secret' });
  });
});
