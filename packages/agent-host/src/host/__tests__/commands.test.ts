/**
 * The host's one-shot commands: list, install and remove agents from a
 * shell, on the same cache (and the same "removed" record) a running host
 * uses.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeDriver } from '../../drivers/fake/driver';
import type { DriverModule } from '../../sdk/module';
import { type BaseEnv, wasRemoved } from '../agents';
import { runCommand } from '../commands';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function base(): BaseEnv {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commands-'));
  dirs.push(cacheDir);
  return { env: {}, lookupEnv: {}, cacheDir, registry: 'https://registry.example', log: () => {} };
}

function modules(): DriverModule[] {
  let pinned = false;
  return [
    {
      id: 'own',
      label: 'Own',
      create: () => new FakeDriver(),
      runtime: { find: () => '/usr/bin/own', installed: () => null, install: async () => '/usr/bin/own', remove: () => {} },
    },
    {
      id: 'pinned',
      label: 'Pinned',
      create: () => new FakeDriver(),
      runtime: {
        find: () => null,
        installed: () => (pinned ? '/cache/pinned' : null),
        install: async () => {
          pinned = true;
          return '/cache/pinned';
        },
        remove: () => {
          pinned = false;
        },
      },
    },
    { id: 'test', label: 'Test', explicitOnly: true, create: () => new FakeDriver() },
  ];
}

async function run(args: string[], env: BaseEnv, list: DriverModule[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runCommand(args, env, (l) => lines.push(l), list);
  return { code, lines };
}

describe('runCommand', () => {
  it('lists every agent and where it stands', async () => {
    const env = base();
    const list = modules();
    expect(await run(['list'], env, list)).toEqual({
      code: 0,
      lines: ['own\tOwn\tready, on this machine: /usr/bin/own', 'pinned\tPinned\tnot installed'],
    });
    await run(['install', 'pinned'], env, list);
    expect((await run(['list'], env, list)).lines[1]).toBe('pinned\tPinned\tready, installed by CodeDeck: /cache/pinned');
    await run(['remove', 'pinned'], env, list);
    expect((await run(['list'], env, list)).lines[1]).toBe('pinned\tPinned\tnot installed (removed)');
  });

  it('installs, and leaves alone what the machine has', async () => {
    const env = base();
    expect(await run(['install', 'own', 'pinned'], env, modules())).toEqual({
      code: 0,
      lines: ['Own is already on this machine: /usr/bin/own', 'Pinned installed: /cache/pinned'],
    });
  });

  it("removes what CodeDeck installed, never the machine's own, and remembers the removal", async () => {
    const env = base();
    const list = modules();
    await run(['install', 'pinned'], env, list);
    expect(await run(['remove', 'pinned', 'own'], env, list)).toEqual({
      code: 1,
      lines: ['Pinned removed.', 'Own is on this machine outside CodeDeck (/usr/bin/own), so CodeDeck cannot remove it.'],
    });
    expect(wasRemoved(env.cacheDir, 'pinned')).toBe(true);
    await run(['install', 'pinned'], env, list);
    expect(wasRemoved(env.cacheDir, 'pinned')).toBe(false);
  });

  it('refuses what it cannot do, with a non-zero exit', async () => {
    const env = base();
    expect((await run(['install'], env, modules())).code).toBe(2);
    expect((await run(['upgrade', 'own'], env, modules())).code).toBe(2);
    expect(await run(['install', 'nope'], env, modules())).toEqual({ code: 1, lines: ["There is no agent 'nope'."] });
    expect(await run(['install', 'test'], env, modules())).toEqual({ code: 0, lines: ['Test has nothing to install.'] });
  });
});
