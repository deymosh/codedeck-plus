/**
 * Provider profiles as OpenCode providers: where OpenCode's catalog places
 * each, the config the server starts with, the password guarding it, and
 * the restart a changed list takes.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Model, OpencodeClient, Provider } from '@opencode-ai/sdk/v2/client';
import { OpenCodeDriver } from '../driver';
import { type Catalog, EMPTY_CATALOG } from '../catalog';
import { placeProfiles, profileModelGroup, profileProviderId, providersConfig, servedBy, serverSetup } from '../providers';
import type { StartOpenCodeServerOptions } from '../server';
import type { ProviderBinding } from '../../../sdk/types';
import { recordingContext } from '../../../sdk/__tests__/context';

const router = (over: Partial<ProviderBinding> = {}): ProviderBinding => ({
  id: 'router',
  label: 'Home router',
  baseUrl: 'http://192.168.1.2:3458',
  authToken: 'tok-secret',
  models: [{ id: 'Z.ai/glm-5', label: 'GLM 5' }, { id: 'kimi-k3' }],
  defaultModel: 'kimi-k3',
  ...over,
});

/** A catalog provider, as OpenCode's server lists it. */
function catalogProvider(id: string, name: string, url: string, models: Record<string, Partial<Model>> = {}): Provider {
  return {
    id,
    name,
    source: 'api',
    env: [],
    options: {},
    models: Object.fromEntries(
      Object.entries(models).map(([mid, m]) => [mid, { id: mid, providerID: id, api: { id: mid, url, npm: '@ai-sdk/openai-compatible' }, name: mid, ...m } as Model]),
    ),
  } as Provider;
}

const reasoningModel: Partial<Model> = {
  name: 'DeepSeek V4.1 Flash',
  family: 'deepseek',
  capabilities: {
    temperature: true, reasoning: true, attachment: true, toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: { field: 'reasoning_content' },
  },
  cost: { input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } },
  limit: { context: 1_000_000, output: 393_216 },
};

const catalog: Catalog = {
  providers: new Map([
    ['deepseek', catalogProvider('deepseek', 'DeepSeek', 'https://api.deepseek.com', { 'deepseek-flash': reasoningModel })],
    ['opencode-go', catalogProvider('opencode-go', 'OpenCode Go', 'https://opencode.ai/zen/go/v1', { 'deepseek-v4.1-flash': reasoningModel })],
    ['openrouter', catalogProvider('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', { 'deepseek/deepseek-chat': {} })],
    ['opencode', catalogProvider('opencode', 'OpenCode Zen', 'https://opencode.ai/zen/v1')],
  ]),
  connected: new Set(['opencode', 'deepseek']),
};

const providerOf = (config: Record<string, unknown>, id: string) => (config.provider as Record<string, Record<string, unknown>>)[id]!;

describe('placing profiles', () => {
  it('names a profile of its own as the user named it', () => {
    expect(profileProviderId(router({ label: 'CCR' }))).toBe('ccr');
    expect(profileProviderId(router({ label: 'OpenCode Go (OpenAI)' }))).toBe('opencode-go-openai');
    expect(profileProviderId(router({ label: 'Café / LAN' }))).toBe('cafe-lan');
    expect(profileProviderId(router({ label: '★', id: 'p-7' }))).toBe('p-7');
  });

  it("signs in to a provider OpenCode knows by its endpoint, unless OpenCode already uses it", () => {
    const openrouter = router({ id: 'or', label: 'My OpenRouter', baseUrl: 'https://openrouter.ai/api' });
    const deepseek = router({ id: 'ds', label: 'DeepSeek API', baseUrl: 'https://api.deepseek.com/v1' });
    const { placed, refused } = placeProfiles([openrouter, deepseek], catalog);
    expect(placed.map((p) => [p.profile.id, p.providerId, p.known?.id])).toEqual([['or', 'openrouter', 'openrouter']]);
    expect(refused).toEqual([{ id: 'ds', reason: 'OpenCode already uses DeepSeek with a key of its own; this profile would replace it.' }]);
  });

  it("leaves out a name one of OpenCode's providers, or an earlier profile, already has", () => {
    const ccr = router({ id: 'a', label: 'CCR' });
    const again = router({ id: 'b', label: 'ccr' });
    const named = router({ id: 'c', label: 'DeepSeek' });
    const { placed, refused } = placeProfiles([ccr, again, named], catalog);
    expect(placed.map((p) => p.providerId)).toEqual(['ccr']);
    expect(refused).toEqual([
      { id: 'b', reason: "The provider profile 'CCR' already goes by 'ccr' in OpenCode. Give this one another name." },
      { id: 'c', reason: "OpenCode already has a provider called 'deepseek'. Give this profile another name." },
    ]);
  });

  it('never takes what profiles already made of the running server for OpenCode\'s own', () => {
    // The running server lists the profile's provider, and the catalog one
    // it signed in to as connected.
    const running: Catalog = {
      providers: new Map([...catalog.providers, ['ccr', catalogProvider('ccr', 'CCR', 'http://192.168.1.2:3458/v1', { m: {} })]]),
      connected: new Set([...catalog.connected, 'ccr', 'openrouter']),
    };
    const served = servedBy(placeProfiles([router({ label: 'CCR' }), router({ id: 'or', label: 'OR', baseUrl: 'https://openrouter.ai/api' })], catalog).placed);
    const again = placeProfiles([router({ label: 'CCR' }), router({ id: 'or', label: 'OR', baseUrl: 'https://openrouter.ai/api' })], running, served);
    expect(again.refused).toEqual([]);
    expect(again.placed.map((p) => p.providerId)).toEqual(['ccr', 'openrouter']);
  });
});

