/**
 * The host's one-shot commands, run instead of serving: what the bridge's
 * `codedeck-bridge agents …` runs, and what an image build runs to bake an
 * agent in.
 *
 *   list              every agent and where it stands on this machine
 *   install <id>…     install agents at the version this build pins
 *   remove <id>…      remove what CodeDeck installed of agents
 *
 * They work on the same agent cache a running host uses; a running bridge
 * sees the change when its agent host next starts.
 */
import type { DriverEnv, DriverModule } from '../sdk/module';
import { type BaseEnv, markRemoved, wasRemoved } from './agents';
import { DRIVER_MODULES } from './modules';

export const COMMANDS = ['list', 'install', 'remove'] as const;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Where an agent stands, in words. */
function standing(module: DriverModule, ctx: DriverEnv): string {
  const runtime = module.runtime;
  if (!runtime) return 'ready (nothing to install)';
  const mine = runtime.find(ctx);
  if (mine) return `ready, on this machine: ${mine}`;
  const pinned = runtime.installed(ctx);
  if (pinned) return `ready, installed by CodeDeck: ${pinned}`;
  return wasRemoved(ctx.cacheDir, module.id) ? 'not installed (removed)' : 'not installed';
}

/**
 * Run one command; resolves to the process's exit code. `print` is for
 * what the command answers (stdout); progress goes to `base.log`.
 */
export async function runCommand(
  args: readonly string[],
  base: BaseEnv,
  print: (line: string) => void,
  modules: readonly DriverModule[] = DRIVER_MODULES,
): Promise<number> {
  const [command, ...ids] = args;
  const ctx: DriverEnv = { ...base, ownEnv: base.env };
  if (command === 'list') {
    for (const module of modules.filter((m) => !m.explicitOnly)) {
      print(`${module.id}\t${module.label}\t${standing(module, ctx)}`);
    }
    return 0;
  }
  if (command !== 'install' && command !== 'remove') {
    print(`Unknown command '${command ?? ''}'. Commands: ${COMMANDS.join(', ')}.`);
    return 2;
  }
  if (ids.length === 0) {
    print(`Name the agents to ${command}: ${modules.filter((m) => !m.explicitOnly).map((m) => m.id).join(', ')}.`);
    return 2;
  }
  let failed = false;
  for (const id of ids) {
    const module = modules.find((m) => m.id === id);
    const runtime = module?.runtime;
    if (!module || !runtime) {
      print(module ? `${module.label} has nothing to ${command}.` : `There is no agent '${id}'.`);
      failed ||= !module;
      continue;
    }
    const mine = runtime.find(ctx);
    try {
      if (command === 'install') {
        markRemoved(ctx.cacheDir, id, false, base.log);
        print(mine ? `${module.label} is already on this machine: ${mine}` : `${module.label} installed: ${await runtime.install(ctx)}`);
      } else if (mine) {
        print(`${module.label} is on this machine outside CodeDeck (${mine}), so CodeDeck cannot remove it.`);
        failed = true;
      } else {
        runtime.remove(ctx);
        markRemoved(ctx.cacheDir, id, true, base.log);
        print(`${module.label} removed.`);
      }
    } catch (err) {
      print(`${module.label} could not be ${command === 'install' ? 'installed' : 'removed'}: ${errorText(err)}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}
