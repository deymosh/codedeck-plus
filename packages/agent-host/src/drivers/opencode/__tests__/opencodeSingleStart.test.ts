/**
 * One OpenCode server per bridge start: the catalog kept between starts
 * places the provider profiles before any server runs, and a running
 * server's catalog, less what the profiles added, agrees with it — so the
 * server the bridge resumes its sessions on is not replaced moments later.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo, OpenCodeClient, ProviderInfo } from '@opencode/client';
import { OpenCodeDriver } from '../driver';
import type { Catalog } from '../catalog';
import { readCatalogCache, writeCatalogCache } from '../catalogCache';
import { placeProfiles, providersFingerprint, servedBy, withoutProfiles } from '../providers';
import type { StartOpenCodeServerOptions } from '../server';
import type { ProviderBinding } from '../../../sdk/types';
import { recordingContext } from '../../../sdk/__tests__/context';

const router = (over: Partial<ProviderBinding> = {}): ProviderBinding => ({
  id: 'router',
  label: 'Home router',
  baseUrl: 'http://192.168.1.2:3458',
  authToken: 'tok-secret',
  models: [{ id: 'kimi-k3' }],
  ...over,
});

function catalogProvider(id: string, name: string, url: string, models: Record<string, Partial<ModelInfo>> = {}) {
  const info: ProviderInfo = { id, name, activation: 'enabled', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: url } };
  const entries = Object.entries(models).map(
    ([mid, m]) => [`${id}/${mid}`, { id: mid, modelID: mid, providerID: id, name: mid, ...m } as ModelInfo] as const,
  );
  return { info, entries };
}

function catalogOf(connected: string[], ...providers: Array<ReturnType<typeof catalogProvider>>): Catalog {
  return {
    providers: new Map(providers.map((p) => [p.info.id, p.info])),
    models: new Map(providers.flatMap((p) => p.entries)),
    connected: new Set(connected),
  };
}

const flash: Partial<ModelInfo> = {
  name: 'DeepSeek V4.1 Flash',
  family: 'deepseek',
  capabilities: { tools: true, input: ['text'], output: ['text'] },
  variants: [{ id: 'high', settings: { reasoningEffort: 'high' } }],
  cost: [{ input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } }],
  limit: { context: 1_000_000, output: 393_216 },
};
const chat: Partial<ModelInfo> = { capabilities: { tools: true, input: ['text'], output: ['text'] }, variants: [], cost: [], limit: { context: 64_000, output: 8_000 } };

const catalog = catalogOf(
  ['opencode', 'deepseek'],
  catalogProvider('deepseek', 'DeepSeek', 'https://api.deepseek.com'),
  catalogProvider('opencode-go', 'OpenCode Go', 'https://opencode.ai/zen/go/v1', { 'deepseek-v4.1-flash': flash }),
  catalogProvider('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', { 'deepseek/deepseek-chat': chat }),
  catalogProvider('opencode', 'OpenCode Zen', 'https://opencode.ai/zen/v1'),
);

/** One profile signing in to a provider OpenCode knows, with a model its
 *  catalog lacks; one of its own, with a routed model the catalog fills in. */
const profiles = (): ProviderBinding[] => [
  router({ id: 'or', label: 'My OR', baseUrl: 'https://openrouter.ai/api', models: [{ id: 'deepseek/deepseek-chat' }, { id: 'new/model' }] }),
  router({ label: 'CCR', authToken: 'tok-ccr', models: [{ id: 'OpenCode Go/deepseek-v4.1-flash', provider: 'OpenCode Go' }, { id: 'kimi-k3' }] }),
];

describe("a running server's catalog, less what the profiles added", () => {
  it('places the profiles where a server without them would', () => {
    const { placed } = placeProfiles(profiles(), catalog);
    const served = servedBy(placed, catalog);
    expect([...served.models]).toEqual(['openrouter/new/model']);
    // What the server started with them lists: their provider and its
    // models, the known provider's extra model, and that one as connected.
    const own = catalogProvider('ccr', 'CCR', 'http://192.168.1.2:3458/v1', { 'kimi-k3': {} });
    const extra = catalogProvider('openrouter', 'My OR', 'https://openrouter.ai/api/v1', { 'new/model': {} });
    const running: Catalog = {
      providers: new Map([...catalog.providers, [own.info.id, own.info]]),
      models: new Map([...catalog.models, ...own.entries, ...extra.entries]),
      connected: new Set([...catalog.connected, 'ccr', 'openrouter']),
    };
    const pristine = withoutProfiles(running, served);
    expect([...pristine.providers.keys()].sort()).toEqual([...catalog.providers.keys()].sort());
    expect([...pristine.models.keys()].sort()).toEqual([...catalog.models.keys()].sort());
    expect([...pristine.connected].sort()).toEqual([...catalog.connected].sort());
    // The same server, as far as its config goes: nothing to restart for.
    expect(providersFingerprint(placeProfiles(profiles(), pristine).placed, pristine)).toBe(providersFingerprint(placed, catalog));
  });

  it('tells a changed token or catalog record apart', () => {
    const { placed } = placeProfiles(profiles(), catalog);
    const fingerprint = providersFingerprint(placed, catalog);
    const rekeyed = profiles().map((p) => ({ ...p, authToken: `${p.authToken}-2` }));
    expect(providersFingerprint(placeProfiles(rekeyed, catalog).placed, catalog)).not.toBe(fingerprint);
    // A catalog that no longer knows the routed model fills nothing in.
    const without: Catalog = { ...catalog, models: new Map([...catalog.models].filter(([key]) => key !== 'opencode-go/deepseek-v4.1-flash')) };
    expect(providersFingerprint(placed, without)).not.toBe(fingerprint);
  });
});

