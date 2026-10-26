/**
 * Claude Code's secret-carrying paths: a provider token on the API, the
 * credentials a session's environment carries, and an MCP server whose setup
 * holds a token.
 *
 * The SDK and the `claude` CLI are seams here. A failure at either is
 * exactly where a credential escapes: SDK errors carry the CLI's stderr tail,
 * and a CLI refusal can quote the JSON it was given.
 */
import { describe, expect, it } from 'vitest';
import type { ProviderHttp } from '../../../sdk/net';
import type { ProviderBinding, StartSession } from '../../../sdk/types';
import { TEST_SECRETS, expectNoSecretLeaks } from '../../../sdk/__tests__/secrets';
import { recordingContext } from '../../../sdk/__tests__/context';
import type { SdkFacade, SdkSessionHandle, SdkSessionOptions } from '../facade';
import { ClaudeDriver } from '../driver';
import type { CliResult } from '../plugins';

const profile = (over: Partial<ProviderBinding> = {}): ProviderBinding => ({
  id: 'home',
  label: 'Home router',
  baseUrl: 'https://gw.example',
  authToken: TEST_SECRETS.providerToken,
  models: [{ id: 'm' }],
  defaultModel: 'm',
  ...over,
});

/** A facade that answers the control probe and then keeps its stream open. */
function fakeFacade(probe: Promise<void> = Promise.resolve()): {
  facade: SdkFacade;
  sessions: SdkSessionOptions[];
} {
  const sessions: SdkSessionOptions[] = [];
  const handle = {
    probeReady: () => probe,
    messages: () =>
      (async function* () {
        await new Promise(() => {});
      })(),
    pushInput: () => {},
    setPermissionMode: async () => {},
    setModel: async () => {},
    setEffort: async () => {},
    interrupt: async () => {},
    stopTask: async () => {},
    getContextUsage: async () => null,
    supportedCommands: async () => null,
    mcpServerStatus: async () => null,
    toggleMcpServer: async () => {},
    reloadPlugins: async () => {},
    getUsageSnapshot: async () => null,
    end: async () => {},
  } as unknown as SdkSessionHandle;
  const facade = {
    createSession: (options: SdkSessionOptions) => {
      sessions.push(options);
      return handle;
    },
    supportedModels: async () => [],
    deleteSession: async () => {},
  } as unknown as SdkFacade;
  return { facade, sessions };
}

describe('Claude provider profiles', () => {
  it('checks and lists a profile without echoing its token on failure', async () => {
    const deny = async () => {
      throw new Error(`HTTP 500 — x-api-key: ${TEST_SECRETS.providerToken}`);
    };
    const providerHttp: ProviderHttp = { get: deny, post: deny };
    const driver = new ClaudeDriver({ facade: fakeFacade().facade, providerHttp });
    expect(await driver.checkProvider(profile(), 'm')).toBeUndefined();
    const failure = await driver.listProviderModels('https://gw.example', TEST_SECRETS.providerToken).then(
      () => undefined,
      (error: Error) => error,
    );
    expect(failure?.message).toMatch(/gw\.example/);
    expectNoSecretLeaks({ frames: [failure?.message ?? ''] });
  });
});

describe('Claude session environment', () => {
  it('hands the credentials to the session without logging or reporting them', async () => {
    const { facade, sessions } = fakeFacade();
    const ctx = recordingContext();
    const params: StartSession = {
      sessionId: 's1',
      agent: 'claude-code',
      cwd: '/w',
      provider: profile(),
      env: { GITHUB_TOKEN: TEST_SECRETS.githubPat },
    };
    new ClaudeDriver({ facade }).startSession(params, ctx);
    await ctx.waitFor((event) => event.type === 'ready');

    // The path was driven: the environment carried both secrets.
    expect(sessions[0]?.env?.ANTHROPIC_AUTH_TOKEN).toBe(TEST_SECRETS.providerToken);
    expect(sessions[0]?.env?.GITHUB_TOKEN).toBe(TEST_SECRETS.githubPat);
    expectNoSecretLeaks({ logs: ctx.logs, events: ctx.events });
  });

  it('does not repeat a spawn failure that quotes the environment', async () => {
    // The SDK's error carries the CLI's stderr tail; a CLI that printed its
    // environment would have the token in it.
    const { facade } = fakeFacade(
      Promise.reject(new Error(`spawn failed: ANTHROPIC_AUTH_TOKEN=${TEST_SECRETS.providerToken}`)),
    );
    const ctx = recordingContext();
    new ClaudeDriver({ facade }).startSession(
      { sessionId: 's1', agent: 'claude-code', cwd: '/w', provider: profile() },
      ctx,
    );
    const ended = await ctx.ended();
    expect(ended.error).toMatch(/did not respond/);
    expectNoSecretLeaks({ logs: ctx.logs, events: ctx.events });
  });
});

describe('Claude MCP servers', () => {
  it('reports a refused server without the secret in its setup', async () => {
    const runCli = async (args: string[]): Promise<CliResult> =>
      args[1] === 'remove'
        ? { code: 0, stdout: '', stderr: '' }
        : // The CLI's refusal quotes the server JSON it was handed.
          { code: 1, stdout: '', stderr: `Error: invalid config: ${args.at(-1)}` };
    const driver = new ClaudeDriver({ facade: fakeFacade().facade, manageMcp: true, runCli });
    const failure = await driver.mcp!
      .act(
        'add',
        [
          {
            name: 'gh',
            setup: { type: 'stdio', command: 'npx', args: ['gh-mcp'], env: { GITHUB_TOKEN: TEST_SECRETS.githubPat } },
          },
        ],
        [],
      )
      .then(
        () => undefined,
        (error: Error) => error,
      );
    expect(failure?.message).toMatch(/invalid config/);
    expectNoSecretLeaks({ frames: [failure?.message ?? ''] });
  });
});
