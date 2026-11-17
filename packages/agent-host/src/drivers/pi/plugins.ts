/**
 * Pi's packages, as the phone's plugins: changed through Pi's own package
 * commands (`pi install|remove|update <source>`, verified without a
 * terminal on 1.5.2: none of them asks anything) and listed from the
 * `packages` array of `settings.json` in Pi's home, which those commands
 * keep and which every Pi session on that home loads.
 *
 * A package bundles extensions, skills, prompt templates and themes, and is
 * how Pi gains what it does not ship — subagents, LSP diagnostics, other
 * tools — so this is where those come from rather than from CodeDeck.
 *
 * - A source is what Pi takes: `npm:<package>[@version]`, `git:<host/repo>`
 *   (or a URL), or a local path. Pi stores a local path relative to its
 *   settings file, so the commands run in Pi's home, where that relative
 *   path resolves to the same directory.
 * - An npm source needs `npm` (Pi runs it): the container image has one,
 *   a release archive does not. The bridge's own registry mirror
 *   (`CODEDECK_NPM_REGISTRY`) is passed on to it.
 * - Pi has no switch to turn a package off other than rewriting its
 *   resource filters, which would discard the user's own: no toggles.
 * - A Pi process loads its packages as its session starts: a change reaches
 *   the sessions started after it.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { PluginManager, PluginState } from '../../sdk/driver';
import type { InstalledPlugin, PluginAction } from '../../sdk/types';
import { piCommand } from './runtime';

export interface PiCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs Pi's CLI with these arguments, in Pi's home. */
export type PiCliRunner = (args: string[], timeoutMs: number) => Promise<PiCliResult>;

/** Installing clones a repository or fetches a package and its dependencies. */
const CHANGE_TIMEOUT_MS = 10 * 60_000;

const INSTALL_HINT = 'npm:package, git:github.com/owner/repo, a URL or a path';
const INSTALL_NOTE =
  'Pi packages add extensions, skills, prompt templates and themes to every Pi session on this machine, ' +
  'from npm, git or a path; sessions started after a change load it. A package runs code with your ' +
  'permissions: install only ones you trust. An npm package needs npm on the machine.';

/** The sources in Pi's settings, as Pi wrote them. */
export function piPackageSources(settings: Record<string, unknown>): string[] {
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  return packages.flatMap((entry): string[] => {
    if (typeof entry === 'string') return entry.trim() ? [entry] : [];
    const source = (entry as { source?: unknown } | null)?.source;
    return typeof source === 'string' && source.trim() ? [source] : [];
  });
}

/** One package as the phone lists it: its source is its id. */
export function piPlugin(source: string): InstalledPlugin {
  const npm = /^npm:((?:@[^/@]+\/)?[^@]+)(?:@(.+))?$/.exec(source);
  if (npm) return { id: source, name: npm[1]!, ...(npm[2] ? { version: npm[2] } : {}), enabled: true };
  const git = /^(?:git:|https?:\/\/)(.+?)(?:\.git)?(?:@([^@/]+))?$/.exec(source);
  if (git) return { id: source, name: git[1]!.replace(/\/+$/, ''), ...(git[2] ? { version: git[2] } : {}), enabled: true };
  // Split on both separators, not `path.basename`'s own: Pi on Windows
  // records `..\\pkg`, and the name must not depend on the bridge's OS.
  const last = source.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return { id: source, name: last || source, enabled: true };
}

export class PiPlugins implements PluginManager {
  constructor(
    private readonly home: string,
    private readonly run: PiCliRunner,
  ) {}

  async list(): Promise<PluginState> {
    return {
      installed: piPackageSources(await this.settings()).map(piPlugin),
      toggles: false,
      installHint: INSTALL_HINT,
      installNote: INSTALL_NOTE,
    };
  }

  async act(action: PluginAction, target: string): Promise<PluginState> {
    const source = target.trim();
    if (source === '') throw new Error('Name the package to change.');
    const command = action === 'install' ? 'install' : action === 'uninstall' ? 'remove' : action === 'update' ? 'update' : undefined;
    if (command === undefined) {
      throw new Error(
        action === 'enable' || action === 'disable'
          ? 'Pi packages cannot be switched off; uninstall one instead.'
          : 'Pi installs packages by source, not from marketplaces.',
      );
    }
    // A leading dash would read as one of Pi's options, not a source.
    if (source.startsWith('-')) throw new Error(`'${source}' is not a package source.`);
    const result = await this.run([command, source], CHANGE_TIMEOUT_MS);
    if (result.code !== 0) throw new Error(failureOf(result));
    const state = await this.list();
    const said = lastLine(result.stdout);
    return { ...state, ...(said ? { message: said } : {}) };
  }

  private async settings(): Promise<Record<string, unknown>> {
    try {
      const parsed = JSON.parse(await readFile(path.join(this.home, 'settings.json'), 'utf8')) as unknown;
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
}

/** What went wrong, in Pi's words where it said any. Pi runs `npm` for an
 *  npm source and its absence surfaces as a spawn error, phrased here. */
function failureOf(result: PiCliResult): string {
  const text = `${result.stderr}\n${result.stdout}`;
  if (/spawn npm ENOENT/.test(text)) {
    return 'Pi installs npm packages with npm, which is not on this machine. A git: source or a path needs no npm.';
  }
  return lastLine(result.stderr) ?? lastLine(result.stdout) ?? `Pi exited with ${result.code}`;
}

function lastLine(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1];
}

/** The production runner: Pi's CLI, never through a shell, in Pi's home. */
export function piCliRunner(options: {
  entryPoint: () => Promise<string>;
  home: string;
  env: () => Record<string, string>;
}): PiCliRunner {
  return async (args, timeoutMs) => {
    const command = piCommand(await options.entryPoint(), args);
    return new Promise<PiCliResult>((resolve) => {
      const child = spawn(command.command, command.args, { cwd: options.home, env: options.env(), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = (stdout + chunk.toString()).slice(-20_000);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-20_000);
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      timer.unref?.();
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ code: 1, stdout, stderr: `${stderr}\n${error.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr: code === null ? `${stderr}\nPi did not finish in time` : stderr });
      });
    });
  };
}