describe('the kept catalog', () => {
  const file = () => path.join(mkdtempSync(path.join(tmpdir(), 'oc-catalog-')), 'catalog.json');

  it('places the profiles, and configures them, as the catalog it was kept from', () => {
    const at = file();
    const { placed } = placeProfiles(profiles(), catalog);
    writeCatalogCache(at, catalog, placed, () => {});
    const kept = readCatalogCache(at)!;
    const again = placeProfiles(profiles(), kept).placed;
    expect(again.map((p) => [p.providerId, p.known?.id])).toEqual([
      ['openrouter', 'openrouter'],
      ['ccr', undefined],
    ]);
    expect(providersFingerprint(again, kept)).toBe(providersFingerprint(placed, catalog));
    // Only the records the profiles were configured from.
    expect([...kept.models.keys()].sort()).toEqual(['opencode-go/deepseek-v4.1-flash', 'openrouter/deepseek/deepseek-chat']);
  });

  it('keeps no key, and no setting but the endpoint', () => {
    const at = file();
    const keyed = catalogProvider('mine', 'Mine', 'https://mine.example/v1');
    keyed.info.settings = { baseURL: 'https://mine.example/v1', apiKey: 'sk-operator' };
    writeCatalogCache(at, catalogOf([], keyed), [], () => {});
    expect(readFileSync(at, 'utf8')).not.toContain('sk-operator');
    expect(readCatalogCache(at)!.providers.get('mine')!.settings).toEqual({ baseURL: 'https://mine.example/v1' });
  });

  it('is no catalog when missing or malformed', () => {
    const at = file();
    expect(readCatalogCache(at)).toBeUndefined();
    for (const body of ['not json', '[]', '{"providers":[],"connected":[1],"models":[]}', '{"providers":[{"id":"x"}],"connected":[],"models":[]}']) {
      writeFileSync(at, body);
      expect(readCatalogCache(at)).toBeUndefined();
    }
  });
});

