/**
 * OpenCode's provider accounts: the list a phone sees (no secret in it),
 * a key, a device sign-in watched to its end, and a sign-in finished by
 * pasting back its loopback address — only that address.
 */
import { describe, it, expect, vi } from 'vitest';
import type { OpenCodeClient } from '@opencode/client';
import { OpenCodeAccounts, loopbackCallback } from '../accounts';
import type { SignInState } from '../../../sdk/driver';

const integrations = [
  {
    id: 'nano-gpt',
    name: 'NanoGPT',
    methods: [{ type: 'key' }, { type: 'env', names: ['NANO_GPT_API_KEY'] }],
    connections: [{ type: 'credential', id: 'cred_1', label: 'work', method: 'key' }],
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    methods: [
      { type: 'env', names: ['GITHUB_TOKEN'] },
      {
        id: 'device',
        type: 'oauth',
        label: 'Login with GitHub Copilot',
        form: [
          { key: 'deploymentType', title: 'Deployment', required: true, type: 'string', options: [{ value: 'github.com', label: 'GitHub.com' }] },
          { key: 'enterpriseUrl', title: 'Enterprise URL', required: true, type: 'string', when: [{ key: 'deploymentType', op: 'eq', value: 'enterprise' }] },
          { key: 'server', hidden: true, type: 'string', default: 'https://x' },
        ],
      },
    ],
    connections: [{ type: 'env', name: 'GITHUB_TOKEN' }],
  },
  { id: 'openai', name: 'OpenAI', methods: [{ type: 'key' }, { id: 'chatgpt', type: 'oauth', label: 'Sign in with ChatGPT' }], connections: [] },
];

function fakeClient(attemptUrl = 'https://github.com/login/device?user_code=ABCD') {
  const statuses: string[] = [];
  const client = {
    integration: {
      list: vi.fn(async () => ({ data: integrations })),
      connect: { key: vi.fn(async () => undefined) },
      oauth: {
        connect: vi.fn(async () => ({
          data: { attemptID: 'con_1', url: attemptUrl, instructions: 'Enter code: ABCD', mode: 'auto', time: { created: 0, expires: 10_000 } },
        })),
        status: vi.fn(async () => ({ data: { status: statuses.shift() ?? 'pending', time: { created: 0, expires: 10_000 } } })),
        cancel: vi.fn(async () => undefined),
      },
    },
    credential: {
      // The real list carries the secret: it must never reach a phone.
      list: vi.fn(async () => [{ id: 'cred_1', integrationID: 'nano-gpt', label: 'work', active: true, value: { type: 'key', key: 'sk-SECRET' } }]),
      activate: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    },
  };
  return { client, statuses };
}

const accountsOf = (client: unknown, extra: Partial<ConstructorParameters<typeof OpenCodeAccounts>[1]> = {}) =>
  new OpenCodeAccounts(async () => client as unknown as OpenCodeClient, { pollMs: 1, now: () => 0, ...extra });

