/**
 * The DeepSeek Harness's plugins: npm packages installed into a profile and
 * mounted as patch layers.
 *
 * A profile is a directory with a `package.json` and a `cordis.yml`; its
 * `dsh.profile.bundles` list is the ordered stack of layers it composes, and
 * `dsh plugin --profile <name> <pnpm args>` forwards to pnpm in that
 * directory. Installing a package that declares a `dsh.bundle` adds it to the
 * bundles list — it becomes a layer from then on. A package that declares
 * none is installed as a plain dependency (the harness says so itself), which
 * is why this manager shows what is installed and which of it is a layer.
 *
 * There are no marketplaces: a plugin is an npm package. Switching one off
 * means taking it out of the bundles list, which is exactly what the list
 * means — the package stays installed, so it can be switched back on. The
 * profile's own composition (the shared core and the ACP application) is
 * never touched: switching it off would leave a harness that cannot run.
 *
 * The commands run through the harness's own CLI, so its pnpm, its locks and
 * its version-compatibility gate are the ones that apply, and a failure is
 * whatever it printed.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { PluginManager, PluginState } from '../../driver';
import type { InstalledPlugin, PluginAction } from '../../types';
import { dshCommand, type SpawnFn } from './runtime';

/** The layers a profile composes without any plugin: the shared core and the
 *  ACP application. */
const SHIPPED_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'];

/** How long one `dsh plugin` run may take (a pnpm install, or a registry
 *  lookup before it). */
const RUN_TIMEOUT_MS = 300_000;

/** An npm package name, optionally versioned — the shape pnpm's `add` takes.
 *  Deliberately plain: a version may be a number (`1.2.3`) or a tag
 *  (`latest`), not a range or anything a shell would read as syntax. */
const PACKAGE_SPEC = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.-]+)?$/i;

export interface DshRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `dsh plugin --profile <profile> <args>` in the harness home `home` and
 * answer with its output. The home is set as the sessions' processes have it
 * set: without it the CLI works on the profile of the default home, which
 * is not the one any session runs.
 */
