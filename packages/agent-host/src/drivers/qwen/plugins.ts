/**
 * Qwen Code's extensions, as the phone's plugins: changed through Qwen Code's
 * own CLI (`qwen extensions install|uninstall|enable|disable|update`), which
 * keeps its extension store and its enablement rules consistent, and listed
 * from the extensions directory under `$QWEN_HOME`, since the CLI's `list`
 * prints text only.
 *
 * On disk (Qwen Code 0.27.1): `$QWEN_HOME/extensions/<dir>/` holds an
 * extension's `qwen-extension.json` (its `name`, `version`, `description` and
 * `displayName`, the last two a string or a map of locales) and
 * `.qwen-extension-install.json` (`source`, `type`); a linked extension's
 * directory holds only the latter, and its manifest is at `source`. Whether
 * an extension loads is a list of path rules per extension in
 * `extensions/extension-enablement.json`, the last rule matching a session's
 * workspace winning: `/*` on everywhere, `!/*` off everywhere.
 *
 * The phone's switch is for the whole machine, but the CLI's own disable
 * scopes its rule to the home directory (`!$HOME/*`), which leaves an
 * extension loading in every workspace outside it — the image's
 * `/data/workspaces` among them. So enable and disable run with the home
 * directory at the filesystem root (on Windows, the root of the drive
 * `$QWEN_HOME` is on), which makes the rule `/*` or `!/*` and drops the
 * narrower rules under it.
 *
 * A Qwen Code process loads its extensions as it starts: every change bumps
 * the shared configuration version, so later sessions start on a fresh
 * process that has them, while a running session keeps what it started with.
 *
 * Install runs with `--consent`: the CLI's confirmation prompt cannot be
 * answered without a terminal — with no stdin it prints the question, exits 0
 * and installs nothing — and the phone's own install button is the consent.
 * Its arguments never pass through a shell.
 */
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { shortDescription } from '../../sdk/commands';
import type { PluginManager, PluginState } from '../../sdk/driver';
import type { InstalledPlugin, PluginAction } from '../../sdk/types';
import { QWEN_LABEL } from './install';
import { qwenCommand, QWEN_OFF_ENV, type QwenConfigVersion } from './runtime';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `qwen` with the given arguments; `rootHome` puts its home directory
 *  at the filesystem root, which scopes an enablement rule to every path. */
export type QwenCliRunner = (args: string[], options: { timeoutMs: number; rootHome: boolean }) => Promise<CliResult>;

/** Installing clones a git repository or fetches an npm package. */
const CHANGE_TIMEOUT_MS = 10 * 60_000;

/** What the phone's install form asks for, and what it should know. */
const INSTALL_HINT = 'Git URL, local path or npm package';
const INSTALL_NOTE =
  'Extensions add commands, context, skills and MCP servers to every session on this machine. ' +
  'Sessions started after a change load it; running ones keep what they started with.';

/** `qwen` at `entry` — the runtime's own CLI — with `$QWEN_HOME` set, no
 *  telemetry, no stdin, and `$QWEN_HOME` as its working directory, so no
 *  project's own settings take part. */
export function qwenCli(entry: () => Promise<string>, home: string, baseEnv: NodeJS.ProcessEnv): QwenCliRunner {
  return async (args, { timeoutMs, rootHome }) => {
    const command = qwenCommand(await entry(), args);
    const root = path.parse(path.resolve(home)).root;
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      ...QWEN_OFF_ENV,
      QWEN_HOME: home,
      ...(rootHome ? { HOME: root, USERPROFILE: root } : {}),
    };
    return new Promise((resolve) => {
      const child = execFile(
        command.command,
        command.args,
        { cwd: home, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env },
        (err, stdout, stderr) => {
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
          resolve({ code, stdout: String(stdout), stderr: err && !stderr ? err.message : String(stderr) });
        },
      );
      child.stdin?.end();
    });
  };
}

/** The CLI's own words for a failure: the last line of its error output,
 *  else of its output. */
export function failureMessage(result: CliResult): string {
  return lastLine(result.stderr) ?? lastLine(result.stdout) ?? `qwen exited with code ${result.code}`;
}

function lastLine(text: string): string | undefined {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .at(-1);
}

/** The CLI arguments for one change; marketplace actions have none. */
export function actionArgs(action: PluginAction, target: string): string[] | undefined {
  switch (action) {
    case 'install':
      return ['extensions', 'install', target, '--consent'];
    case 'uninstall':
    case 'enable':
    case 'disable':
    case 'update':
      return ['extensions', action, target];
    default:
      return undefined;
  }
}

/** Is a rule one over every path: `/*`, or a drive root's on Windows, which
 *  Qwen Code writes with its slashes forward and a leading one (`/C:/*`)? */
