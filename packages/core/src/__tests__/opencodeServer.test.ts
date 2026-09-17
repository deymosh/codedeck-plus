import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveOpenCodePath,
  startOpenCodeServer,
  type SpawnFn,
} from '../sdk/opencodeServer';

/** Minimal fake ChildProcess: an EventEmitter with stdout/stderr sub-emitters
 *  and a `kill()` that records signals and (optionally) fires 'exit'. */
class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 4242;
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed: string[] = [];
  private exitOnKill: boolean;

  constructor(exitOnKill = true) {
    super();
    this.exitOnKill = exitOnKill;
  }

  kill(signal: string): boolean {
    this.killed.push(signal);
    if (this.exitOnKill) {
      this.signalCode = signal;
      queueMicrotask(() => this.emit('exit', null, signal));
    }
    return true;
  }
}

describe('resolveOpenCodePath', () => {
  it('returns the explicit path when it exists', () => {
    const env = {} as NodeJS.ProcessEnv;
    const explicit = __filename; // any file guaranteed to exist
    expect(resolveOpenCodePath(explicit, env, '/nonexistent-home')).toBe(explicit);
  });

  it('falls back to CODEDECK_OPENCODE_PATH when set and valid', () => {
    const env = { CODEDECK_OPENCODE_PATH: __filename } as unknown as NodeJS.ProcessEnv;
    expect(resolveOpenCodePath(undefined, env, '/nonexistent-home')).toBe(__filename);
  });

  it('returns null when nothing resolves', () => {
    const env = { PATH: '/nonexistent-bin' } as unknown as NodeJS.ProcessEnv;
    expect(resolveOpenCodePath('/no/such/file', env, '/nonexistent-home')).toBeNull();
  });
});

describe('startOpenCodeServer', () => {
  it('resolves with the parsed URL once the ready line is printed', async () => {
    const fake = new FakeChildProcess();
    const spawnFn = vi.fn(() => fake) as unknown as SpawnFn;

    const pending = startOpenCodeServer({ command: '/bin/opencode', spawnFn });
    fake.stdout.emit('data', Buffer.from('opencode server listening on http://127.0.0.1:4096\n'));

    const handle = await pending;
    expect(handle.url).toBe('http://127.0.0.1:4096');
    expect(handle.pid).toBe(4242);
    expect(spawnFn).toHaveBeenCalledWith(
      '/bin/opencode',
      ['serve', '--hostname=127.0.0.1', '--port=0'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it('rejects cleanly when the process errors immediately (e.g. missing binary)', async () => {
    const fake = new FakeChildProcess();
    const spawnFn = vi.fn(() => fake) as unknown as SpawnFn;

    const pending = startOpenCodeServer({ command: '/no/such/opencode', spawnFn });
    fake.emit('error', new Error('ENOENT'));

    await expect(pending).rejects.toThrow('ENOENT');
  });

  it('rejects and kills the process on timeout', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeChildProcess(false);
      const spawnFn = vi.fn(() => fake) as unknown as SpawnFn;

      const pending = startOpenCodeServer({ command: '/bin/opencode', spawnFn, timeoutMs: 1000 });
      const assertion = expect(pending).rejects.toThrow(/did not report ready/);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(fake.killed).toContain('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('close() sends SIGTERM then SIGKILL if the process does not exit', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeChildProcess(false);
      const spawnFn = vi.fn(() => fake) as unknown as SpawnFn;

      const pending = startOpenCodeServer({ command: '/bin/opencode', spawnFn });
      fake.stdout.emit('data', Buffer.from('opencode server listening on http://127.0.0.1:1234\n'));
      const handle = await pending;

      const closed = handle.close();
      expect(fake.killed).toEqual(['SIGTERM']);
      await vi.advanceTimersByTimeAsync(5000);
      expect(fake.killed).toEqual(['SIGTERM', 'SIGKILL']);
      fake.emit('exit', null, 'SIGKILL');
      await closed;
    } finally {
      vi.useRealTimers();
    }
  });

  it('close() resolves immediately if the process already exited', async () => {
    const fake = new FakeChildProcess();
    const spawnFn = vi.fn(() => fake) as unknown as SpawnFn;

    const pending = startOpenCodeServer({ command: '/bin/opencode', spawnFn });
    fake.stdout.emit('data', Buffer.from('opencode server listening on http://127.0.0.1:1234\n'));
    const handle = await pending;

    fake.exitCode = 0;
    await handle.close();
    expect(fake.killed).toEqual([]);
  });

  it('unhooks both the stdout and stderr listeners once ready, not just stdout', async () => {
    const fake = new FakeChildProcess();
    const spawnFn = vi.fn(() => fake) as unknown as SpawnFn;

    const pending = startOpenCodeServer({ command: '/bin/opencode', spawnFn });
    expect(fake.stdout.listenerCount('data')).toBe(1);
    expect(fake.stderr.listenerCount('data')).toBe(1);

    fake.stdout.emit('data', Buffer.from('opencode server listening on http://127.0.0.1:1234\n'));
    await pending;

    // Left dangling, a stderr listener with no reference kept would grow
    // `output` unboundedly for the process's whole lifetime — it must be
    // removed at the same point the stdout listener already was.
    expect(fake.stdout.listenerCount('data')).toBe(0);
    expect(fake.stderr.listenerCount('data')).toBe(0);
  });

  it('unhooks the stderr listener on an immediate process error too', async () => {
    const fake = new FakeChildProcess();
    const spawnFn = vi.fn(() => fake) as unknown as SpawnFn;

    const pending = startOpenCodeServer({ command: '/no/such/opencode', spawnFn });
    fake.emit('error', new Error('ENOENT'));
    await expect(pending).rejects.toThrow('ENOENT');

    expect(fake.stdout.listenerCount('data')).toBe(0);
    expect(fake.stderr.listenerCount('data')).toBe(0);
  });
});
