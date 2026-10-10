/**
 * Every agent this host can run — the one place that names them. The order
 * is the catalog's, which the phone lists agents in: the default agent
 * (OpenCode) first.
 */
import { claudeModule } from '../drivers/claude/module';
import { deepSeekModule } from '../drivers/deepseek/module';
import { fakeModule } from '../drivers/fake/module';
import { openCodeModule } from '../drivers/opencode/module';
import type { DriverModule } from '../sdk/module';

export const DRIVER_MODULES: readonly DriverModule[] = [openCodeModule, claudeModule, deepSeekModule, fakeModule];

/**
 * The modules `CODEDECK_AGENT_HOST_DRIVERS` (comma-separated ids) asks for,
 * in its order; unset = every module not marked `explicitOnly`. An unknown
 * id is logged and skipped.
 */
export function selectModules(
  env: NodeJS.ProcessEnv,
  log: (message: string) => void,
  modules: readonly DriverModule[] = DRIVER_MODULES,
): DriverModule[] {
  const asked = env.CODEDECK_AGENT_HOST_DRIVERS;
  if (asked === undefined) return modules.filter((m) => !m.explicitOnly);
  const selected: DriverModule[] = [];
  for (const id of asked.split(',').map((n) => n.trim()).filter(Boolean)) {
    const module = modules.find((m) => m.id === id);
    if (module) selected.push(module);
    else log(`[agent-host] unknown driver '${id}' — skipped`);
  }
  return selected;
}
