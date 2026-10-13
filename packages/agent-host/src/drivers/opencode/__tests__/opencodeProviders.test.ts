/**
 * Provider profiles as OpenCode providers: where OpenCode's catalog places
 * each, the config the server starts with, the password guarding it, and
 * the restart a changed list takes.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ModelInfo, OpenCodeClient, ProviderInfo } from '@opencode/client';
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
/** A catalog provider as v2 states one: the record itself, and the models it
 *  serves — v2 lists models apart from the providers that offer them. */
function catalogProvider(id: string, name: string, url: string, models: Record<string, Partial<ModelInfo>> = {}) {
  const info: ProviderInfo = {
    id,
    name,
    activation: 'enabled',
    package: '@opencode/ai/providers/openai-compatible',
    settings: { baseURL: url },
  };
  const entries = Object.entries(models).map(
    ([mid, m]) => [`${id}/${mid}`, { id: mid, modelID: mid, providerID: id, name: mid, ...m } as ModelInfo] as const,
  );
  return { info, entries };
}

/** A catalog from `catalogProvider`s. */
function catalogOf(connected: string[], ...providers: Array<ReturnType<typeof catalogProvider>>): Catalog {
  return {
    providers: new Map(providers.map((p) => [p.info.id, p.info])),
    models: new Map(providers.flatMap((p) => p.entries)),
    connected: new Set(connected),
  };
}

const reasoningModel: Partial<ModelInfo> = {
  name: 'DeepSeek V4.1 Flash',
  family: 'deepseek',
  capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
  variants: [{ id: 'high', settings: { reasoningEffort: 'high' } }],
  cost: [{ input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } }],
  limit: { context: 1_000_000, output: 393_216 },
};

const catalog: Catalog = catalogOf(
  ['opencode', 'deepseek'],
  catalogProvider('deepseek', 'DeepSeek', 'https://api.deepseek.com', { 'deepseek-flash': reasoningModel }),
  catalogProvider('opencode-go', 'OpenCode Go', 'https://opencode.ai/zen/go/v1', { 'deepseek-v4.1-flash': reasoningModel }),
  catalogProvider('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', { 'deepseek/deepseek-chat': {} }),
  catalogProvider('opencode', 'OpenCode Zen', 'https://opencode.ai/zen/v1'),
);

const providerOf = (config: Record<string, unknown>, id: string) => (config.providers as Record<string, Record<string, unknown>>)[id]!;

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
    const ccr = catalogProvider('ccr', 'CCR', 'http://192.168.1.2:3458/v1', { m: {} });
    const running: Catalog = {
      providers: new Map([...catalog.providers, [ccr.info.id, ccr.info]]),
      models: new Map([...catalog.models, ...ccr.entries]),
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
    const config = providersConfig(placed, catalog, { providers: { mine: { package: 'x' } }, theme: 'dark' });
    expect(config).toEqual({
      theme: 'dark',
      providers: {
        mine: { package: 'x' },
        'home-router': {
          package: 'aisdk:@ai-sdk/openai-compatible',
          name: 'Home router',
          settings: { baseURL: 'http://192.168.1.2:3458/v1', apiKey: '{env:CODEDECK_PROVIDER_KEY_0}' },
          models: { 'Z.ai/glm-5': { name: 'GLM 5' }, 'kimi-k3': {} },
        },
      },
      // Every model can search: v2 gates web search behind a provider, and
      // this is the one that needs no key.
      websearch: { provider: 'tinyfish' },
    });
    expect(JSON.stringify(config)).not.toContain('tok-secret');
  });

  it("fills a gateway's routed model in from the catalog, its price riding along as a reference", () => {
    const routed = router({ label: 'CCR', models: [{ id: 'OpenCode Go/deepseek-v4.1-flash', provider: 'OpenCode Go' }] });
    const { placed } = placeProfiles([routed], catalog);
    expect(providerOf(providersConfig(placed, catalog), 'ccr').models).toEqual({
      'OpenCode Go/deepseek-v4.1-flash': {
        name: 'deepseek-v4.1-flash',
        family: 'deepseek',
        limit: { context: 1_000_000, output: 393_216 },
        capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
        variants: [{ id: 'high', settings: { reasoningEffort: 'high' } }],
        // The upstream list price, not what the gateway charges — a cost
        // shown from the catalog beats no cost at all.
        cost: [{ input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } }],
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
      settings: { apiKey: '{env:CODEDECK_PROVIDER_KEY_0}' },
      models: { 'new/model': { name: 'New' } },
    });
  });

  it('does not restrict the providers OpenCode already has', () => {
    const config = providersConfig(placeProfiles([router()], catalog).placed, catalog);
    // Nothing is written that would narrow what OpenCode offers, or move
    // the model it defaults to.
    expect(config).not.toHaveProperty('model');
    expect(config).not.toHaveProperty('default_agent');
    for (const provider of Object.values(config.providers as Record<string, Record<string, unknown>>)) {
      expect(provider).not.toHaveProperty('activation');
      expect(provider).not.toHaveProperty('disabled');
    }
  });
});

