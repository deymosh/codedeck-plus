/**
 * OpenCode's plugins: packages listed under `plugins` in its global config,
 * which every project loads.
 *
 * V2 reports what it has loaded over its API (`plugin.list`), but takes the
 * list itself only from config — its config API writes the shell and nothing
 * else — so install, uninstall and the disable switch all edit the global
 * config file (`globalConfig.ts`: JSONC, edited in place), and the API is
 * what reads the result back. An entry is a
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
import type { OpenCodeClient } from '@opencode/client';
import type { PluginManager, PluginState } from '../../sdk/driver';
import type { InstalledPlugin, PluginAction } from '../../sdk/types';
import { editGlobalConfig, newEntryFile, openCodeGlobalConfigFiles, readGlobalConfig, readGlobalConfigs } from './globalConfig';

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

  /** The file the `plugins` list lives in and is edited: the first that
   *  holds one (`entries` reads the same one), else the file OpenCode's own
   *  edits use — a later file overrides an earlier one, so writing the list
   *  to the first file would change nothing behind a later one. A file that
   *  does not parse stops the change: editing it would guess at what it
   *  means. */
  private async file(): Promise<{ path: string; entries: PluginEntry[] }> {
    let exists = false;
    for (const file of this.configFiles()) {
      const read = await readGlobalConfig(file);
      if (!read) continue;
      exists = true;
      if (Array.isArray(read.config.plugins)) return { path: file, entries: read.config.plugins as PluginEntry[] };
    }
    if (!exists) throw new Error('OpenCode has no global config file to write its plugins to.');
    const target = newEntryFile(this.configFiles());
    const read = await readGlobalConfig(target);
    return { path: target, entries: read && Array.isArray(read.config.plugins) ? (read.config.plugins as PluginEntry[]) : [] };
  }

  private async rewrite(action: PluginAction, target: string): Promise<void> {
    const { path: file, entries } = await this.file();
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
    await editGlobalConfig(file, [{ path: ['plugins'], value: next }]);
  }

  private async entries(): Promise<PluginEntry[]> {
    for (const { config } of await readGlobalConfigs(this.configFiles())) {
      if (Array.isArray(config.plugins)) return config.plugins as PluginEntry[];
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