export function runDshPlugin(
  entry: string,
  home: string,
  profile: string,
  args: string[],
  spawnFn: SpawnFn = spawn,
): Promise<DshRun> {
  const command = dshCommand(entry, ['plugin', '--profile', profile, ...args]);
  return new Promise((resolve, reject) => {
    const child = spawnFn(command.command, command.args, {
      env: { ...process.env, DSH_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the harness's plugin command did not finish within ${RUN_TIMEOUT_MS / 1000}s`));
    }, RUN_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export interface DeepSeekPluginsOptions {
  /** The profile directory (`$DSH_HOME/profiles/acp`). */
  profileDir: string;
  /** Run one `dsh plugin` invocation (runDshPlugin, bound to the runtime's
   *  entry point by the driver). */
  run: (args: string[]) => Promise<DshRun>;
  /** The runtime's own packages directory, for the versions of the bundles a
   *  profile does not install itself (the harness ships them). */
  packagesDir?: () => Promise<string | undefined>;
  log: (message: string) => void;
}

/** A profile's `package.json`, as far as a plugin manager cares. */
interface Manifest {
  dependencies?: Record<string, string>;
  dsh?: { profile?: { bundles?: string[] } };
}

export class DeepSeekPlugins implements PluginManager {
  private message: string | undefined;
  /** One change at a time: each may rewrite the manifest. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: DeepSeekPluginsOptions) {}

  list(available: boolean): Promise<PluginState> {
    void available; // No marketplaces to ask about.
    return this.serial(async () => this.state(await this.manifest(), undefined));
  }

  act(action: PluginAction, target: string): Promise<PluginState> {
    return this.serial(async () => {
      if (action === 'add-marketplace' || action === 'remove-marketplace' || action === 'update-marketplace') {
        throw new Error('The DeepSeek Harness installs plugins from npm by package name; it has no plugin marketplaces.');
      }
      if (action === 'install' && !PACKAGE_SPEC.test(target)) {
        throw new Error(`'${target}' is not a package name — give an npm package, optionally with a version ('name@1.2.3').`);
      }
      const manifest = await this.manifest();
      const bundles = manifest.dsh?.profile?.bundles ?? [];
      const dependencies = manifest.dependencies ?? {};

      if (action === 'enable' || action === 'disable') {
        const next = await this.setBundle(manifest, bundles, action, target, dependencies);
        return this.state(next, action === 'enable' ? `Enabled ${target}.` : `Disabled ${target}.`);
      }

      // The profile's own composition first: it is not in its dependency list
      // (the CLI keeps it in the bundles list), and the reason matters more
      // than the lookup.
      if (action === 'install' && SHIPPED_BUNDLES.includes(target)) {
        throw new Error(`${target} is part of the profile's own composition; it is already installed.`);
      }
      if (action === 'uninstall' && SHIPPED_BUNDLES.includes(target)) {
        throw new Error(
          `${target} is part of the profile's own composition — the harness does not run without it, so it is not removed from here.`,
        );
      }
      const installed = Object.prototype.hasOwnProperty.call(dependencies, target);
      if (action !== 'install' && !installed) throw new Error(`The DeepSeek Harness profile has no plugin '${target}'.`);
      const args = action === 'install' ? ['add', target] : action === 'uninstall' ? ['remove', target] : ['update', target];
      const run = await this.options.run(args);
      const output = lastLines(`${run.stdout}\n${run.stderr}`);
      if (run.code !== 0) throw new Error(`The harness refused the plugin command: ${output || `exit code ${run.code}`}`);
      this.options.log(`[deepseek] dsh plugin ${args.join(' ')}: ${output}`);
      return this.state(await this.manifest(), output);
    });
  }

  /** Switch one bundle on or off by editing the profile's layer list — the
   *  list dsh itself keeps and the profile's `cordis.yml` points at. */
  private async setBundle(
    manifest: Manifest,
    bundles: string[],
    action: 'enable' | 'disable',
    target: string,
    dependencies: Record<string, string>,
  ): Promise<Manifest> {
    if (SHIPPED_BUNDLES.includes(target)) {
      throw new Error(`${target} is part of the profile's own composition and cannot be switched off.`);
    }
    const present = bundles.includes(target);
    if (action === 'enable' && present) return manifest;
    if (action === 'disable' && !present) return manifest;
    if (action === 'enable') {
      if (!Object.prototype.hasOwnProperty.call(dependencies, target)) {
        throw new Error(`The DeepSeek Harness profile has no plugin '${target}' — install it first.`);
      }
      if (!(await this.declaresBundle(target))) {
        throw new Error(
          `${target} declares no dsh.bundle, so it cannot be a profile layer — the harness installed it as a plain ` +
            'dependency. Plugins that add a layer are packages whose own manifest declares one.',
        );
      }
    }
    // The list is an ordered stack: a re-enabled plugin goes last, after
    // everything already composed.
    const next = action === 'enable' ? [...bundles, target] : bundles.filter((name) => name !== target);
    const updated: Manifest = { ...manifest, dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: next } } };
    await this.writeManifest(updated);
    return updated;
  }

  /** Whether a package in the profile's own node_modules declares a bundle
   *  (i.e. it ships a patch layer rather than a plain module). */
  private async declaresBundle(name: string): Promise<boolean> {
    try {
      const text = await readFile(path.join(this.options.profileDir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8');
      const manifest = JSON.parse(text) as { dsh?: { bundle?: unknown } };
      return typeof manifest.dsh?.bundle === 'object' && manifest.dsh.bundle !== null;
    } catch {
      return false;
    }
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private async manifest(): Promise<Manifest> {
    try {
      const text = await readFile(this.manifestPath(), 'utf8');
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Manifest) : {};
    } catch {
      // A profile nobody has initialized yet has no manifest: it composes its
      // own bundles and nothing else.
      return {};
    }
  }

  private manifestPath(): string {
    return path.join(this.options.profileDir, 'package.json');
  }

  private async writeManifest(manifest: Manifest): Promise<void> {
    const file = this.manifestPath();
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.codedeck-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(temporary, file);
    this.options.log(`[deepseek] profile layers updated in ${file}`);
  }

  private async state(manifest: Manifest, message: string | undefined): Promise<PluginState> {
    const bundles = manifest.dsh?.profile?.bundles ?? [];
    const dependencies = manifest.dependencies ?? {};
    const names = [...new Set([...bundles, ...Object.keys(dependencies)])].sort();
    const installed: InstalledPlugin[] = [];
    for (const name of names) {
      installed.push({
        id: name,
        name,
        version: await this.versionOf(name),
        enabled: bundles.includes(name),
      });
    }
    if (message !== undefined) this.message = message;
    return { installed, toggles: true, ...(this.message !== undefined ? { message: this.message } : {}) };
  }

  /**
   * The version a plugin is at: the profile's own copy when it has one (what
   * a user installed), else the harness's — a profile composes the bundles
   * the harness ships without copying them in, so their version lives in the
   * runtime's tree. A plugin that shows no version is one neither has.
   */
  private async versionOf(name: string): Promise<string | undefined> {
    const shipped = await this.options.packagesDir?.();
    const roots = [path.join(this.options.profileDir, 'node_modules'), ...(shipped === undefined ? [] : [shipped])];
    for (const root of roots) {
      try {
        const text = await readFile(path.join(root, ...name.split('/'), 'package.json'), 'utf8');
        const manifest = JSON.parse(text) as { version?: unknown };
        if (typeof manifest.version === 'string') return manifest.version;
      } catch {
        // Not here; the next root may have it.
      }
    }
    return undefined;
  }
}

/** The last few non-empty lines of a command's output — what says what
 *  happened, rather than a whole pnpm progress log. */
function lastLines(output: string, count = 3): string {
  const lines = output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '');
  return lines.slice(-count).join('\n');
}
