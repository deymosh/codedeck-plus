/**
 * OpenCode's catalog as a 2.x server gives it: the providers it can use
 * listed, every other one described only when asked for, nothing at all
 * until it has registered them — and the models of providers it cannot use
 * read from models.dev.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo, OpenCodeClient, ProviderInfo } from '@opencode/client';
import { OpenCodeDriver } from '../driver';
import { readCatalogCache } from '../catalogCache';
import { modelsDevSource, parseModelsDev } from '../modelsDev';
import type { StartOpenCodeServerOptions } from '../server';
import type { ProviderBinding } from '../../../sdk/types';

/** A slice of models.dev's list, as it spells its records. */
const MODELS_DEV = {
  'opencode-go': {
    id: 'opencode-go',
    name: 'OpenCode Go',
    api: 'https://opencode.ai/inference/go/openai/v1',
    models: {
      'deepseek-v4.1-flash': {
        id: 'deepseek-v4.1-flash',
        name: 'DeepSeek V4.1 Flash',
        family: 'deepseek',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high', null] }, { type: 'toggle' }],
        tool_call: true,
        temperature: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
        limit: { context: 1_000_000, output: 393_216 },
      },
      // Missing what a config needs: left out.
      broken: { id: 'broken', name: 'Broken' },
    },
  },
  openrouter: { id: 'openrouter', name: 'OpenRouter', models: { 'plain/chat': { id: 'plain/chat', name: 'Chat', reasoning: false, tool_call: false, limit: { context: 8_000, output: 1_000 } } } },
};

describe('models.dev', () => {
  it('reads each model as the config states it, how it reasons included', () => {
    const models = parseModelsDev(JSON.stringify(MODELS_DEV));
    expect([...models.keys()].sort()).toEqual(['opencode-go/deepseek-v4.1-flash', 'openrouter/plain/chat']);
    expect(models.get('opencode-go/deepseek-v4.1-flash')).toEqual({
      providerID: 'opencode-go',
      modelID: 'deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash',
      family: 'deepseek',
      capabilities: { tools: true, input: ['text', 'image'], output: ['text'], temperature: true },
      reasoning: { supported: true, toggle: true, effort: ['low', 'high'] },
      cost: [{ input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } }],
      limit: { context: 1_000_000, output: 393_216 },
    });
    expect(models.get('openrouter/plain/chat')?.reasoning).toEqual({ supported: false });
  });

  it('is an empty list for anything else', () => {
    for (const text of ['', 'not json', '[]', '{"x":1}', '{"p":{"id":"p","models":[1]}}']) expect(parseModelsDev(text).size).toBe(0);
  });

  it("is read from where OpenCode reads it, or not at all when OpenCode is told not to", () => {
    expect(modelsDevSource({})).toBe('https://models.opencode.ai/api.json');
    expect(modelsDevSource({ OPENCODE_MODELS_URL: 'http://mirror.lan/' })).toBe('http://mirror.lan/api.json');
    expect(modelsDevSource({ OPENCODE_DISABLE_MODELS_FETCH: '1' })).toBeUndefined();
    expect(modelsDevSource({ OPENCODE_DISABLE_MODELS_FETCH: 'false' })).toBeDefined();
  });
});