describe('serverSetup', () => {
  const placedOf = (...profiles: ProviderBinding[]) => placeProfiles(profiles, EMPTY_CATALOG).placed;

  it('passes the tokens in the environment and guards the server with a password of its own', () => {
    const a = serverSetup(placedOf(router(), router({ id: 'or', label: 'My OpenRouter', authToken: 'tok-2' })), EMPTY_CATALOG, {});
    expect(a.env.CODEDECK_PROVIDER_KEY_0).toBe('tok-secret');
    expect(a.env.CODEDECK_PROVIDER_KEY_1).toBe('tok-2');
    expect(JSON.parse(a.env.OPENCODE_CONFIG_CONTENT!).providers).toHaveProperty('my-openrouter');
    const password = a.env.OPENCODE_PASSWORD!;
    expect(password).toMatch(/^[0-9a-f]{48}$/);
    expect(a.headers.authorization).toBe(`Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`);
    expect(serverSetup([], EMPTY_CATALOG, {}).env.OPENCODE_PASSWORD).not.toBe(password);
    // V2 gates web search behind a connected provider and has no keyless
    // default of its own, so the keyless one is named in the config.
    expect(JSON.parse(serverSetup([], EMPTY_CATALOG, {}).env.OPENCODE_CONFIG_CONTENT!).websearch).toEqual({ provider: 'tinyfish' });
    // The pinned version stays.
    expect(serverSetup([], EMPTY_CATALOG, {}).env.OPENCODE_DISABLE_AUTOUPDATE).toBe('1');
    // No profiles: the operator's config is carried through as it is.
    expect(JSON.parse(serverSetup([], EMPTY_CATALOG, { OPENCODE_CONFIG_CONTENT: '{"theme":"x"}' }).env.OPENCODE_CONFIG_CONTENT!).theme).toBe('x');
  });

  it("keeps the operator's own environment config underneath", () => {
    const { env } = serverSetup(placedOf(router()), EMPTY_CATALOG, { OPENCODE_CONFIG_CONTENT: '{"providers":{"mine":{"package":"x"}}}' });
    expect(Object.keys(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).providers)).toEqual(['mine', 'home-router']);
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
        return {} as OpenCodeClient;
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
    // The config goes over whatever the profiles: the web-search default
    // rides on it, and there are no profiles in it yet.
    expect(Object.keys(JSON.parse(starts[0]!.env!.OPENCODE_CONFIG_CONTENT!).providers)).toEqual([]);
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
    expect(Object.keys(JSON.parse(starts[2]!.env!.OPENCODE_CONFIG_CONTENT!).providers)).toEqual([]);
    await driver.shutdown();
    expect(closed).toEqual([1, 2, 3]);
  });

  it('ends the sessions on the server it replaces, so the bridge resumes them on the new one', async () => {
    // Its event stream never opens: a session stays on the server it started on.
    const client = {
      // The stream opens and never yields: the session stays on the server
      // it started on until that server is replaced.
      event: {
        subscribe: () =>
          (async function* () {
            await new Promise(() => {});
          })(),
      },
      provider: { list: async () => { throw new Error('no catalog'); } },
      model: {
        list: async () => { throw new Error('no models'); },
        default: async () => { throw new Error('no default'); },
      },
      session: {
        get: async () => { throw new Error('that session is gone'); },
        create: async () => ({ id: 'ses_1' }),
      },
    } as unknown as OpenCodeClient;
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
        provider: { list: async () => ({ location: { directory: '/tmp' }, data: [] }) },
        model: {
          list: async () => ({
            location: { directory: '/tmp' },
            data: [
              { id: `m${n}`, modelID: `m${n}`, providerID: 'zen', name: `M${n}`, enabled: true, status: 'active', cost: [], variants: [], limit: { context: 1_000, output: 100 } },
            ],
          }),
          default: async () => ({ location: { directory: '/tmp' }, data: null }),
        },
      }) as unknown as OpenCodeClient;
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
      connect: () =>
        ({
          provider: {
            list: async () => ({
              location: { directory: '/tmp' },
              data: ids.map((id) => ({ id, name: id, activation: 'enabled', package: '@opencode/ai/providers/openai-compatible' })),
            }),
          },
          model: {
            list: async () => ({ location: { directory: '/tmp' }, data: [] }),
            default: async () => ({ location: { directory: '/tmp' }, data: null }),
          },
        }) as unknown as OpenCodeClient,
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
    const driver = await OpenCodeDriver.create({ serverUrl: 'http://127.0.0.1:4096', log: () => {}, connect: () => ({}) as OpenCodeClient });
    expect(driver.info().supports?.providerModels).toBe(false);
    await expect(driver.setProviders([router()])).rejects.toThrow(/does not start/);
  });

  it('checks and lists a profile as an OpenAI-compatible endpoint', async () => {
    const post = vi.fn().mockResolvedValue({ status: 401 });
    const get = vi.fn().mockResolvedValue({ status: 200, text: JSON.stringify({ data: [{ id: 'kimi-k3' }] }) });
    const driver = await OpenCodeDriver.create({ serverUrl: 'http://x', log: () => {}, providerHttp: { get, post }, connect: () => ({}) as OpenCodeClient });
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