describe('OpenCode accounts', () => {
  it('lists what a phone can connect, and the connections without their secrets', async () => {
    const { client } = fakeClient();
    const connected = await accountsOf(client).list(false);
    expect(connected.map((a) => a.id)).toEqual(['github-copilot', 'nano-gpt']);
    expect(connected.find((a) => a.id === 'nano-gpt')).toEqual({
      id: 'nano-gpt',
      name: 'NanoGPT',
      methods: [{ id: 'key', kind: 'key' }],
      connections: [{ id: 'cred_1', label: 'work', kind: 'key', active: true, removable: true }],
    });
    // The environment's variable shows, and cannot be removed from here;
    // the hidden field keeps its default and is not asked.
    const copilot = connected.find((a) => a.id === 'github-copilot')!;
    expect(copilot.connections).toEqual([{ id: 'GITHUB_TOKEN', label: 'GITHUB_TOKEN', kind: 'env' }]);
    expect(copilot.methods?.[0]?.fields?.map((f) => f.key)).toEqual(['deploymentType', 'enterpriseUrl']);
    expect(copilot.methods?.[0]?.fields?.[1]?.when).toEqual([{ key: 'deploymentType', value: 'enterprise' }]);
    expect(JSON.stringify(connected)).not.toContain('sk-SECRET');
    expect((await accountsOf(client).list(true)).map((a) => a.id)).toEqual(['github-copilot', 'nano-gpt', 'openai']);
  });

  it('keeps a key and answers with the connected accounts', async () => {
    const { client } = fakeClient();
    const result = await accountsOf(client).change('openai', { kind: 'key', method: 'key', key: 'sk-new', label: 'home' }, () => {});
    expect(client.integration.connect.key).toHaveBeenCalledWith({ integrationID: 'openai', key: 'sk-new', label: 'home' });
    expect('accounts' in result).toBe(true);
  });

  it('starts a device sign-in, lists the integrations first, and says once when it completes', async () => {
    const { client, statuses } = fakeClient();
    statuses.push('pending', 'complete');
    const ended: SignInState[] = [];
    const result = await accountsOf(client).change(
      'github-copilot',
      { kind: 'sign-in', method: 'device', answers: { deploymentType: 'github.com' } },
      (end) => ended.push(end),
    );
    expect(client.integration.list.mock.invocationCallOrder[0]).toBeLessThan(client.integration.oauth.connect.mock.invocationCallOrder[0]!);
    expect(client.integration.oauth.connect).toHaveBeenCalledWith({
      integrationID: 'github-copilot',
      methodID: 'device',
      answer: { deploymentType: 'github.com' },
    });
    expect(result).toEqual({
      signIn: {
        status: 'started',
        attemptId: 'con_1',
        attempt: { attemptId: 'con_1', url: 'https://github.com/login/device?user_code=ABCD', instructions: 'Enter code: ABCD', expiresAt: 10_000 },
      },
    });
    await vi.waitFor(() => expect(ended).toEqual([{ status: 'complete', attemptId: 'con_1' }]));
  });

  it("finishes a paste-back sign-in only with that sign-in's own address", async () => {
    const callback = 'http://127.0.0.1:45493/auth/callback';
    const { client } = fakeClient(`https://auth.openai.com/authorize?redirect_uri=${encodeURIComponent(callback)}&state=s`);
    const open = vi.fn(async () => undefined);
    const accounts = accountsOf(client, { open, pollMs: 60_000 });
    const started = await accounts.change('openai', { kind: 'sign-in', method: 'chatgpt' }, () => {});
    expect('signIn' in started && started.signIn.attempt?.pasteBack).toBe(true);

    for (const wrong of ['http://127.0.0.1:45494/auth/callback?code=c', 'http://127.0.0.1:45493/admin?x=1', 'http://localhost:45493/auth/callback?code=c']) {
      await expect(accounts.change('openai', { kind: 'finish', attempt: 'con_1', callbackUrl: wrong }, () => {})).rejects.toThrow(/not this sign-in's address/);
    }
    await accounts.change('openai', { kind: 'finish', attempt: 'con_1', callbackUrl: `${callback}?code=c&state=s` }, () => {});
    expect(open).toHaveBeenCalledWith(`${callback}?code=c&state=s`);

    // Cancelled: it is no longer watched, and a paste is refused.
    const cancelled = await accounts.change('openai', { kind: 'cancel', attempt: 'con_1' }, () => {});
    expect(cancelled).toEqual({ signIn: { status: 'cancelled', attemptId: 'con_1' } });
    await expect(accounts.change('openai', { kind: 'finish', attempt: 'con_1', callbackUrl: `${callback}?code=c` }, () => {})).rejects.toThrow(/over/);
    accounts.close();
  });

  it('tells a loopback callback from a provider page', () => {
    expect(loopbackCallback('https://a/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback')).toEqual({
      origin: 'http://127.0.0.1:1455',
      pathname: '/auth/callback',
    });
    expect(loopbackCallback('https://opencode.ai/console/device?user_code=X')).toBeUndefined();
    expect(loopbackCallback('https://a/authorize?redirect_uri=https%3A%2F%2Fexample.com%2Fcb')).toBeUndefined();
  });
});
