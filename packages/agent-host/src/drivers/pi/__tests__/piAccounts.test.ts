/**
 * Pi's accounts. Listing, storing a key and removing it run the real helper
 * against the Pi this workspace pins (all three are local file operations,
 * no network), so what is checked is what Pi itself stores and reports. A
 * sign-in needs a provider's own server, so its flow runs on a scripted
 * helper that speaks the helper's records.
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SignInState } from '../../../sdk/driver';
import { PiAccounts } from '../accounts';
import { bundledPiExecutable } from '../install';

const piPath = bundledPiExecutable();
if (!piPath) console.warn('piAccounts: no Pi CLI beside the workspace — skipping the real-helper tests');
const real = piPath ? describe : describe.skip;

function accounts(env: Record<string, string> = {}): { accounts: PiAccounts; home: string; changes: number[] } {
  const home = mkdtempSync(path.join(tmpdir(), 'codedeck-pi-accounts-'));
  const changes: number[] = [];
  const manager = new PiAccounts({
    home,
    entryPoint: async () => piPath!,
    env: () => ({ PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', PI_CODING_AGENT_DIR: home, ...env }),
    changed: () => changes.push(1),
  });
  return { accounts: manager, home, changes };
}

const noEnd = (): void => {};

real('Pi accounts, through the installed Pi', () => {
  it('lists every provider Pi knows with its ways to connect, and only connected ones by default', async () => {
    const { accounts: manager } = accounts();
    const all = await manager.list(true);
    const openrouter = all.find((account) => account.id === 'openrouter');
    expect(openrouter?.methods).toContainEqual(expect.objectContaining({ id: 'key', kind: 'key' }));
    const anthropic = all.find((account) => account.id === 'anthropic');
    expect(anthropic?.methods).toContainEqual(expect.objectContaining({ id: 'sign-in', kind: 'sign-in' }));
    expect(await manager.list(false)).toEqual([]);
  }, 60_000);

  it('stores a key where Pi keeps it, shows it without the secret, and removes it', async () => {
    const { accounts: manager, home, changes } = accounts();
    const result = await manager.change('openrouter', { kind: 'key', method: 'key', key: 'sk-or-codedeck-test' }, noEnd);
    expect('accounts' in result && result.accounts).toEqual([
      expect.objectContaining({
        id: 'openrouter',
        connections: [expect.objectContaining({ id: 'openrouter', kind: 'key', removable: true })],
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('sk-or-codedeck-test');
    const stored = JSON.parse(readFileSync(path.join(home, 'auth.json'), 'utf8')) as Record<string, { type: string; key: string }>;
    expect(stored.openrouter).toEqual({ type: 'api_key', key: 'sk-or-codedeck-test' });
    expect(changes).toHaveLength(1);

    const removed = await manager.change('openrouter', { kind: 'remove', connection: 'openrouter' }, noEnd);
    expect('accounts' in removed && removed.accounts).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(home, 'auth.json'), 'utf8'))).toEqual({});
    expect(changes).toHaveLength(2);
  }, 60_000);

  it('shows a key from the machine’s environment as the machine’s, and will not remove it', async () => {
    const { accounts: manager, home } = accounts({ OPENROUTER_API_KEY: 'sk-or-env' });
    const listed = await manager.list(false);
    expect(listed).toEqual([
      expect.objectContaining({ id: 'openrouter', connections: [expect.objectContaining({ kind: 'env' })] }),
    ]);
    expect(JSON.stringify(listed)).not.toContain('sk-or-env');
    const connection = listed[0]!.connections![0]!.id;
    await expect(manager.change('openrouter', { kind: 'remove', connection }, noEnd)).rejects.toThrow(/only the machine/);
    expect(existsSync(path.join(home, 'auth.json')) ? readFileSync(path.join(home, 'auth.json'), 'utf8') : '{}').not.toContain('sk-or-env');
  }, 60_000);
});

/** A scripted helper: records what the driver sends, and answers with the
 *  records a test plays. */
class ScriptedHelper {
  readonly sent: Array<Record<string, unknown>> = [];
  readonly child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), {
      write: (line: string): boolean => {
        for (const part of line.split('\n').filter(Boolean)) this.sent.push(JSON.parse(part) as Record<string, unknown>);
        this.onSend?.(this.sent[this.sent.length - 1]!);
        return true;
      },
    }),
    kill: (): boolean => {
      this.exit(null);
      return true;
    },
  });
  onSend?: (record: Record<string, unknown>) => void;
  private exited = false;

  say(record: Record<string, unknown>): void {
    this.child.stdout.emit('data', Buffer.from(`${JSON.stringify(record)}\n`));
  }

  exit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.child.emit('close', code);
  }
}

