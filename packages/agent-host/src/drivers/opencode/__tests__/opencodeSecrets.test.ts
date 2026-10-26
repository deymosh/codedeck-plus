/**
 * OpenCode's secret-carrying paths, and the rule they all keep: a provider
 * token, an account key or a sign-in address never reaches the host's log
 * or the reply the bridge relays.
 *
 * The failures are the point. A spawned server that dies prints its
 * environment, the server that reads its config can quote it back in an
 * error, and the client's own refusal can repeat the key it was given — each
 * is a place a value would otherwise escape.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenCodeClient } from '@opencode/client';
import type { ProviderHttp } from '../../../sdk/net';
import type { ProviderBinding } from '../../../sdk/types';
import { TEST_SECRETS, expectNoSecretLeaks } from '../../../sdk/__tests__/secrets';
import { OpenCodeAccounts } from '../accounts';
import { OpenCodeDriver } from '../driver';
import type { OpenCodeServerHandle, StartOpenCodeServerOptions } from '../server';

const profile = (over: Partial<ProviderBinding> = {}): ProviderBinding => ({
  id: 'home',
  label: 'Home router',
  baseUrl: 'http://192.168.1.2:3458',
  authToken: TEST_SECRETS.providerToken,
  models: [{ id: 'kimi-k3' }],
  defaultModel: 'kimi-k3',
  ...over,
});

const handle = (port: number): OpenCodeServerHandle => ({
  url: `http://127.0.0.1:${port}`,
  pid: port,
  exited: new Promise(() => {}),
  close: async () => {},
});

/** The little of v2's client a server start and a catalog read touch. */
function catalogClient(over: Record<string, unknown> = {}): OpenCodeClient {
  return {
    event: {
      subscribe: () =>
        (async function* () {
          await new Promise(() => {});
        })(),
    },
    integration: { list: async () => ({ location: { directory: '/tmp' }, data: [] }) },
    provider: { list: async () => ({ location: { directory: '/tmp' }, data: [] }) },
    model: {
      list: async () => ({ location: { directory: '/tmp' }, data: [] }),
      default: async () => ({ location: { directory: '/tmp' }, data: null }),
    },
    config: { get: async () => [] },
    mcp: {
      list: async () => ({ location: { directory: '/tmp' }, data: [] }),
      add: async () => undefined,
    },
    plugin: { list: async () => ({ location: { directory: '/tmp' }, data: [] }) },
    ...over,
  } as unknown as OpenCodeClient;
}

