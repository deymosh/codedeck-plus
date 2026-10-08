/**
 * Agents and where each stands: built when the machine has them, listed by
 * name when not, installed and removed on request, the default one
 * installed by itself unless the user removed it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Driver } from '../../sdk/driver';
import type { DriverModule } from '../../sdk/module';
import type { AgentInfo } from '../../sdk/types';
import { Agents, type BaseEnv } from '../agents';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function base(log: string[] = []): BaseEnv {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-'));
  dirs.push(cacheDir);
  return { env: {}, lookupEnv: {}, cacheDir, registry: 'https://registry.example', log: (m) => log.push(m) };
}

function stubDriver(id: string, events: string[] = []): Driver {
  return {
    info: () => ({
      id,
      displayName: id.toUpperCase(),
      modes: [{ id: 'default', label: 'Default' }],
      efforts: [],
      supports: { models: true, usage: false, providers: false, gsd: false, interrupt: true, commands: false, plugins: false, mcp: false, tasks: false },
      credentials: [],
    }),
    startSession: () => {
      throw new Error('not in these tests');
    },
    listModels: async () => ({ models: [] }),
    shutdown: async () => {
      events.push(`shutdown ${id}`);
    },
  };
}

/** A module whose runtime is the machine's (`mine`), pinned in the cache
 *  (`pinned`), or neither; `install` is how installing goes. */
function module(
  id: string,
  state: { mine?: string; pinned?: boolean; install?: () => Promise<string>; byDefault?: boolean },
  events: string[] = [],
): DriverModule {
  let pinned = state.pinned ?? false;
  return {
    id,
    label: id.toUpperCase(),
    ...(state.byDefault ? { installByDefault: true } : {}),
    create: () => stubDriver(id, events),
    runtime: {
      find: () => state.mine ?? null,
      installed: () => (pinned ? `/cache/${id}` : null),
      install: async () => {
        const where = await (state.install ?? (async () => `/cache/${id}`))();
        pinned = true;
        return where;
      },
      remove: () => {
        pinned = false;
        events.push(`removed ${id}`);
      },
    },
  };
}