function scripted(helper: ScriptedHelper, now = () => 1_000): PiAccounts {
  const home = mkdtempSync(path.join(tmpdir(), 'codedeck-pi-accounts-'));
  return new PiAccounts({
    home,
    entryPoint: async () => path.join(home, 'dist', 'bundle', 'cli.js'),
    env: () => ({}),
    changed: () => {},
    spawnFn: (() => helper.child) as never,
    now,
  });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('Pi sign-in', () => {
  it('starts a paste-back sign-in, hands the pasted address to Pi, and reports the end once', async () => {
    const helper = new ScriptedHelper();
    helper.onSend = (record) => {
      if (record.op === 'login') {
        setImmediate(() => {
          helper.say({ type: 'notify', event: { type: 'auth_url', url: 'https://claude.ai/oauth/authorize?x=1' } });
          helper.say({ type: 'prompt', id: 'p1', prompt: { type: 'manual_code', message: 'Paste the redirect URL' } });
        });
      }
      if (record.op === 'answer') {
        setImmediate(() => {
          helper.say({ type: 'done' });
          helper.exit(0);
        });
      }
    };
    const ends: SignInState[] = [];
    const manager = scripted(helper);
    const started = await manager.change('anthropic', { kind: 'sign-in', method: 'sign-in' }, (end) => ends.push(end));
    expect('signIn' in started && started.signIn).toMatchObject({
      status: 'started',
      attempt: { url: 'https://claude.ai/oauth/authorize?x=1', pasteBack: true },
    });
    const attemptId = 'signIn' in started ? started.signIn.attemptId : '';
    await tick();
    await manager.change('anthropic', { kind: 'finish', attempt: attemptId, callbackUrl: 'http://localhost:53692/callback?code=abc' }, noEnd);
    expect(helper.sent).toContainEqual({ op: 'answer', id: 'p1', value: 'http://localhost:53692/callback?code=abc' });
    await tick();
    await tick();
    expect(ends).toEqual([{ status: 'complete', attemptId }]);
  });

  it('keeps an address pasted before Pi asks for it, and gives it when Pi does', async () => {
    const helper = new ScriptedHelper();
    helper.onSend = (record) => {
      if (record.op === 'login') setImmediate(() => helper.say({ type: 'notify', event: { type: 'auth_url', url: 'https://example.com/a' } }));
    };
    const manager = scripted(helper);
    const started = await manager.change('xai', { kind: 'sign-in', method: 'sign-in' }, noEnd);
    const attemptId = 'signIn' in started ? started.signIn.attemptId : '';
    await manager.change('xai', { kind: 'finish', attempt: attemptId, callbackUrl: 'http://localhost:1/cb?code=z' }, noEnd);
    helper.say({ type: 'prompt', id: 'p7', prompt: { type: 'manual_code', message: 'Paste' } });
    expect(helper.sent).toContainEqual({ op: 'answer', id: 'p7', value: 'http://localhost:1/cb?code=z' });
  });

  it('shows a device code to enter, and reports Pi’s failure as the end', async () => {
    const helper = new ScriptedHelper();
    helper.onSend = (record) => {
      if (record.op === 'login') {
        setImmediate(() =>
          helper.say({ type: 'notify', event: { type: 'device_code', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresInSeconds: 900 } }),
        );
      }
    };
    const ends: SignInState[] = [];
    const manager = scripted(helper);
    const started = await manager.change('github-copilot', { kind: 'sign-in', method: 'sign-in' }, (end) => ends.push(end));
    expect('signIn' in started && started.signIn.attempt).toEqual(
      expect.objectContaining({ url: 'https://github.com/login/device', instructions: expect.stringContaining('ABCD-1234'), expiresAt: 1_000 + 900_000 }),
    );
    expect('signIn' in started && started.signIn.attempt?.pasteBack).toBeUndefined();
    helper.say({ type: 'error', message: 'The device code expired' });
    helper.exit(1);
    await tick();
    await tick();
    expect(ends).toEqual([expect.objectContaining({ status: 'failed', error: 'The device code expired' })]);
  });

  it('reports nothing after the user cancels', async () => {
    const helper = new ScriptedHelper();
    helper.onSend = (record) => {
      if (record.op === 'login') setImmediate(() => helper.say({ type: 'notify', event: { type: 'auth_url', url: 'https://example.com/a' } }));
    };
    const ends: SignInState[] = [];
    const manager = scripted(helper);
    const started = await manager.change('openai', { kind: 'sign-in', method: 'sign-in' }, (end) => ends.push(end));
    const attemptId = 'signIn' in started ? started.signIn.attemptId : '';
    const cancelled = await manager.change('openai', { kind: 'cancel', attempt: attemptId }, noEnd);
    expect('signIn' in cancelled && cancelled.signIn.status).toBe('cancelled');
    expect(helper.sent).toContainEqual({ op: 'cancel' });
    await tick();
    expect(ends).toEqual([]);
  });
});

describe('Pi key login', () => {
  it('refuses a provider whose login asks more than the key, with Pi’s own question', async () => {
    const helper = new ScriptedHelper();
    helper.onSend = (record) => {
      if (record.op === 'login') {
        setImmediate(() => helper.say({ type: 'prompt', id: 'p1', prompt: { type: 'text', message: 'Azure resource name' } }));
      }
      if (record.op === 'cancel') {
        setImmediate(() => {
          helper.say({ type: 'error', message: 'cancelled' });
          helper.exit(1);
        });
      }
    };
    await expect(scripted(helper).change('azure', { kind: 'key', method: 'key', key: 'k' }, noEnd)).rejects.toThrow(/Azure resource name/);
  });

  it('keeps the key out of an error Pi gives back', async () => {
    const helper = new ScriptedHelper();
    helper.onSend = (record) => {
      if (record.op === 'login') setImmediate(() => helper.say({ type: 'prompt', id: 'p1', prompt: { type: 'secret', message: 'Key' } }));
      if (record.op === 'answer') {
        setImmediate(() => {
          helper.say({ type: 'error', message: 'invalid key sk-secret-value' });
          helper.exit(1);
        });
      }
    };
    const failure = scripted(helper).change('openrouter', { kind: 'key', method: 'key', key: 'sk-secret-value' }, noEnd);
    await expect(failure).rejects.toThrow(/invalid key/);
    await expect(failure).rejects.not.toThrow(/sk-secret-value/);
  });
});
