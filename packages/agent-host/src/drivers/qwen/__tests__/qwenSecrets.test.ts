/**
 * Qwen Code's secret-carrying paths: the provider token its settings refer
 * to and its process environment carries, and the provider API a profile is
 * checked on.
 *
 * The token is deliberately absent from `settings.json` (the file anything
 * on the machine can read); it exists only in the session's environment.
 * These tests drive that path and assert neither the log nor a session event
 * ever repeats it.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeAgent } from '../../../acp/__tests__/fakeAgent';
import { recordingContext } from '../../../sdk/__tests__/context';
import { TEST_SECRETS, expectNoSecretLeaks } from '../../../sdk/__tests__/secrets';
import type { ProviderHttp } from '../../../sdk/net';
import type { ProviderBinding } from '../../../sdk/types';
import { QwenDriver } from '../driver';
import { QwenRuntime } from '../runtime';
import { qwenKeyEnvName } from '../settings';

const profile = (over: Partial<ProviderBinding> = {}): ProviderBinding => ({
  id: 'home',
  label: 'Home router',
  baseUrl: 'https://gw.example',
  authToken: TEST_SECRETS.providerToken,
  models: [{ id: 'qwen3-coder', label: 'Qwen3 Coder' }],
  defaultModel: 'qwen3-coder',
  ...over,
});

/** The option state a Qwen Code session starts with. */
const configOptions = (): unknown[] => [
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'auto',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'auto', name: 'Auto' },
    ],
  },
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'qwen3-coder(openai)',
    options: [{ value: 'qwen3-coder(openai)', name: 'Qwen3 Coder' }],
  },
];

const modeState = (): unknown => ({
  currentModeId: 'auto',
  availableModes: [
    { id: 'default', name: 'Default' },
    { id: 'auto', name: 'Auto' },
  ],
});

function withDriver(providerHttp?: ProviderHttp) {
  const home = mkdtempSync(path.join(tmpdir(), 'qwen-secrets-'));
  const agent = new FakeAgent('qwen');
  agent.options = configOptions();
  agent.modes = modeState();
  const spawns: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
  const logs: string[] = [];
  const log = (line: string): void => {
    logs.push(line);
  };
  const runtime = new QwenRuntime({
    home,
    cacheDir: path.join(home, 'agents'),
    installQwen: async () => '/fake/qwen/cli-entry.js',
    spawnFn: ((command: string, args: string[], spawnOptions: { env: Record<string, string> }) => {
      spawns.push({ command, args, env: spawnOptions.env });
      return agent.child;
    }) as never,
    idleCloseMs: 0,
    log,
  });
  const driver = QwenDriver.create({
    runtime,
    home,
    baseEnv: {},
    log,
    ...(providerHttp ? { providerHttp } : {}),
  });
  return { driver, agent, home, spawns, logs };
}

describe('Qwen provider settings', () => {
  it('writes the profiles without the token, and logs none of it', async () => {
    const ready = withDriver();
    expect(await ready.driver.setProviders([profile()])).toEqual([]);
    const settings = readFileSync(path.join(ready.home, 'settings.json'), 'utf8');
    expect(settings).not.toContain(TEST_SECRETS.providerToken);
    expectNoSecretLeaks({ logs: ready.logs, frames: [settings] });
    void ready.driver.shutdown();
  });

  it('checks and lists a profile without echoing its token on failure', async () => {
    const deny = async () => {
      throw new Error(`HTTP 500 — authorization: Bearer ${TEST_SECRETS.providerToken}`);
    };
    const ready = withDriver({ get: deny, post: deny });
    expect(await ready.driver.checkProvider(profile(), 'qwen3-coder')).toBeUndefined();
    const failure = await ready.driver.listProviderModels('https://gw.example', TEST_SECRETS.providerToken).then(
      () => undefined,
      (error: Error) => error,
    );
    expect(failure?.message).toMatch(/gw\.example/);
    expectNoSecretLeaks({ logs: ready.logs, frames: [failure?.message ?? ''] });
    void ready.driver.shutdown();
  });
});

describe('Qwen session environment', () => {
  it('hands the profile token to the process without logging or reporting it', async () => {
    const ready = withDriver();
    await ready.driver.setProviders([profile()]);
    const ctx = recordingContext();
    ready.driver.startSession(
      {
        sessionId: 's1',
        agent: 'qwen-code',
        cwd: '/w',
        env: { GITHUB_TOKEN: TEST_SECRETS.githubPat },
      },
      ctx,
    );
    await ctx.waitFor((event) => event.type === 'ready');

    // The path was driven: the token reached the process under the name the
    // settings entry refers to, beside the bridge-level credential.
    const keyName = qwenKeyEnvName('home', 'https://gw.example/v1');
    expect(ready.spawns[0]?.env[keyName]).toBe(TEST_SECRETS.providerToken);
    expect(ready.spawns[0]?.env.GITHUB_TOKEN).toBe(TEST_SECRETS.githubPat);
    expectNoSecretLeaks({ logs: [...ctx.logs, ...ready.logs], events: ctx.events });
    void ready.driver.shutdown();
  });
});
