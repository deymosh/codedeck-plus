/**
 * Claude Code's plugins, managed through its own CLI (`claude plugin …`): the
 * Agent SDK can load plugins but not install them, and the CLI keeps
 * marketplaces, the plugin cache and `enabledPlugins` consistent. Everything
 * is user scope — `~/.claude` (or `CLAUDE_CONFIG_DIR`), the settings every
 * session loads.
 *
 * The CLI runs with the host's own environment, so it sees the same config
 * directory as the sessions. Its arguments never pass through a shell. It is
 * never given `-y`: a plugin whose marketplace installs it by running a
 * command of its own is refused with the CLI's reason rather than run
 * unseen.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { shortDescription } from '../../commands';
import type { PluginManager, PluginState } from '../../driver';
import type { AvailablePlugin, InstalledPlugin, PluginAction, PluginMarketplace } from '../../types';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `claude` with the given arguments. */
export type CliRunner = (args: string[], timeoutMs: number) => Promise<CliResult>;

const LIST_TIMEOUT_MS = 60_000;
/** Installing or adding a marketplace clones a git repository. */
const CHANGE_TIMEOUT_MS = 10 * 60_000;

/** `claude` at `executable`, with the host's environment and no stdin. */
export function execCli(executable: () => Promise<string>): CliRunner {
  return async (args, timeoutMs) => {
    const file = await executable();
    return new Promise((resolve) => {
      const child = execFile(
        file,
        args,
        { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: process.env },
        (err, stdout, stderr) => {
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
          resolve({ code, stdout: String(stdout), stderr: err && !stderr ? err.message : String(stderr) });
        },
      );
      child.stdin?.end();
    });
  };
}

/** The description in an installed plugin's own manifest, if it has one. */
export function readPluginDescription(installPath: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(path.join(installPath, '.claude-plugin', 'plugin.json'), 'utf8')) as {
      description?: unknown;
    };
    return typeof manifest.description === 'string' && manifest.description.trim()
      ? shortDescription(manifest.description)
      : undefined;
  } catch {
    return undefined;
  }
}

/** A plugin a session loaded, as its `init` message names it. */
export interface LoadedPlugin {
  name: string;
  path: string;
}

/** A JSON file's contents, or undefined when it is missing or unreadable. */
function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Does a hook matcher select `toolName`? Claude Code reads it as a regular
 *  expression over the whole name; none, `""` and `*` select every tool. */
function matcherSelects(matcher: unknown, toolName: string): boolean {
  if (typeof matcher !== 'string' || matcher === '' || matcher === '*') return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName);
  } catch {
    return matcher === toolName;
  }
}

/** Does a hooks configuration (a settings file, a plugin's hooks file, or
 *  the object a plugin's manifest inlines) hold a PreToolUse hook for
 *  `toolName`? */
function hasPreToolUseHook(config: unknown, toolName: string): boolean {
  if (!config || typeof config !== 'object') return false;
  const events = (config as { hooks?: unknown }).hooks ?? config;
  const groups = (events as { PreToolUse?: unknown }).PreToolUse;
  return Array.isArray(groups) && groups.some((g) => matcherSelects((g as { matcher?: unknown } | null)?.matcher, toolName));
}

/** The hooks configurations a plugin declares: its `hooks/hooks.json`, and
 *  whatever its manifest's `hooks` names (files relative to the plugin, or
 *  the configuration itself). */
function pluginHookConfigs(plugin: LoadedPlugin, readJson: (file: string) => unknown): unknown[] {
  const configs = [readJson(path.join(plugin.path, 'hooks', 'hooks.json'))];
  const declared = (readJson(path.join(plugin.path, '.claude-plugin', 'plugin.json')) as { hooks?: unknown } | undefined)?.hooks;
  for (const entry of Array.isArray(declared) ? declared : [declared]) {
    configs.push(typeof entry === 'string' ? readJson(path.join(plugin.path, entry)) : entry);
  }
  return configs;
}

/**
 * The plugin a PreToolUse hook that asked about `toolName` comes from. Claude
 * Code names a hook only by its event and tool, so this is told from the
 * configuration: the answer is the one loaded plugin that declares such a
 * hook, and only when none of `settingsFiles` declares one as well —
 * otherwise which of them asked cannot be told, and there is no answer.
 */
export function hookPluginOf(
  toolName: string,
  plugins: LoadedPlugin[],
  settingsFiles: string[],
  readJson: (file: string) => unknown = readJsonFile,
): string | undefined {
  if (settingsFiles.some((file) => hasPreToolUseHook(readJson(file), toolName))) return undefined;
  const declaring = plugins.filter((p) => pluginHookConfigs(p, readJson).some((c) => hasPreToolUseHook(c, toolName)));
  return declaring.length === 1 ? declaring[0]!.name : undefined;
}

/** The CLI's own words for a failure: its `--json` message, else the last
 *  line of its error output (its progress lines go to stdout), else of its
 *  output — without the status glyph. */
export function failureMessage(result: CliResult): string {
  const json = lastJson(result.stdout);
  if (json && typeof json.message === 'string') return json.message;
  const lastLine = (text: string) =>
    text
      .split('\n')
      .map((l) => l.replace(/^[\s✘✔×!]+/u, '').trim())
      .filter((l) => l !== '')
      .at(-1);
  return lastLine(result.stderr) ?? lastLine(result.stdout) ?? `claude exited with code ${result.code}`;
}

function lastJson(stdout: string): Record<string, unknown> | undefined {
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // not a JSON line
    }
  }
  return undefined;
}

interface CliInstalled {
  id?: unknown;
  version?: unknown;
  enabled?: unknown;
  installPath?: unknown;
}

interface CliAvailable {
  pluginId?: unknown;
  name?: unknown;
  description?: unknown;
  marketplaceName?: unknown;
  installCount?: unknown;
}

