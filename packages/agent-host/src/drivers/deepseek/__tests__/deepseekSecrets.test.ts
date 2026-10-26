/**
 * The DeepSeek Harness's secret-carrying paths: the key its endpoint is
 * read with, the environment a session's process carries, and an MCP server
 * whose setup holds a token.
 *
 * The catalog read at start is the interesting failure: it is best-effort,
 * logged, and its HTTP error can quote the header the key travelled in.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FakeAgent } from '../../../acp/__tests__/fakeAgent';
import { recordingContext } from '../../../sdk/__tests__/context';
import { TEST_SECRETS, expectNoSecretLeaks } from '../../../sdk/__tests__/secrets';
import type { HttpGet, ProviderHttp } from '../../../sdk/net';
import type { ProviderBinding } from '../../../sdk/types';
import { DeepSeekDriver } from '../driver';
import { DeepSeekRuntime } from '../runtime';

const profile = (over: Partial<ProviderBinding> = {}): ProviderBinding => ({
  id: 'home',
  label: 'Home router',
  baseUrl: 'https://gw.example',
  authToken: TEST_SECRETS.providerToken,
  models: [{ id: 'm' }],
  defaultModel: 'm',
  ...over,
});

function harnessHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-secrets-'));
  mkdirSync(path.join(home, 'profiles', 'acp'), { recursive: true });
  writeFileSync(path.join(home, 'profiles', 'acp', 'cordis.patch.yml'), '# the profile layer\n[]\n');
  return home;
}

/** The option state a harness session starts with. */
const configOptions = (): unknown[] => [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: '["deepseek-official","deepseek-v4-flash"]',
    options: [{ value: '["deepseek-official","deepseek-v4-flash"]', name: 'deepseek-v4-flash' }],
  },
];

function withDriver(
  options: { env?: NodeJS.ProcessEnv; httpGet?: HttpGet; providerHttp?: ProviderHttp; log?: (line: string) => void } = {},
) {
  const home = harnessHome();
  const agent = new FakeAgent('deepseek');
  agent.options = configOptions();
  const spawns: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
  const logs: string[] = [];
  const log = (line: string): void => {
    logs.push(line);
  };
  const runtime = new DeepSeekRuntime({
    home,
    cacheDir: path.join(home, 'agents'),
    installDsh: async () => '/fake/dsh/lib/bin.js',
    spawnFn: ((command: string, args: string[], spawnOptions: { env: Record<string, string> }) => {
      spawns.push({ command, args, env: spawnOptions.env });
      return agent.child;
    }) as never,
    idleCloseMs: 0,
    log: options.log ?? log,
  });
  const driver = DeepSeekDriver.create({
    runtime,
    home,
    baseEnv: options.env ?? {},
    log: options.log ?? log,
    ...(options.httpGet ? { httpGet: options.httpGet } : {}),
    ...(options.providerHttp ? { providerHttp: options.providerHttp } : {}),
  });
  return { driver, agent, home, spawns, logs };
}

describe('DeepSeek endpoint catalog', () => {
  it('does not log the key when the endpoint cannot list its models', async () => {
    const ready = withDriver({
      env: { DEEPSEEK_BASE_URL: 'https://relay.example', DEEPSEEK_API_KEY: TEST_SECRETS.apiKey },
      httpGet: async () => {
        throw new Error(`request failed: authorization=Bearer ${TEST_SECRETS.apiKey}`);
      },
    });
    await vi.waitFor(() => expect(ready.logs.some((line) => line.includes('no model list'))).toBe(true));
    expectNoSecretLeaks({ logs: ready.logs });
  });
});

describe('DeepSeek provider profiles', () => {
  it('checks and lists a profile without echoing its token on failure', async () => {
    const deny = async () => {
      throw new Error(`HTTP 500 — authorization: Bearer ${TEST_SECRETS.providerToken}`);
    };
    const ready = withDriver({ providerHttp: { get: deny, post: deny } });
    expect(await ready.driver.checkProvider(profile(), 'm')).toBeUndefined();
    const failure = await ready.driver.listProviderModels('https://gw.example', TEST_SECRETS.providerToken).then(
      () => undefined,
      (error: Error) => error,
    );
    expect(failure?.message).toMatch(/gw\.example/);
    expectNoSecretLeaks({ logs: ready.logs, frames: [failure?.message ?? ''] });
  });
});

describe('DeepSeek session environment', () => {
  it('hands the credentials to the harness without logging or reporting them', async () => {
    const ready = withDriver();
    const ctx = recordingContext();
    ready.driver.startSession(
      {
        sessionId: 's1',
        agent: 'deepseek-harness',
        cwd: '/w',
        provider: profile(),
        env: { GITHUB_TOKEN: TEST_SECRETS.githubPat },
      },
      ctx,
    );
    await ctx.waitFor((event) => event.type === 'ready');

    // The path was driven: the process carried both secrets.
    expect(ready.spawns[0]?.env.DEEPSEEK_API_KEY).toBe(TEST_SECRETS.providerToken);
    expect(ready.spawns[0]?.env.GITHUB_TOKEN).toBe(TEST_SECRETS.githubPat);
    expectNoSecretLeaks({ logs: ctx.logs, events: ctx.events });
  });
});

describe('DeepSeek MCP servers', () => {
  it('stores a server whose env holds a token without logging or reporting it', async () => {
    const ready = withDriver();
    const state = await ready.driver.mcp.act(
      'add',
      [
        {
          name: 'gh',
          setup: { type: 'stdio', command: 'npx', args: ['gh-mcp'], env: { GITHUB_TOKEN: TEST_SECRETS.githubPat } },
        },
      ],
      [],
    );
    expect(state.servers).toEqual([{ name: 'gh', transport: 'stdio', target: 'npx', envKeys: ['GITHUB_TOKEN'], enabled: true }]);
    expectNoSecretLeaks({ logs: ready.logs, frames: [state] });
  });
});
