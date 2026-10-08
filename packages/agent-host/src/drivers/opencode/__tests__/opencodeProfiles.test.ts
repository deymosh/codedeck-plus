/**
 * Provider-profile sessions: the server each profile runs on (its config,
 * its token, its password, its lifetime) and how a session names the
 * profile's models.
 */
import { describe, expect, it, vi } from 'vitest';
import type { OpencodeClient, Session } from '@opencode-ai/sdk/v2/client';
import { OpenCodeDriver } from '../driver';
import { PROFILE_PROVIDER_ID, PROFILE_TOKEN_ENV, ProfileServers, profileConfig, type StartedServer } from '../profiles';
import type { ProviderBinding } from '../../../sdk/types';
import { recordingContext } from '../../../sdk/__tests__/context';

const router = (over: Partial<ProviderBinding> = {}): ProviderBinding => ({
  id: 'router',
  baseUrl: 'https://router.example/api',
  authToken: 'tok-secret',
  models: [{ id: 'Z.ai/glm-5', label: 'GLM 5' }, { id: 'kimi-k3' }],
  defaultModel: 'kimi-k3',
  ...over,
});

/** A fake `opencode serve`: records each start, exits when told. */
function fakeServers(idleMs = 1_000) {
  const starts: Array<{ env: Record<string, string>; exit: () => void; closed: boolean }> = [];
  const connects: Array<{ url: string; headers: Record<string, string> }> = [];
  const servers = new ProfileServers({
    start: async (env): Promise<StartedServer> => {
      let exit!: () => void;
      const exited = new Promise<void>((done) => (exit = done));
      const record = { env, exit, closed: false };
      starts.push(record);
      return {
        url: `http://127.0.0.1:${4100 + starts.length}`,
        exited,
        close: async () => {
          record.closed = true;
          exit();
        },
      };
    },
    log: () => {},
    idleMs,
    connect: (url, headers) => {
      connects.push({ url, headers });
      return { url } as unknown as OpencodeClient;
    },
  });
  return { servers, starts, connects };
}

describe('profileConfig', () => {
  it('enables only the profile, on its own models, with the token left to the environment', () => {
    const config = profileConfig(router());
    expect(config).toEqual({
      enabled_providers: [PROFILE_PROVIDER_ID],
      model: `${PROFILE_PROVIDER_ID}/kimi-k3`,
      small_model: `${PROFILE_PROVIDER_ID}/kimi-k3`,
      provider: {
        [PROFILE_PROVIDER_ID]: {
          npm: '@ai-sdk/openai-compatible',
          name: 'router',
          options: { baseURL: 'https://router.example/api/v1', apiKey: `{env:${PROFILE_TOKEN_ENV}}` },
          models: { 'Z.ai/glm-5': { name: 'GLM 5' }, 'kimi-k3': {} },
        },
      },
    });
    expect(JSON.stringify(config)).not.toContain('tok-secret');
    // A base URL that already names its version is not given another.
    expect(JSON.stringify(profileConfig(router({ baseUrl: 'https://router.example/v1/' })))).toContain('"baseURL":"https://router.example/v1"');
  });
});

