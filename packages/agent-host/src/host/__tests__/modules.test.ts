/**
 * The module list: which modules a host loads, and in what order.
 */
import { describe, expect, it } from 'vitest';
import { DRIVER_MODULES, selectModules } from '../modules';

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

  it('installs one agent by default: OpenCode', () => {
    expect(DRIVER_MODULES.filter((m) => m.installByDefault).map((m) => m.id)).toEqual(['opencode']);
  });
});
