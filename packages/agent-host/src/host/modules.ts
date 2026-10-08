/**
 * Every agent this host can run — the one place that names them. The order
 * is the catalog's.
 */
import { claudeModule } from '../drivers/claude/module';
import { deepSeekModule } from '../drivers/deepseek/module';
import { fakeModule } from '../drivers/fake/module';
import { openCodeModule } from '../drivers/opencode/module';
import type { Driver } from '../sdk/driver';
import type { DriverEnv, DriverModule } from '../sdk/module';

export const DRIVER_MODULES: readonly DriverModule[] = [claudeModule, openCodeModule, deepSeekModule, fakeModule];

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

type Base = Omit<DriverEnv, 'ownEnv'>;

/** Build the modules' drivers. Every module claims its own variables first,
 *  since every agent process inherits the environment left over. */
export async function loadDrivers(modules: readonly DriverModule[], base: Base): Promise<Driver[]> {
  const own = modules.map((m) => m.claimEnv?.(base.env) ?? base.env);
  const drivers: Driver[] = [];
  for (const [i, module] of modules.entries()) {
    drivers.push(await module.create({ ...base, ownEnv: own[i]! }));
  }
  return drivers;
}

/**
 * Install what the modules' agents run from — the same installs a first
 * session would trigger — leaving alone any agent the machine already has.
 */
export async function warmModules(modules: readonly DriverModule[], base: Base): Promise<void> {
  for (const module of modules) {
    if (!module.runtime) continue;
    const ctx = { ...base, ownEnv: base.env };
    const found = module.runtime.find(ctx);
    if (found) {
      base.log(`[warm] ${module.label} is already available (${found})`);
      continue;
    }
    base.log(`[warm] ${module.label}: ${await module.runtime.install(ctx)}`);
  }
  base.log('[warm] every agent this host was asked for is installed');
}