describe('providersConfig', () => {
  it("adds a profile of its own beside the operator's providers, with the token left to the environment", () => {
    const { placed } = placeProfiles([router()], catalog);
    const config = providersConfig(placed, catalog, { provider: { mine: { npm: 'x' } }, theme: 'dark' });
    expect(config).toEqual({
      theme: 'dark',
      provider: {
        mine: { npm: 'x' },
        'home-router': {
          npm: '@ai-sdk/openai-compatible',
          name: 'Home router',
          options: { baseURL: 'http://192.168.1.2:3458/v1', apiKey: '{env:CODEDECK_PROVIDER_KEY_0}' },
          models: { 'Z.ai/glm-5': { name: 'GLM 5' }, 'kimi-k3': {} },
        },
      },
    });
    expect(JSON.stringify(config)).not.toContain('tok-secret');
  });

  it("fills a gateway's routed model in from the catalog, without its price", () => {
    const routed = router({ label: 'CCR', models: [{ id: 'OpenCode Go/deepseek-v4.1-flash', provider: 'OpenCode Go' }] });
    const { placed } = placeProfiles([routed], catalog);
    expect(providerOf(providersConfig(placed, catalog), 'ccr').models).toEqual({
      'OpenCode Go/deepseek-v4.1-flash': {
        name: 'deepseek-v4.1-flash',
        family: 'deepseek',
        limit: { context: 1_000_000, output: 393_216 },
        reasoning: true,
        tool_call: true,
        temperature: true,
        attachment: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
      },
    });
    expect(profileModelGroup('CCR', routed.models[0])).toBe('CCR · OpenCode Go');
    expect(profileModelGroup('CCR', { id: 'kimi-k3' })).toBe('CCR');
  });

  it("keeps the endpoint's own context window over the catalog's", () => {
    const routed = router({ label: 'CCR', models: [{ id: 'OpenCode Go/deepseek-v4.1-flash', provider: 'OpenCode Go', contextWindow: 128_000 }] });
    const config = providersConfig(placeProfiles([routed], catalog).placed, catalog);
    expect((providerOf(config, 'ccr').models as Record<string, { limit: unknown }>)['OpenCode Go/deepseek-v4.1-flash']!.limit).toEqual({ context: 128_000, output: 393_216 });
  });

  it("signs a known provider in by its key alone, adding only the endpoint's models the catalog lacks", () => {
    const openrouter = router({ id: 'or', label: 'My OpenRouter', baseUrl: 'https://openrouter.ai/api', models: [{ id: 'deepseek/deepseek-chat' }, { id: 'new/model', label: 'New' }] });
    const config = providersConfig(placeProfiles([openrouter], catalog).placed, catalog);
    expect(providerOf(config, 'openrouter')).toEqual({
      name: 'My OpenRouter',
      options: { apiKey: '{env:CODEDECK_PROVIDER_KEY_0}' },
      models: { 'new/model': { name: 'New' } },
    });
  });

  it('does not restrict the providers OpenCode already has', () => {
    const config = providersConfig(placeProfiles([router()], catalog).placed, catalog);
    expect(config).not.toHaveProperty('enabled_providers');
    expect(config).not.toHaveProperty('disabled_providers');
    expect(config).not.toHaveProperty('model');
  });
});