describe('ProfileServers', () => {
  it('starts one password-guarded server per profile and shares it', async () => {
    const { servers, starts, connects } = fakeServers();
    const a = servers.acquire(router());
    const b = servers.acquire(router());
    await Promise.all([a.client, b.client]);
    expect(starts).toHaveLength(1);
    const env = starts[0]!.env;
    expect(env[PROFILE_TOKEN_ENV]).toBe('tok-secret');
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual(profileConfig(router()));
    const password = env.OPENCODE_SERVER_PASSWORD!;
    expect(password).toMatch(/^[0-9a-f]{48}$/);
    expect(connects[0]!.headers.authorization).toBe(`Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`);

    // Another token is another server, with another password.
    await servers.acquire(router({ authToken: 'tok-2' })).client;
    expect(starts).toHaveLength(2);
    expect(starts[1]!.env.OPENCODE_SERVER_PASSWORD).not.toBe(password);
    await servers.closeAll();
    expect(starts.every((s) => s.closed)).toBe(true);
  });

  it('keeps a server a while after its last session, then stops it', async () => {
    vi.useFakeTimers();
    try {
      const { servers, starts } = fakeServers(1_000);
      const lease = servers.acquire(router());
      await lease.client;
      lease.release();
      lease.release();
      await vi.advanceTimersByTimeAsync(500);
      // Picked up again within the grace period: the same server.
      const again = servers.acquire(router());
      await vi.advanceTimersByTimeAsync(2_000);
      expect(starts[0]!.closed).toBe(false);
      again.release();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(starts[0]!.closed).toBe(true);
      await servers.acquire(router()).client;
      expect(starts).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets a server that exited, and one that failed to start', async () => {
    const { servers, starts } = fakeServers();
    await servers.acquire(router()).client;
    starts[0]!.exit();
    await new Promise((r) => setTimeout(r, 0));
    await servers.acquire(router()).client;
    expect(starts).toHaveLength(2);

    const failing = new ProfileServers({
      start: vi.fn().mockRejectedValueOnce(new Error('no opencode')).mockResolvedValue({ url: 'http://x', exited: new Promise(() => {}), close: async () => {} }),
      log: () => {},
      connect: () => ({}) as OpencodeClient,
    });
    await expect(failing.acquire(router()).client).rejects.toThrow('no opencode');
    await expect(failing.acquire(router()).client).resolves.toBeDefined();
  });
});

describe('a session bound to a provider profile', () => {
  function profileClient() {
    async function* stream() {
      await new Promise((r) => setTimeout(r, 20));
    }
    return {
      event: { subscribe: vi.fn().mockResolvedValue({ stream: stream() }) },
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'ses_p' } as Session, error: undefined }),
        get: vi.fn(),
        abort: vi.fn().mockResolvedValue({ data: true, error: undefined }),
        prompt: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
        promptAsync: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
      },
    } as unknown as OpencodeClient;
  }

  function driverWith(client: OpencodeClient) {
    const started: Array<Record<string, string>> = [];
    const servers = new ProfileServers({
      start: async (env) => {
        started.push(env);
        return { url: 'http://127.0.0.1:4199', exited: new Promise(() => {}), close: async () => {} };
      },
      log: () => {},
      connect: () => client,
    });
    // The machine's own server is never asked.
    const machine = { event: { subscribe: vi.fn() } } as unknown as OpencodeClient;
    return { driver: OpenCodeDriver.withClient(machine, servers), started, machine };
  }

  it("runs on the profile's server, under the profile's model ids", async () => {
    const client = profileClient();
    const { driver, started, machine } = driverWith(client);
    expect(driver.info().supports?.providers).toBe(true);
    const ctx = recordingContext();
    driver.startSession({ sessionId: 's1', agent: 'opencode', cwd: '/w', provider: router() }, ctx);
    await ctx.ended();
    expect(started).toHaveLength(1);
    expect(machine.event.subscribe).not.toHaveBeenCalled();
    // The default model, as the profile names it.
    expect(ctx.events).toContainEqual({ type: 'info', nativeSessionId: 'ses_p', model: 'kimi-k3', mode: 'ask' });
  });

  it('is refused for a model the profile does not offer, an insecure URL or no token', () => {
    const { driver } = driverWith(profileClient());
    const start = (provider: ProviderBinding, model?: string) =>
      driver.startSession({ sessionId: 's1', agent: 'opencode', cwd: '/w', provider, ...(model ? { model } : {}) }, recordingContext());
    expect(() => start(router(), 'gpt-9')).toThrow(/does not offer the model 'gpt-9'/);
    expect(() => start(router({ baseUrl: 'http://router.example' }))).toThrow(/insecure base URL/);
    expect(() => start(router({ authToken: '' }))).toThrow(/no stored auth token/);
    // A model id with a slash is the profile's own, not provider/model.
    expect(() => start(router(), 'Z.ai/glm-5')).not.toThrow();
  });

  it("switches only among the profile's models", async () => {
    const { driver } = driverWith(profileClient());
    const ctx = recordingContext();
    const session = driver.startSession({ sessionId: 's1', agent: 'opencode', cwd: '/w', provider: router() }, ctx);
    await ctx.waitFor((e) => e.type === 'ready');
    await expect(session.setOption('model', 'Z.ai/glm-5')).resolves.toBeUndefined();
    await expect(session.setOption('model', 'anthropic/claude-x')).rejects.toThrow();
    await session.end();
  });
});