/** A real first start, so a later one is not mistaken for it. */
let dataHome: string;
beforeEach(() => {
  dataHome = mkdtempSync(path.join(tmpdir(), 'oc-secrets-'));
  mkdirSync(path.join(dataHome, 'opencode'));
  writeFileSync(path.join(dataHome, 'opencode', 'opencode.db'), '');
  vi.stubEnv('XDG_DATA_HOME', dataHome);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function started(
  options: {
    starts?: StartOpenCodeServerOptions[];
    startServer?: (options: StartOpenCodeServerOptions) => Promise<OpenCodeServerHandle>;
    client?: OpenCodeClient;
    log?: (line: string) => void;
    providerHttp?: ProviderHttp;
  } = {},
): Promise<OpenCodeDriver> {
  return OpenCodeDriver.create({
    autoStart: true,
    binaryPath: process.execPath,
    log: options.log ?? (() => {}),
    catalogWaitMs: 0,
    modelsRefreshWaitMs: 0,
    startServer:
      options.startServer ??
      (async (startOptions) => {
        options.starts?.push(startOptions);
        return handle(4100 + (options.starts?.length ?? 0));
      }),
    connect: () => options.client ?? catalogClient(),
    ...(options.providerHttp ? { providerHttp: options.providerHttp } : {}),
  });
}

describe('OpenCode provider profiles', () => {
  it('does not log the token when a restarted server fails to start', async () => {
    const logs: string[] = [];
    const starts: StartOpenCodeServerOptions[] = [];
    let count = 0;
    const driver = await started({
      log: (line) => logs.push(line),
      startServer: async (options) => {
        starts.push(options);
        if (++count === 1) return handle(4100);
        // The child failed and its output quotes the environment it ran in.
        throw new Error(`opencode serve exited with code 1: CODEDECK_PROVIDER_KEY_0=${options.env?.CODEDECK_PROVIDER_KEY_0}`);
      },
    });

    const failure = await driver.setProviders([profile()]).then(
      () => undefined,
      (error: Error) => error,
    );
    expect(failure?.message).toMatch(/server failed to start/);
    // The path was driven: the token was in the child's environment.
    expect(starts.at(-1)?.env?.CODEDECK_PROVIDER_KEY_0).toBe(TEST_SECRETS.providerToken);
    expectNoSecretLeaks({ logs, frames: [failure?.message ?? ''] });
    await driver.shutdown();
  });

  it('does not log the token when the server cannot report its catalog', async () => {
    const logs: string[] = [];
    const client = catalogClient({
      provider: {
        list: async () => {
          // The server reads its config back to callers, tokens included.
          throw new Error(`could not read the config: ${TEST_SECRETS.providerToken}`);
        },
      },
    });
    const driver = await started({ log: (line) => logs.push(line), client });
    await driver.setProviders([profile()]);
    expectNoSecretLeaks({ logs });
    await driver.shutdown();
  });

  it('checks and lists a profile without echoing its token on failure', async () => {
    const deny = async () => {
      throw new Error(`HTTP 500 — authorization: Bearer ${TEST_SECRETS.providerToken}`);
    };
    const driver = await started({ providerHttp: { get: deny, post: deny } });
    expect(await driver.checkProvider(profile(), 'kimi-k3')).toBeUndefined();
    const failure = await driver.listProviderModels('http://192.168.1.2:3458', TEST_SECRETS.providerToken).then(
      () => undefined,
      (error: Error) => error,
    );
    expect(failure?.message).toMatch(/192\.168\.1\.2/);
    expectNoSecretLeaks({ frames: [failure?.message ?? ''] });
    await driver.shutdown();
  });
});

describe('OpenCode accounts', () => {
  const openai = {
    id: 'openai',
    name: 'OpenAI',
    methods: [
      { type: 'key' },
      { id: 'chatgpt', type: 'oauth', label: 'Sign in with ChatGPT' },
    ],
    connections: [],
  };

  it('reports a refused key without the key', async () => {
    const logs: string[] = [];
    const client = {
      integration: {
        list: async () => ({ data: [openai] }),
        connect: {
          key: async () => {
            throw new Error(`the provider refused the key ${TEST_SECRETS.apiKey}`);
          },
        },
      },
      credential: { list: async () => [] },
    } as unknown as OpenCodeClient;
    const accounts = new OpenCodeAccounts(async () => client, { log: (line) => logs.push(line) });
    const failure = await accounts
      .change('openai', { kind: 'key', method: 'key', key: TEST_SECRETS.apiKey }, () => {})
      .then(
        () => undefined,
        (error: Error) => error,
      );
    expect(failure?.message).toMatch(/refused the key/);
    expectNoSecretLeaks({ logs, frames: [failure?.message ?? ''] });
  });

  it('reports a failed paste-back sign-in without the address it was given', async () => {
    const callback = 'http://127.0.0.1:45493/auth/callback';
    const client = {
      integration: {
        list: async () => ({ data: [{ ...openai, methods: [openai.methods[0], { id: 'chatgpt', type: 'oauth', label: 'ChatGPT' }] }] }),
        oauth: {
          connect: async () => ({
            data: {
              attemptID: 'a1',
              url: `https://auth.openai.com/authorize?redirect_uri=${encodeURIComponent(callback)}&state=s`,
              instructions: 'Sign in in the browser',
              mode: 'auto',
              time: { created: 0, expires: 10_000 },
            },
          }),
        },
      },
      credential: { list: async () => [] },
    } as unknown as OpenCodeClient;
    const logs: string[] = [];
    const accounts = new OpenCodeAccounts(async () => client, {
      log: (line) => logs.push(line),
      pollMs: 60_000,
      // The machine cannot open the address; the failure repeats it.
      open: async (url) => {
        throw new Error(`the machine could not open ${url}`);
      },
    });
    await accounts.change('openai', { kind: 'sign-in', method: 'chatgpt' }, () => {});
    const pasted = `${callback}?code=${TEST_SECRETS.sessionCode}&state=s`;
    const failure = await accounts
      .change('openai', { kind: 'finish', attempt: 'a1', callbackUrl: pasted }, () => {})
      .then(
        () => undefined,
        (error: Error) => error,
      );
    expect(failure?.message).toMatch(/could not open/);
    expectNoSecretLeaks({ logs, frames: [failure?.message ?? ''] });
    accounts.close();
  });
});

describe('OpenCode MCP servers', () => {
  it('reports a refused server without the secret in its setup', async () => {
    const logs: string[] = [];
    const client = catalogClient({
      mcp: {
        list: async () => ({ location: { directory: '/tmp' }, data: [] }),
        add: async ({ config }: { config: unknown }) => {
          // The server's refusal quotes the config it was handed.
          throw new Error(`invalid config: ${JSON.stringify(config)}`);
        },
      },
    });
    const driver = await started({ log: (line) => logs.push(line), client });
    const failure = await driver.mcp
      .act(
        'add',
        [
          {
            name: 'gh',
            setup: {
              type: 'http',
              url: 'https://x/mcp',
              headers: { Authorization: `Bearer ${TEST_SECRETS.githubPat}` },
            },
          },
        ],
        [],
      )
      .then(
        () => undefined,
        (error: Error) => error,
      );
    expect(failure?.message).toMatch(/could not add gh/);
    expectNoSecretLeaks({ logs, frames: [failure?.message ?? ''] });
    await driver.shutdown();
  });
});

describe('OpenCode plugin configuration', () => {
  it('does not list or log an option that carries a key', async () => {
    const configHome = mkdtempSync(path.join(tmpdir(), 'oc-config-'));
    mkdirSync(path.join(configHome, 'opencode'));
    writeFileSync(
      path.join(configHome, 'opencode', 'opencode.json'),
      JSON.stringify({ plugins: [{ package: 'x-plugin', options: { apiKey: TEST_SECRETS.apiKey } }] }),
    );
    vi.stubEnv('XDG_CONFIG_HOME', configHome);
    const logs: string[] = [];
    const client = catalogClient({
      plugin: { list: async () => ({ location: { directory: '/tmp' }, data: [{ id: 'x-plugin', state: { status: 'ok' } }] }) },
    });
    const driver = await started({ log: (line) => logs.push(line), client });
    const state = await driver.plugins.list(false);
    expect(state.installed.map((plugin) => plugin.id)).toEqual(['x-plugin']);
    expectNoSecretLeaks({ logs, frames: [state] });
    await driver.shutdown();
  });
});