describe('serverSetup', () => {
  const placedOf = (...profiles: ProviderBinding[]) => placeProfiles(profiles, EMPTY_CATALOG).placed;

  it('passes the tokens in the environment and guards the server with a password of its own', () => {
    const a = serverSetup(placedOf(router(), router({ id: 'or', label: 'My OpenRouter', authToken: 'tok-2' })), EMPTY_CATALOG, {});
    expect(a.env.CODEDECK_PROVIDER_KEY_0).toBe('tok-secret');
    expect(a.env.CODEDECK_PROVIDER_KEY_1).toBe('tok-2');
    expect(JSON.parse(a.env.OPENCODE_CONFIG_CONTENT!).provider).toHaveProperty('my-openrouter');
    const password = a.env.OPENCODE_SERVER_PASSWORD!;
    expect(password).toMatch(/^[0-9a-f]{48}$/);
    expect(a.headers.authorization).toBe(`Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`);
    expect(serverSetup([], EMPTY_CATALOG, {}).env.OPENCODE_SERVER_PASSWORD).not.toBe(password);
    // Web search for every model, not only OpenCode's own providers'.
    expect(serverSetup([], EMPTY_CATALOG, {}).env.OPENCODE_ENABLE_EXA).toBe('1');
    // The pinned version stays.
    expect(serverSetup([], EMPTY_CATALOG, {}).env.OPENCODE_DISABLE_AUTOUPDATE).toBe('1');
    // No profiles: the operator's config stands as it is.
    expect(serverSetup([], EMPTY_CATALOG, { OPENCODE_CONFIG_CONTENT: '{"theme":"x"}' }).env).not.toHaveProperty('OPENCODE_CONFIG_CONTENT');
  });

  it("keeps the operator's own environment config underneath", () => {
    const { env } = serverSetup(placedOf(router()), EMPTY_CATALOG, { OPENCODE_CONFIG_CONTENT: '{"provider":{"mine":{"npm":"x"}}}' });
    expect(Object.keys(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).provider)).toEqual(['mine', 'home-router']);
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

  it('ends the sessions on the server it replaces, so the bridge resumes them on the new one', async () => {
    // Its event stream never opens: a session stays on the server it started on.
    const client = {
      event: { subscribe: () => new Promise(() => {}) },
      provider: { list: async () => ({ error: 'no catalog' }) },
    } as unknown as OpencodeClient;
    let starts = 0;
    const driver = await OpenCodeDriver.create({
      autoStart: true,
      binaryPath: process.execPath,
      log: () => {},
      startServer: async () => {
        const n = ++starts;
        return { url: `http://127.0.0.1:${4100 + n}`, pid: n, exited: new Promise(() => {}), close: async () => {} };
      },
      connect: () => client,
    });
    const ctx = recordingContext();
    driver.startSession({ sessionId: 's1', agent: 'opencode', cwd: '/tmp', model: 'zen/m1', resume: 'n1' }, ctx);
    await driver.setProviders([router()]);
    expect((await ctx.ended()).error).toMatch(/server restarted/);
    // A session started on the new server is not ended by an unchanged list.
    const next = recordingContext();
    driver.startSession({ sessionId: 's2', agent: 'opencode', cwd: '/tmp', model: 'zen/m1', resume: 'n2' }, next);
    await driver.setProviders([router()]);
    expect(next.events.some((e) => e.type === 'ended' && /server restarted/.test(e.error ?? ''))).toBe(false);
    await driver.shutdown();
  });

  it('has a model list asked for during the restart wait for the new server', async () => {
    let release!: () => void;
    const closing = new Promise<void>((resolve) => (release = resolve));
    let starts = 0;
    const client = (n: number) =>
      ({
        config: {
          providers: async () => ({ data: { providers: [{ id: 'zen', name: 'Zen', models: { [`m${n}`]: { id: `m${n}`, name: `M${n}` } } }], default: {} } }),
          get: async () => ({ data: {} }),
        },
      }) as unknown as OpencodeClient;
    const driver = await OpenCodeDriver.create({
      autoStart: true,
      binaryPath: process.execPath,
      log: () => {},
      startServer: async () => {
        const n = ++starts;
        return { url: `http://127.0.0.1:${4100 + n}`, pid: n, exited: new Promise(() => {}), close: () => closing };
      },
      connect: () => client(starts),
    });
    const restart = driver.setProviders([router()]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const listed = driver.listModels();
    release();
    await restart;
    expect((await listed).models.map((m) => m.id)).toEqual(['zen/m2']);
    expect(starts).toBe(2);
  });

  it("leaves out a profile named as one of OpenCode's providers, but never one it added itself", async () => {
    const starts: StartOpenCodeServerOptions[] = [];
    const ids = ['opencode', 'deepseek'];
    const driver = await OpenCodeDriver.create({
      autoStart: true,
      binaryPath: process.execPath,
      log: () => {},
      startServer: async (options) => {
        starts.push(options);
        return { url: `http://127.0.0.1:${4100 + starts.length}`, pid: starts.length, exited: new Promise(() => {}), close: async () => {} };
      },
      // The running server lists what it has, the profiles it was given too.
      connect: () => ({ provider: { list: async () => ({ data: { all: ids.map((id) => ({ id, name: id, models: {} })), default: {}, connected: [] } }) } }) as unknown as OpencodeClient,
    });
    expect(await driver.setProviders([router({ label: 'DeepSeek' })])).toEqual([
      { id: 'router', reason: "OpenCode already has a provider called 'deepseek'. Give this profile another name." },
    ]);
    expect(starts).toHaveLength(1);

    expect(await driver.setProviders([router({ label: 'CCR' })])).toEqual([]);
    expect(starts).toHaveLength(2);
    ids.push('ccr');
    // Saved again, it keeps the name it already has.
    expect(await driver.setProviders([router({ label: 'CCR', models: [{ id: 'other' }] })])).toEqual([]);
    expect(starts).toHaveLength(3);
    await driver.shutdown();
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