/** Wait until the agent's entry settles (installs run in the background). */
async function settled(agents: Agents, id: string): Promise<AgentInfo> {
  for (let i = 0; i < 100; i++) {
    const info = agents.list().find((a) => a.id === id)!;
    if (info.install?.state !== 'installing') return info;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('still installing');
}

describe('Agents.load', () => {
  it('builds what the machine has and lists the rest by name', async () => {
    const agents = await Agents.load(
      [module('own', { mine: '/usr/bin/own' }), module('pinned', { pinned: true }), module('absent', {})],
      base(),
    );
    expect(agents.list().map((a) => [a.id, a.install])).toEqual([
      ['own', { state: 'ready' }],
      ['pinned', { state: 'ready', removable: true }],
      ['absent', { state: 'not_installed' }],
    ]);
    expect(agents.list()[2]).toMatchObject({ displayName: 'ABSENT', modes: [], supports: { models: false } });
    expect(() => agents.driver('absent')).toThrow('ABSENT is not installed on this machine');
    expect(() => agents.driver('nope')).toThrow("no agent 'nope' in this host");
    expect(agents.drivers()).toHaveLength(2);
  });

  it('lets every module claim its variables before any driver is built', async () => {
    const seen: Array<[string, string | undefined, string | undefined]> = [];
    const claiming = (id: string, claims?: string): DriverModule => ({
      id,
      label: id,
      ...(claims
        ? {
            claimEnv: (env: NodeJS.ProcessEnv) => {
              const own = { ...env };
              delete env[claims];
              return own;
            },
          }
        : {}),
      create: (ctx) => {
        seen.push([id, ctx.env.SECRET, ctx.ownEnv.SECRET]);
        return stubDriver(id);
      },
    });
    await Agents.load([claiming('a'), claiming('b', 'SECRET')], { ...base(), env: { SECRET: 'k' } });
    // `a` comes first but already sees the variable gone; `b` keeps it.
    expect(seen).toEqual([
      ['a', undefined, undefined],
      ['b', undefined, 'k'],
    ]);
  });

  it('installs the default agent when the machine has none of it', async () => {
    let finish!: (where: string) => void;
    const gate = new Promise<string>((resolve) => (finish = resolve));
    const agents = await Agents.load([module('dflt', { byDefault: true, install: () => gate })], base());
    const changes: AgentInfo[] = [];
    agents.onChange = (a) => changes.push(a);
    expect(agents.list()[0]!.install).toEqual({ state: 'installing' });
    expect(() => agents.driver('dflt')).toThrow('DFLT is still being installed');
    finish('/cache/dflt');
    expect((await settled(agents, 'dflt')).install).toEqual({ state: 'ready', removable: true });
    expect(changes.map((a) => a.install)).toEqual([{ state: 'ready', removable: true }]);
    expect(changes[0]!.modes).toHaveLength(1);
  });

  it('does not install the default agent again once the user removed it', async () => {
    const env = base();
    const agents = await Agents.load([module('dflt', { pinned: true, byDefault: true })], env);
    await agents.remove('dflt', async () => {});
    const again = await Agents.load([module('dflt', { byDefault: true })], env);
    expect(again.list()[0]!.install).toEqual({ state: 'not_installed' });
  });
});

describe('Agents.install', () => {
  it('reports the install as it goes, and a failure with its reason', async () => {
    let fail = true;
    const agents = await Agents.load(
      [module('a', { install: async () => (fail ? Promise.reject(new Error('HTTP 503')) : '/cache/a') })],
      base(),
    );
    const changes: AgentInfo['install'][] = [];
    agents.onChange = (a) => changes.push(a.install);

    agents.install('a');
    expect((await settled(agents, 'a')).install).toEqual({ state: 'failed', reason: 'HTTP 503' });
    fail = false;
    agents.install('a');
    expect((await settled(agents, 'a')).install).toEqual({ state: 'ready', removable: true });
    expect(changes).toEqual([
      { state: 'installing' },
      { state: 'failed', reason: 'HTTP 503' },
      { state: 'installing' },
      { state: 'ready', removable: true },
    ]);
    agents.install('a');
    expect(changes).toHaveLength(4);
  });

  it('refuses an agent that has nothing to install', async () => {
    const agents = Agents.of([stubDriver('x')]);
    agents.install('x');
    expect(() => agents.install('nope')).toThrow("no agent 'nope'");
  });
});

describe('Agents.remove', () => {
  it('tells the bridge first, then ends the sessions, stops the driver and deletes the files', async () => {
    const events: string[] = [];
    const agents = await Agents.load([module('a', { pinned: true }, events)], base());
    agents.onChange = (a) => events.push(`changed ${JSON.stringify(a.install)}`);
    await agents.remove('a', async (reason) => {
      events.push(`end sessions: ${reason}`);
    });
    expect(events).toEqual([
      'changed {"state":"not_installed"}',
      'end sessions: A was removed from this machine.',
      'shutdown a',
      'removed a',
    ]);
    expect(() => agents.driver('a')).toThrow('not installed');
  });

  it("never removes the machine's own agent", async () => {
    const agents = await Agents.load([module('a', { mine: '/usr/bin/a' })], base());
    await expect(agents.remove('a', async () => {})).rejects.toThrow(
      'A is on this machine outside CodeDeck (/usr/bin/a), so CodeDeck cannot remove it',
    );
  });

  it('turns a failed install back into not installed', async () => {
    const agents = await Agents.load([module('a', { install: () => Promise.reject(new Error('offline')) })], base());
    agents.install('a');
    await settled(agents, 'a');
    await agents.remove('a', async () => {});
    expect(agents.list()[0]!.install).toEqual({ state: 'not_installed' });
  });
});
