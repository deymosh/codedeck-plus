/**
 * The module list: which modules a host loads, the order it builds them in
 * (every claim before any driver), and the warm-up mode.
 */
import { describe, expect, it } from 'vitest';
import { FakeDriver } from '../../drivers/fake/driver';
import { DRIVER_MODULES, loadDrivers, selectModules, warmModules } from '../modules';
import type { DriverModule } from '../../sdk/module';

const base = (env: NodeJS.ProcessEnv, log: string[] = []) => ({
  env,
  lookupEnv: env,
  cacheDir: '/cache',
  registry: 'https://registry.example',
  log: (m: string) => log.push(m),
});

describe('selectModules', () => {
  it('loads every agent but the test ones by default, in catalog order', () => {
    expect(selectModules({}, () => {}).map((m) => m.id)).toEqual(['claude-code', 'opencode', 'deepseek-harness']);
  });

  it('loads what CODEDECK_AGENT_HOST_DRIVERS names, in its order, and skips an unknown id', () => {
    const log: string[] = [];
    const picked = selectModules({ CODEDECK_AGENT_HOST_DRIVERS: ' fake, pi ,opencode' }, (m) => log.push(m));
    expect(picked.map((m) => m.id)).toEqual(['fake', 'opencode']);
    expect(log).toEqual(["[agent-host] unknown driver 'pi' — skipped"]);
  });

  it('module ids are unique', () => {
    const ids = DRIVER_MODULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('loadDrivers', () => {
  it('lets every module claim its variables before any driver is built', async () => {
    const seen: Array<[string, string | undefined, string | undefined]> = [];
    const module = (id: string, claims?: string): DriverModule => ({
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
        return new FakeDriver();
      },
    });
    const env: NodeJS.ProcessEnv = { SECRET: 'k' };
    const drivers = await loadDrivers([module('a'), module('b', 'SECRET')], base(env));
    expect(drivers).toHaveLength(2);
    // `a` comes first but already sees the variable gone; `b` keeps it.
    expect(seen).toEqual([
      ['a', undefined, undefined],
      ['b', undefined, 'k'],
    ]);
  });
});

describe('warmModules', () => {
  it('installs what is missing and leaves alone what the machine has', async () => {
    const installed: string[] = [];
    const runtime = (found: string | null) => ({
      find: () => found,
      install: async () => {
        installed.push(found ?? 'x');
        return '/cache/x';
      },
    });
    const log: string[] = [];
    await warmModules(
      [
        { id: 'has', label: 'Has', runtime: runtime('/usr/bin/has'), create: () => new FakeDriver() },
        { id: 'needs', label: 'Needs', runtime: runtime(null), create: () => new FakeDriver() },
        { id: 'none', label: 'None', create: () => new FakeDriver() },
      ],
      base({}, log),
    );
    expect(installed).toEqual(['x']);
    expect(log).toEqual([
      '[warm] Has is already available (/usr/bin/has)',
      '[warm] Needs: /cache/x',
      '[warm] every agent this host was asked for is installed',
    ]);
  });
});
