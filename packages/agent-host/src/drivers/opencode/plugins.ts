/**
 * OpenCode's plugins: npm packages listed under `plugin` in its global
 * config. Its server reads and writes that config; OpenCode installs a listed
 * package itself the next time it loads, and a write reloads every project it
 * has open — which restarts the sessions running in them, as it does for any
 * change to its config.
 *
 * OpenCode has no marketplaces and no way to switch a plugin off short of
 * removing it, so only `install` and `uninstall` apply.
 */
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import type { PluginManager, PluginState } from '../../driver';
import type { InstalledPlugin, PluginAction } from '../../types';

type PluginEntry = string | [string, Record<string, unknown>];

/** An npm package, optionally scoped and versioned (`name`, `@scope/name`,
 *  `name@1.2.3`, `name@^1`, `name@latest`). */
const PACKAGE_SPEC = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~<>=*|-]+)?$/i;

const specOf = (entry: PluginEntry): string => (Array.isArray(entry) ? entry[0] : entry);

/** A listed plugin; its version is whatever the spec pins. */
export function toInstalledPlugin(entry: PluginEntry): InstalledPlugin {
  const spec = specOf(entry);
  const at = spec.lastIndexOf('@');
  const pinned = at > 0;
  return {
    id: spec,
    name: pinned ? spec.slice(0, at) : spec,
    ...(pinned ? { version: spec.slice(at + 1) } : {}),
    enabled: true,
  };
}

export class OpenCodePlugins implements PluginManager {
  /** One config write at a time: each rewrites the whole list. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly client: () => Promise<OpencodeClient>) {}

  list(): Promise<PluginState> {
    return this.serial(async () => this.state(await this.entries(await this.client())));
  }

  act(action: PluginAction, target: string): Promise<PluginState> {
    return this.serial(async () => {
      if (action !== 'install' && action !== 'uninstall') {
        throw new Error(
          action === 'enable' || action === 'disable'
            ? 'OpenCode cannot switch a plugin off; uninstall it instead.'
            : 'OpenCode has no plugin marketplaces; install a plugin by its npm package name.',
        );
      }
      if (action === 'install' && !PACKAGE_SPEC.test(target)) {
        throw new Error(`'${target}' is not an npm package name.`);
      }
      const client = await this.client();
      const entries = await this.entries(client);
      const listed = entries.some((e) => specOf(e) === target);
      if (action === 'uninstall' && !listed) throw new Error(`OpenCode has no plugin '${target}'.`);
      const next = action === 'install' ? (listed ? entries : [...entries, target]) : entries.filter((e) => specOf(e) !== target);
      if (next !== entries) {
        const { error } = await client.global.config.update({ config: { plugin: next } });
        if (error) throw new Error(`OpenCode refused the change: ${JSON.stringify(error)}`);
      }
      return this.state(next);
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private async entries(client: OpencodeClient): Promise<PluginEntry[]> {
    const { data, error } = await client.global.config.get();
    if (error || !data) throw new Error(`OpenCode could not read its config: ${JSON.stringify(error ?? 'no config')}`);
    return (data.plugin ?? []) as PluginEntry[];
  }

  private state(entries: PluginEntry[]): PluginState {
    return { installed: entries.map(toInstalledPlugin), toggles: false };
  }
}
