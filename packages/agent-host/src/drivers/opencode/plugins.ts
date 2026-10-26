/**
 * OpenCode's plugins: packages listed under `plugins` in its global config,
 * which every project loads.
 *
 * V2 reports what it has loaded over its API (`plugin.list`), but takes the
 * list itself only from config — its config API writes the shell and nothing
 * else — so install, uninstall and the disable switch all edit the global
 * config file, and the API is what reads the result back. An entry is a
 * package spec, or an object naming one with its options. A `-<id>` entry
 * switches a listed plugin off without removing it; a later plain entry
 * switches it back on.
 *
 * OpenCode has no marketplaces, so a plugin is installed by its package
 * name. V2 serves an explicit update, which the phone can ask for; OpenCode
 * also updates its own plugins when it loads them. Its `plugin.list` names
 * a package plugin by `source.target` (a package entry has no `id`; verified
 * against 2.1.4), which is the spec this file's `plugins` list holds.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { OpenCodeClient } from '@opencode/client';
import type { PluginManager, PluginState } from '../../sdk/driver';
import type { InstalledPlugin, PluginAction } from '../../sdk/types';

type PluginEntry = string | { package?: unknown; options?: unknown };

/** An npm package, optionally scoped and versioned (`name`, `@scope/name`,
 *  `name@1.2.3`, `name@^1`, `name@latest`). */
const PACKAGE_SPEC = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~<>=*|-]+)?$/i;

const specOf = (entry: PluginEntry): string =>
  typeof entry === 'string' ? entry : typeof entry.package === 'string' ? entry.package : '';
const isDisabled = (spec: string): boolean => spec.startsWith('-');
const bareSpec = (spec: string): string => (isDisabled(spec) ? spec.slice(1) : spec);

/** A listed plugin; its version is whatever the spec pins. */
export function toInstalledPlugin(entry: PluginEntry): InstalledPlugin | undefined {
  const spec = bareSpec(specOf(entry));
  if (!spec) return undefined;
  const at = spec.lastIndexOf('@');
  const pinned = at > 0;
  return {
    id: spec,
    name: pinned ? spec.slice(0, at) : spec,
    ...(pinned ? { version: spec.slice(at + 1) } : {}),
    enabled: !isDisabled(specOf(entry)),
  };
}

/** The files OpenCode reads its global config from. */
export function openCodeGlobalConfigFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const base = env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), '.config');
  return ['config.json', 'opencode.json', 'opencode.jsonc'].map((f) => path.join(base, 'opencode', f));
}

export class OpenCodePlugins implements PluginManager {
  /** One config write at a time: each rewrites the whole list. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly client: () => Promise<OpenCodeClient>,
    private readonly configFiles: () => string[] = () => openCodeGlobalConfigFiles(),
  ) {}

  list(): Promise<PluginState> {
    return this.serial(async () => this.state(await this.entries()));
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  act(action: PluginAction, target: string): Promise<PluginState> {
    return this.serial(async () => {
      if (action === 'update') {
        // V2 updates a listed plugin on request; it also does so by itself
        // when it loads one, so this is for asking for it now.
        const listed = await this.entries();
        if (!listed.some((e) => bareSpec(specOf(e)) === target)) {
          throw new Error(`OpenCode has no plugin '${target}'.`);
        }
        try {
          await (await this.client()).plugin.update({ targets: [target] });
        } catch (err) {
          throw new Error(`OpenCode could not update ${target}: ${err instanceof Error ? err.message : String(err)}`);
        }
        return this.state(await this.entries());
      }
      if (action !== 'install' && action !== 'uninstall' && action !== 'enable' && action !== 'disable') {
        throw new Error('OpenCode has no plugin marketplaces; install a plugin by its npm package name.');
      }
      if (action === 'install' && !PACKAGE_SPEC.test(target)) {
        throw new Error(`'${target}' is not an npm package name.`);
      }
      await this.rewrite(action, target);
      return this.state(await this.entries());
    });
  }

  /** The `plugins` array of the one global config file that holds it. */
  private async file(): Promise<{ path: string; config: Record<string, unknown>; entries: PluginEntry[] }> {
    for (const file of this.configFiles().filter((f) => existsSync(f))) {
      const text = await readFile(file, 'utf8');
      let config: Record<string, unknown>;
      try {
        config = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // A file OpenCode itself wrote is plain JSON; one with comments is
        // the user's own, and rewriting it would lose them.
        throw new Error(`${file} has comments, so it is not edited from here. Edit its "plugins" list by hand.`);
      }
      const entries = Array.isArray(config.plugins) ? (config.plugins as PluginEntry[]) : [];
      return { path: file, config, entries };
    }
    throw new Error('OpenCode has no global config file to write its plugins to.');
  }

  private async rewrite(action: PluginAction, target: string): Promise<void> {
    const { path: file, config, entries } = await this.file();
    const spec = (e: PluginEntry) => bareSpec(specOf(e));
    const listed = entries.some((e) => spec(e) === target);
    // Nothing to remove or switch: said plainly, rather than rewriting the
    // list to the same thing and reporting success.
    if ((action === 'uninstall' || action === 'enable' || action === 'disable') && !listed) {
      throw new Error(`OpenCode has no plugin '${target}'.`);
    }
    const without = entries.filter((e) => spec(e) !== target);
    let next: PluginEntry[];
    if (action === 'install') next = [...without, target];
    else if (action === 'uninstall') next = without;
    else {
      // The switch is an entry of its own: `-<id>` off, plain back on.
      next = action === 'disable' ? [...without, `-${target}`] : [...without, target];
    }
    await writeFile(file, `${JSON.stringify({ ...config, plugins: next }, null, 2)}\n`);
  }

  private async entries(): Promise<PluginEntry[]> {
    for (const file of this.configFiles().filter((f) => existsSync(f))) {
      try {
        const config = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
        if (Array.isArray(config.plugins)) return config.plugins as PluginEntry[];
      } catch {
        continue;
      }
    }
    return [];
  }

  private async state(entries: PluginEntry[]): Promise<PluginState> {
    // What the server has actually loaded, so a plugin it could not load
    // reads as failed rather than as a config line that looks fine.
    const loaded = await this.client()
      .then((client) => client.plugin.list())
      .then(
        (listed) =>
          new Map(
            listed.data.flatMap((plugin) => {
              // A package plugin has no `id`: 2.1.4 names it by its source
              // target, which is the package spec the config lists. Built-in
              // plugins (§ the rest of the list) do have one.
              const id = plugin.id ?? (plugin.source.type === 'package' ? plugin.source.target : undefined);
              return id ? [[id, plugin.state] as const] : [];
            }),
          ),
      )
      .catch(() => new Map());
    const plugins = entries
      .map(toInstalledPlugin)
      .filter((p): p is InstalledPlugin => p !== undefined)
      .map((plugin) => {
        const state = loaded.get(plugin.id);
        if (state?.status === 'failed') return { ...plugin, enabled: false, error: state.error };
        return plugin;
      });
    return { installed: plugins, toggles: true };
  }
}