const ROOT_RULE = /^\/(?:[A-Za-z]:\/)?\*$/;

/**
 * Is an extension on for the whole machine? The last rule over every path
 * decides, and with none it is on. Narrower rules — a workspace's own, or the
 * terminal's disable under the home directory — cover part of the machine
 * only, so they are not the phone's switch.
 */
export function enabledEverywhere(overrides: unknown): boolean {
  const rules = Array.isArray(overrides) ? overrides.filter((r): r is string => typeof r === 'string') : [];
  for (const rule of [...rules].reverse()) {
    const disable = rule.startsWith('!');
    if (ROOT_RULE.test(disable ? rule.slice(1) : rule)) return !disable;
  }
  return true;
}

/** A manifest string that is either plain or a map of locales. */
function localized(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const map = value as Record<string, unknown>;
    const pick = map.en ?? Object.values(map).find((v) => typeof v === 'string');
    return typeof pick === 'string' ? pick.trim() || undefined : undefined;
  }
  return undefined;
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const MANIFEST = 'qwen-extension.json';
const INSTALL_METADATA = '.qwen-extension-install.json';
const ENABLEMENT = 'extension-enablement.json';

/** The extensions installed under `home`, in name order. A directory without
 *  a readable manifest is not an extension and is left out. */
export async function readQwenExtensions(home: string): Promise<InstalledPlugin[]> {
  const dir = path.join(home, 'extensions');
  let entries: string[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const enablement = (await readJson(path.join(dir, ENABLEMENT))) ?? {};
  const out: InstalledPlugin[] = [];
  for (const entry of entries) {
    const install = await readJson(path.join(dir, entry, INSTALL_METADATA));
    const linked = install?.type === 'link' && typeof install.source === 'string';
    const manifest = await readJson(path.join(linked ? (install.source as string) : path.join(dir, entry), MANIFEST));
    const name = typeof manifest?.name === 'string' && manifest.name !== '' ? manifest.name : undefined;
    if (!manifest || !name) continue;
    const rules = (enablement[name] as { overrides?: unknown } | undefined)?.overrides;
    const description = localized(manifest.description);
    const version = typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : undefined;
    out.push({
      id: name,
      name: localized(manifest.displayName) ?? name,
      ...(version ? { version } : {}),
      ...(description ? { description: shortDescription(description) } : {}),
      enabled: enabledEverywhere(rules),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export class QwenPlugins implements PluginManager {
  /** One CLI invocation at a time: they all write the same extension store. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly home: string,
    private readonly run: QwenCliRunner,
    private readonly config: QwenConfigVersion,
  ) {}

  list(available: boolean): Promise<PluginState> {
    void available; // no marketplace, so nothing to offer
    return this.serial(() => this.state());
  }

  act(action: PluginAction, target: string): Promise<PluginState> {
    return this.serial(async () => {
      const args = actionArgs(action, target);
      if (!args) throw new Error(`${QWEN_LABEL} installs extensions by their source; it has no marketplaces.`);
      if (target.trim() === '' || target.startsWith('-')) throw new Error('That is not an extension or a source.');
      const toggle = action === 'enable' || action === 'disable';
      const before = action === 'install' ? await readQwenExtensions(this.home) : [];
      const rulesBefore = toggle ? await this.enablementText() : undefined;
      const result = await this.run(args, { timeoutMs: CHANGE_TIMEOUT_MS, rootHome: toggle });
      if (result.code !== 0) throw new Error(failureMessage(result));
      const state = await this.state();
      if (action === 'install' && !state.installed.some((p) => !before.some((b) => b.id === p.id))) {
        // An install that asked for something and got no answer exits 0 too.
        throw new Error(`${QWEN_LABEL} installed nothing from ${target}: ${failureMessage(result)}`);
      }
      // A change that changes nothing — switching on what is on, an update
      // that found nothing new — must not retire the warm process the next
      // session would have used.
      const message = action === 'update' ? lastLine(result.stdout) : undefined;
      const unchanged = toggle
        ? (await this.enablementText()) === rulesBefore
        : action === 'update' && /already up to date/i.test(message ?? '');
      if (!unchanged) this.config.bump();
      return { ...state, ...(message ? { message } : {}) };
    });
  }

  private async state(): Promise<PluginState> {
    return { installed: await readQwenExtensions(this.home), toggles: true, installHint: INSTALL_HINT, installNote: INSTALL_NOTE };
  }

  private enablementText(): Promise<string | undefined> {
    return readFile(path.join(this.home, 'extensions', ENABLEMENT), 'utf8').catch(() => undefined);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }
}