describe('an OpenCode driver with a kept catalog', () => {
  // A later start, whatever this machine's own OpenCode data holds.
  beforeEach(() => {
    const dataHome = mkdtempSync(path.join(tmpdir(), 'oc-data-'));
    mkdirSync(path.join(dataHome, 'opencode'));
    writeFileSync(path.join(dataHome, 'opencode', 'opencode.db'), '');
    vi.stubEnv('XDG_DATA_HOME', dataHome);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  type AddedProvider = { name?: string; settings?: { baseURL?: string }; models?: Record<string, unknown> };

  /** A server that lists `known` plus what the config it was started with
   *  adds, as a real one does. */
  function serverFor(known: Catalog, config: { providers?: Record<string, AddedProvider> }): OpenCodeClient {
    const providers = new Map<string, ProviderInfo>(
      [...known.providers].map(([id, p]) => [id, { ...p, activation: known.connected.has(id) ? 'enabled' : 'disabled' } as ProviderInfo]),
    );
    const listed = (m: Partial<ModelInfo>) => ({ enabled: true, status: 'active', cost: [], variants: [], limit: { context: 0, output: 0 }, ...m });
    const models = [...known.models.values()].map(listed);
    for (const [id, entry] of Object.entries(config.providers ?? {})) {
      const base = providers.get(id);
      providers.set(id, {
        id,
        name: entry.name ?? id,
        activation: 'enabled',
        package: '@opencode/ai/providers/openai-compatible',
        settings: { ...(base?.settings ?? {}), ...(entry.settings?.baseURL ? { baseURL: entry.settings.baseURL } : {}) },
      } as ProviderInfo);
      for (const modelID of Object.keys(entry.models ?? {})) models.push(listed({ id: modelID, modelID, providerID: id, name: modelID }));
    }
    return {
      // The stream opens and never yields: a session stays on its server.
      event: {
        subscribe: () =>
          (async function* () {
            await new Promise(() => {});
          })(),
      },
      provider: { list: async () => ({ location: { directory: '/tmp' }, data: [...providers.values()] }) },
      model: {
        list: async () => ({ location: { directory: '/tmp' }, data: models }),
        default: async () => ({ location: { directory: '/tmp' }, data: null }),
      },
      session: {
        get: async () => {
          throw new Error('that session is gone');
        },
        create: async () => ({ id: 'ses_1' }),
      },
    } as unknown as OpenCodeClient;
  }

  function managed(catalogCache: string, firstProvidersWaitMs?: number) {
    const starts: StartOpenCodeServerOptions[] = [];
    const driver = OpenCodeDriver.create({
      autoStart: true,
      // Any file stands in for the executable: the start is faked.
      binaryPath: process.execPath,
      log: () => {},
      catalogCache,
      ...(firstProvidersWaitMs !== undefined ? { firstProvidersWaitMs } : {}),
      modelsRefreshWaitMs: 0,
      startServer: async (options) => {
        starts.push(options);
        return { url: `http://127.0.0.1:${4100 + starts.length}`, pid: starts.length, exited: new Promise(() => {}), close: async () => {} };
      },
      connect: () => serverFor(catalog, JSON.parse(starts[starts.length - 1]!.env!.OPENCODE_CONFIG_CONTENT!)),
    });
    return { driver, starts };
  }

  const cacheFile = () => path.join(mkdtempSync(path.join(tmpdir(), 'oc-catalog-')), 'catalog.json');

  it('starts the server once, with the profiles, and keeps the session resumed on it', async () => {
    const file = cacheFile();
    // A bridge's first start: no catalog kept yet, so a server to ask and
    // then one with the profiles — and the catalog kept for the next.
    const first = managed(file);
    const before = await first.driver;
    await before.setProviders(profiles());
    expect(first.starts).toHaveLength(2);
    // Its own catalog, less the profiles, places them the same: no restart.
    await before.setProviders(profiles());
    expect(first.starts).toHaveLength(2);
    await before.shutdown();

    // The next start: a session the bridge resumes before it sends the
    // profiles waits for the one server, which starts with them.
    const next = managed(file);
    const driver = await next.driver;
    expect(next.starts).toHaveLength(0);
    const ctx = recordingContext();
    driver.startSession({ sessionId: 's1', agent: 'opencode', cwd: '/tmp', model: 'ccr/kimi-k3', resume: 'n1' }, ctx);
    expect(await driver.setProviders(profiles())).toEqual([]);
    expect(next.starts).toHaveLength(1);
    expect(next.starts[0]!.env?.CODEDECK_PROVIDER_KEY_1).toBe('tok-ccr');
    expect(next.starts[0]!.env!.OPENCODE_CONFIG_CONTENT).toBe(first.starts[1]!.env!.OPENCODE_CONFIG_CONTENT);
    expect(ctx.events.some((e) => e.type === 'ended')).toBe(false);
    await driver.shutdown();
  });

  it('restarts once when the server places the profiles differently', async () => {
    const file = cacheFile();
    // Kept from a catalog that did not know OpenRouter: that profile was a
    // provider of its own then.
    const stale: Catalog = { ...catalog, providers: new Map([...catalog.providers].filter(([id]) => id !== 'openrouter')) };
    writeCatalogCache(file, stale, placeProfiles(profiles(), stale).placed, () => {});
    const { driver: created, starts } = managed(file);
    const driver = await created;
    await driver.setProviders(profiles());
    expect(starts).toHaveLength(2);
    expect(Object.keys(JSON.parse(starts[0]!.env!.OPENCODE_CONFIG_CONTENT!).providers).sort()).toEqual(['ccr', 'my-or']);
    expect(Object.keys(JSON.parse(starts[1]!.env!.OPENCODE_CONFIG_CONTENT!).providers).sort()).toEqual(['ccr', 'openrouter']);
    await driver.setProviders(profiles());
    expect(starts).toHaveLength(2);
    await driver.shutdown();
  });

  it('starts without the profiles when none arrive', async () => {
    const file = cacheFile();
    writeCatalogCache(file, catalog, [], () => {});
    const { driver: created, starts } = managed(file, 10);
    const driver = await created;
    expect((await driver.listModels()).models.length).toBeGreaterThan(0);
    expect(starts).toHaveLength(1);
    await driver.shutdown();
  });

  it('starts nothing when shut down while waiting', async () => {
    const file = cacheFile();
    writeCatalogCache(file, catalog, [], () => {});
    // Written over, as every set-providers does.
    writeCatalogCache(file, catalog, [], () => {});
    const { driver: created, starts } = managed(file);
    const driver = await created;
    const session = driver.startSession({ sessionId: 's1', agent: 'opencode', cwd: '/tmp', resume: 'n1' }, recordingContext());
    // The host ends its sessions before it shuts the driver down: an end
    // must not wait for a server that is waiting for its profiles.
    const ended = await Promise.race([session.end().then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 1_000))]);
    expect(ended).toBe(true);
    await driver.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(starts).toHaveLength(0);
  });
});
