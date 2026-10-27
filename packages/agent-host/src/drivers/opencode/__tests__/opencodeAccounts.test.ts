/**
 * OpenCode's provider accounts: the list a phone sees (no secret in it),
 * a key, a device sign-in watched to its end, and a sign-in finished by
 * pasting back its loopback address — only that address.
 *
 * The server's side is the shared fake: its `oauth.status` is stateful, as
 * 2.1.4's is, so a sign-in completes when the fake is told it did, not by a
 * queued answer that becomes `pending` again on the next poll.
 */
import { describe, it, expect, vi } from 'vitest';
import { OpenCodeAccounts, loopbackCallback } from '../accounts';
import type { SignInState } from '../../../sdk/driver';
import { fakeOpenCode, type FakeOpenCodeServer } from './fakeServer';

const secret = { type: 'key', key: 'sk-SECRET' } as const;

function server(attemptUrl = 'https://github.com/login/device?user_code=ABCD'): FakeOpenCodeServer {
  return fakeOpenCode({
    credentials: [{ id: 'cred_1', integrationID: 'nano-gpt', label: 'work', active: true, value: secret }],
    signIns: [{ attemptID: 'con_1', url: attemptUrl, instructions: 'Enter code: ABCD', status: 'pending' }],
  });
}

const accountsOf = (fake: FakeOpenCodeServer, extra: Partial<ConstructorParameters<typeof OpenCodeAccounts>[1]> = {}) =>
  new OpenCodeAccounts(async () => fake.client, { pollMs: 1, now: () => 0, ...extra });

describe('OpenCode accounts', () => {
  it('lists what a phone can connect, and the connections without their secrets', async () => {
    const fake = server();
    const connected = await accountsOf(fake).list(false);
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
    expect((await accountsOf(fake).list(true)).map((a) => a.id)).toEqual(['github-copilot', 'nano-gpt', 'openai']);
  });

  it('keeps a key and answers with the connected accounts', async () => {
    const fake = server();
    const result = await accountsOf(fake).change('openai', { kind: 'key', method: 'key', key: 'sk-new', label: 'home' }, () => {});
    expect(fake.client.integration.connect.key).toHaveBeenCalledWith({ integrationID: 'openai', key: 'sk-new', label: 'home' });
    expect('accounts' in result).toBe(true);
    const accounts = (result as { accounts: Array<{ id: string; connections?: unknown[] }> }).accounts;
    expect(accounts.find((a) => a.id === 'openai')!.connections).toEqual([
      { id: 'cred_2', label: 'home', kind: 'key', active: true, removable: true },
    ]);
  });

  it("switches which of an integration's credentials is active", async () => {
    const fake = server();
    // A second key for the same provider leaves the first inactive.
    await accountsOf(fake).change('openai', { kind: 'key', method: 'key', key: 'sk-one', label: 'one' }, () => {});
    await accountsOf(fake).change('openai', { kind: 'key', method: 'key', key: 'sk-two', label: 'two' }, () => {});
    const result = await accountsOf(fake).change('openai', { kind: 'activate', connection: 'cred_2' }, () => {});
    const openai = (result as { accounts: Array<{ id: string; connections: Array<{ id: string; active?: boolean }> }> }).accounts.find(
      (a) => a.id === 'openai',
    )!;
    expect(openai.connections.map((c) => [c.id, c.active])).toEqual([
      ['cred_2', true],
      ['cred_3', false],
    ]);
    // A removed active credential leaves the other one active (verified).
    const removed = await accountsOf(fake).change('openai', { kind: 'remove', connection: 'cred_2' }, () => {});
    const left = (removed as { accounts: Array<{ id: string; connections: Array<{ id: string; active?: boolean }> }> }).accounts.find(
      (a) => a.id === 'openai',
    )!;
    expect(left.connections).toEqual([{ id: 'cred_3', label: 'two', kind: 'key', active: true, removable: true }]);
  });

  it('starts a device sign-in, lists the integrations first, and says once when it completes', async () => {
    const fake = server();
    const ended: SignInState[] = [];
    const result = await accountsOf(fake).change(
      'github-copilot',
      { kind: 'sign-in', method: 'device', answers: { deploymentType: 'github.com' } },
      (end) => ended.push(end),
    );
    const list = fake.client.integration.list as unknown as { mock: { invocationCallOrder: number[] } };
    const connect = fake.client.integration.oauth.connect as unknown as { mock: { invocationCallOrder: number[] } };
    expect(list.mock.invocationCallOrder[0]).toBeLessThan(connect.mock.invocationCallOrder[0]!);
    expect(fake.client.integration.oauth.connect).toHaveBeenCalledWith({
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
    // The status stays `complete` once it is, as 2.1.4's does; the driver
    // must report the end exactly once and then stop asking.
    fake.setSignIn('con_1', 'complete');
    await expect
      .poll(() => ended)
      .toEqual([{ status: 'complete', attemptId: 'con_1' }]);
    const calls = (fake.client.integration.oauth.status as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ended).toHaveLength(1);
    expect((fake.client.integration.oauth.status as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(calls);
  });

  it("finishes a paste-back sign-in only with that sign-in's own address", async () => {
    const callback = 'http://127.0.0.1:45493/auth/callback';
    const fake = server(`https://auth.openai.com/authorize?redirect_uri=${encodeURIComponent(callback)}&state=s`);
    // The attempt the driver started has the id the fake makes; its status
    // does not matter to the paste path.
    const open = vi.fn(async () => undefined);
    const accounts = accountsOf(fake, { open, pollMs: 60_000 });
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