interface CliMarketplace {
  name?: unknown;
  repo?: unknown;
  url?: unknown;
  path?: unknown;
  source?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

export function toInstalled(entries: CliInstalled[], describe: (installPath: string) => string | undefined): InstalledPlugin[] {
  return entries.flatMap((e) => {
    const id = str(e.id);
    if (!id) return [];
    const at = id.lastIndexOf('@');
    const installPath = str(e.installPath);
    const description = installPath ? describe(installPath) : undefined;
    const version = str(e.version);
    return [{
      id,
      name: at > 0 ? id.slice(0, at) : id,
      ...(at > 0 ? { marketplace: id.slice(at + 1) } : {}),
      ...(version ? { version } : {}),
      ...(description ? { description } : {}),
      enabled: e.enabled !== false,
    }];
  });
}

export function toAvailable(entries: CliAvailable[]): AvailablePlugin[] {
  return entries.flatMap((e) => {
    const id = str(e.pluginId);
    const name = str(e.name);
    const marketplace = str(e.marketplaceName);
    if (!id || !name || !marketplace) return [];
    const description = str(e.description);
    return [{
      id,
      name,
      marketplace,
      ...(description ? { description: shortDescription(description) } : {}),
      ...(typeof e.installCount === 'number' && e.installCount >= 0 ? { installCount: Math.floor(e.installCount) } : {}),
    }];
  });
}

export function toMarketplaces(entries: CliMarketplace[]): PluginMarketplace[] {
  return entries.flatMap((e) => {
    const name = str(e.name);
    if (!name) return [];
    return [{ name, source: str(e.repo) ?? str(e.url) ?? str(e.path) ?? str(e.source) ?? name }];
  });
}

/** The CLI arguments for one change. */
export function actionArgs(action: PluginAction, target: string): string[] {
  switch (action) {
    case 'install':
    case 'uninstall':
    case 'enable':
    case 'disable':
    case 'update':
      return ['plugin', action, target, '--json'];
    case 'add-marketplace':
      return ['plugin', 'marketplace', 'add', target];
    case 'remove-marketplace':
      return ['plugin', 'marketplace', 'remove', target];
    case 'update-marketplace':
      return ['plugin', 'marketplace', 'update', target];
  }
}

/** A version the CLI prints as a full commit sha is shown short. */
const shortVersion = (version: string): string => (/^[0-9a-f]{40}$/i.test(version) ? version.slice(0, 12) : version);

/** What an update did, from the CLI's JSON line, in the phone's own words:
 *  whether it was already current, or moved from one version to another. */
export function updateMessage(json: Record<string, unknown> | undefined): string | undefined {
  if (!json) return undefined;
  const version = (v: unknown) => (typeof v === 'string' && v !== '' ? shortVersion(v) : undefined);
  const oldVersion = version(json.oldVersion);
  const newVersion = version(json.newVersion);
  if (json.updateOutcome === 'up_to_date') {
    return newVersion ? `Already at the latest version (${newVersion}).` : undefined;
  }
  if (oldVersion && newVersion && oldVersion !== newVersion) {
    return `Updated from ${oldVersion} to ${newVersion}.`;
  }
  return typeof json.message === 'string' && json.message ? json.message : undefined;
}

/** Actions that change what the marketplaces offer, so the fresh catalog is
 *  read back with the state. */
const touchesCatalog: Partial<Record<PluginAction, boolean>> = {
  'add-marketplace': true,
  'remove-marketplace': true,
  'update-marketplace': true,
};

export class ClaudePlugins implements PluginManager {
  /** One CLI invocation at a time: they all write the same settings and
   *  plugin cache. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly run: CliRunner,
    /** Tells the running sessions to load the plugins as they now are. */
    private readonly onChanged: () => Promise<void>,
    private readonly describe: (installPath: string) => string | undefined = readPluginDescription,
  ) {}

  list(available: boolean): Promise<PluginState> {
    return this.serial(() => this.read(available));
  }

  act(action: PluginAction, target: string): Promise<PluginState> {
    return this.serial(async () => {
      if (target === '' || target.startsWith('-')) throw new Error('That is not a plugin or marketplace name.');
      const result = await this.run(actionArgs(action, target), CHANGE_TIMEOUT_MS);
      const json = lastJson(result.stdout);
      const ok = json && typeof json.outcome === 'string' ? json.outcome === 'ok' : result.code === 0;
      if (!ok) throw new Error(failureMessage(result));
      await this.onChanged().catch(() => {});
      const state = await this.read(touchesCatalog[action] === true);
      const message = action === 'update' ? updateMessage(json) : undefined;
      return { ...state, ...(message ? { message } : {}) };
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private async read(available: boolean): Promise<PluginState> {
    const [plugins, marketplaces] = await Promise.all([
      this.json(available ? ['plugin', 'list', '--available', '--json'] : ['plugin', 'list', '--json']),
      this.json(['plugin', 'marketplace', 'list', '--json']),
    ]);
    const lists = (available ? plugins : { installed: plugins }) as { installed?: unknown; available?: unknown };
    const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
    return {
      installed: toInstalled(asArray<CliInstalled>(lists.installed), this.describe),
      marketplaces: toMarketplaces(asArray<CliMarketplace>(marketplaces)),
      toggles: true,
      ...(available ? { available: toAvailable(asArray<CliAvailable>(lists.available)) } : {}),
    };
  }

  private async json(args: string[]): Promise<unknown> {
    const result = await this.run(args, LIST_TIMEOUT_MS);
    if (result.code !== 0) throw new Error(failureMessage(result));
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch {
      throw new Error(`claude ${args.slice(0, -1).join(' ')} did not answer in JSON`);
    }
  }
}