describe('an OpenCode driver reading its 2.x server', () => {
  beforeEach(() => {
    const dataHome = mkdtempSync(path.join(tmpdir(), 'oc-data-'));
    mkdirSync(path.join(dataHome, 'opencode'));
    writeFileSync(path.join(dataHome, 'opencode', 'opencode.db'), '');
    vi.stubEnv('XDG_DATA_HOME', dataHome);
    vi.stubEnv('OPENCODE_DISABLE_MODELS_FETCH', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const provider = (id: string, name: string, baseURL: string, activation: ProviderInfo['activation'] = 'auto'): ProviderInfo =>
    ({ id, name, activation, package: '@opencode/ai/providers/openai-compatible', settings: { baseURL } }) as ProviderInfo;
  /** What the server knows: OpenCode Zen, which it can use, and two it cannot. */
  const KNOWN = [
    provider('opencode', 'OpenCode', 'https://opencode.ai/inference/openai/v1', 'enabled'),
    provider('opencode-go', 'OpenCode Go', 'https://opencode.ai/inference/go/openai/v1'),
    provider('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1'),
  ];

  /** A server that registers its providers after `quietPolls` asks, lists
   *  the ones it can use and those its config adds, and describes the rest
   *  only when asked for one. */
  function serverFor(config: { providers?: Record<string, { name?: string; settings?: { baseURL?: string } }> }, quietPolls = 0) {
    let polls = 0;
    const added = Object.entries(config.providers ?? {}).map(([id, p]) => provider(id, p.name ?? id, p.settings?.baseURL ?? '', 'enabled'));
    const all = new Map([...KNOWN, ...added].map((p) => [p.id, p]));
    const usable = () => (polls++ < quietPolls ? [] : [...all.values()].filter((p) => p.activation === 'enabled'));
    const at = { location: { directory: '/tmp' } };
    return {
      integration: { list: async () => ({ ...at, data: [...KNOWN.map((p) => p.id), 'tinyfish'].map((id) => ({ id, name: id, methods: [], connections: [] })) }) },
      provider: {
        list: async () => ({ ...at, data: usable() }),
        get: async ({ providerID }: { providerID: string }) => {
          const found = all.get(providerID);
          if (!found) throw Object.assign(new Error('Provider not found'), { name: 'ProviderNotFoundError' });
          return { ...at, data: found };
        },
      },
      model: {
        list: async () => ({
          ...at,
          data: usable().length === 0 ? [] : [{ providerID: 'opencode', modelID: 'zen-free', name: 'Zen', enabled: true, status: 'active', capabilities: { tools: true, input: ['text'], output: ['text'] }, variants: [], cost: [], limit: { context: 1, output: 1 } }] as unknown as ModelInfo[],
        }),
        default: async () => ({ ...at, data: null }),
      },
    } as unknown as OpenCodeClient;
  }

  function managed(options: { catalogCache?: string; quietPolls?: number; get?: ReturnType<typeof vi.fn> } = {}) {
    const starts: StartOpenCodeServerOptions[] = [];
    const get = options.get ?? vi.fn(async () => ({ status: 200, text: JSON.stringify(MODELS_DEV) }));
    const driver = OpenCodeDriver.create({
      autoStart: true,
      binaryPath: process.execPath,
      log: () => {},
      modelsRefreshWaitMs: 0,
      ...(options.catalogCache ? { catalogCache: options.catalogCache } : {}),
      providerHttp: { get, post: vi.fn() },
      startServer: async (o) => {
        starts.push(o);
        return { url: `http://127.0.0.1:${4100 + starts.length}`, pid: starts.length, exited: new Promise(() => {}), close: async () => {} };
      },
      connect: () => serverFor(JSON.parse(starts[starts.length - 1]!.env!.OPENCODE_CONFIG_CONTENT!), options.quietPolls),
    });
    return { driver, starts, get };
  }

  const configOf = (start: StartOpenCodeServerOptions) =>
    JSON.parse(start.env!.OPENCODE_CONFIG_CONTENT!) as { providers: Record<string, { models?: Record<string, Record<string, unknown>> }> };

  it('signs a profile in to a provider the server knows but cannot use yet', async () => {
    const { driver: created, starts } = managed();
    const driver = await created;
    const openrouter: ProviderBinding = { id: 'or', label: 'My OR', baseUrl: 'https://openrouter.ai/api', authToken: 'tok', models: [{ id: 'plain/chat' }] };
    expect(await driver.setProviders([openrouter])).toEqual([]);
    expect(Object.keys(configOf(starts[1]!).providers)).toEqual(['openrouter']);
    await driver.shutdown();
  });

  it('waits for the server to register its providers before reading them', async () => {
    const { driver: created, starts } = managed({ quietPolls: 3 });
    const driver = await created;
    const openrouter: ProviderBinding = { id: 'or', label: 'My OR', baseUrl: 'https://openrouter.ai/api', authToken: 'tok', models: [{ id: 'plain/chat' }] };
    await driver.setProviders([openrouter]);
    expect(Object.keys(configOf(starts[1]!).providers)).toEqual(['openrouter']);
    await driver.shutdown();
  });

  it("fills a gateway's model in from models.dev once, and keeps it for the next start", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'oc-catalog-')), 'catalog.json');
    const ccr: ProviderBinding = {
      id: 'ccr',
      label: 'CCR',
      baseUrl: 'http://192.168.1.2:3458',
      authToken: 'tok',
      models: [{ id: 'OpenCode Go/deepseek-v4.1-flash', provider: 'OpenCode Go' }],
    };
    const first = managed({ catalogCache: file });
    const before = await first.driver;
    await before.setProviders([ccr]);
    expect(first.get).toHaveBeenCalledTimes(1);
    expect(first.get.mock.calls[0]![0]).toBe('https://models.opencode.ai/api.json');
    const model = configOf(first.starts[1]!).providers.ccr!.models!['OpenCode Go/deepseek-v4.1-flash']!;
    expect(model.capabilities).toEqual({
      tools: true,
      input: ['text', 'image'],
      output: ['text'],
      temperature: true,
      reasoning: { supported: true, toggle: true, effort: ['low', 'high'] },
    });
    expect(model.limit).toEqual({ context: 1_000_000, output: 393_216 });
    // The same list again: no second fetch, and no restart.
    await before.setProviders([ccr]);
    expect(first.get).toHaveBeenCalledTimes(1);
    expect(first.starts).toHaveLength(2);
    await before.shutdown();
    expect(readCatalogCache(file)?.models.has('opencode-go/deepseek-v4.1-flash')).toBe(true);

    // The next start: one server, the record kept, nothing fetched.
    const next = managed({ catalogCache: file });
    const driver = await next.driver;
    await driver.setProviders([ccr]);
    expect(next.starts).toHaveLength(1);
    expect(next.get).not.toHaveBeenCalled();
    expect(next.starts[0]!.env!.OPENCODE_CONFIG_CONTENT).toBe(first.starts[1]!.env!.OPENCODE_CONFIG_CONTENT);
    await driver.shutdown();
  });

  it('places the profiles all the same when models.dev cannot be had', async () => {
    const get = vi.fn(async () => {
      throw new Error('offline');
    });
    const { driver: created, starts } = managed({ get });
    const driver = await created;
    const ccr: ProviderBinding = { id: 'ccr', label: 'CCR', baseUrl: 'http://192.168.1.2:3458', authToken: 'tok', models: [{ id: 'kimi-k3' }] };
    expect(await driver.setProviders([ccr])).toEqual([]);
    expect(configOf(starts[1]!).providers.ccr!.models).toEqual({ 'kimi-k3': {} });
    await driver.shutdown();
  });
});
