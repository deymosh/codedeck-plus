/**
 * The harness's plugins: npm packages installed into a profile and mounted as
 * patch layers. The harness's own CLI does the installing (its pnpm, its
 * locks, its compatibility gate), so what is faked here is that CLI — and the
 * cases are the ones its output decides.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConfigVersion } from '../../../acp/runtime';
import { DeepSeekPlugins, runDshPlugin, type DshRun } from '../plugins';
import type { SpawnFn } from '../runtime';

/** A profile directory: its manifest, and whatever it has installed. */
function profile(
  manifest: Record<string, unknown> = { name: 'dsh-profile-acp', private: true, dependencies: {} },
  packages: Record<string, Record<string, unknown>> = {},
): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'codedeck-dsh-plugins-'));
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [name, pkg] of Object.entries(packages)) {
    const target = path.join(dir, 'node_modules', ...name.split('/'));
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'package.json'), JSON.stringify(pkg));
  }
  return dir;
}

const bundles = (...names: string[]): Record<string, unknown> => ({
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app', ...names] } },
});

const pluginPackage = (version: string, bundle = true): Record<string, unknown> => ({
  name: 'demo-plugin',
  version,
  ...(bundle ? { dsh: { bundle: {} } } : {}),
});

interface Harness {
  plugins: DeepSeekPlugins;
  runs: string[][];
  /** The configuration version the manager bumps on a change. */
  config: ConfigVersion;
  manifest(): { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } };
}

/** A plugin manager whose CLI answers are scripted by `behaviour`. */
function withPlugins(
  dir: string,
  behaviour: (args: string[]) => DshRun | Promise<DshRun> = () => ({ code: 0, stdout: '', stderr: '' }),
): Harness {
  const runs: string[][] = [];
  const config = new ConfigVersion();
  const plugins = new DeepSeekPlugins({
    profileDir: dir,
    config,
    run: async (args) => {
      runs.push(args);
      return behaviour(args);
    },
    log: () => {},
  });
  return { plugins, runs, config, manifest: () => JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) };
}

describe('listing', () => {
  it('answers nothing for a profile nobody has touched', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codedeck-dsh-plugins-'));
    expect(await withPlugins(dir).plugins.list(false)).toMatchObject({ installed: [], toggles: true, installHint: 'npm package name' });
  });

  it('shows what is installed, and which of it is a layer', async () => {
    const dir = profile(
      { ...bundles('demo-plugin'), dependencies: { 'demo-plugin': '1.2.3', 'plain-dep': '2.0.0' } },
      { 'demo-plugin': pluginPackage('1.2.3'), 'plain-dep': { name: 'plain-dep', version: '2.0.0' } },
    );
    const state = await withPlugins(dir).plugins.list(true);
    expect(state.installed).toEqual([
      { id: '@deepseek-ai/dsh-acp-app', name: '@deepseek-ai/dsh-acp-app', version: undefined, enabled: true },
      { id: '@deepseek-ai/dsh-base', name: '@deepseek-ai/dsh-base', version: undefined, enabled: true },
      { id: 'demo-plugin', name: 'demo-plugin', version: '1.2.3', enabled: true },
      { id: 'plain-dep', name: 'plain-dep', version: '2.0.0', enabled: false },
    ]);
    // The harness installs plugins from npm; it has no marketplaces to ask.
    expect(state.marketplaces).toBeUndefined();
    expect(state.available).toBeUndefined();
  });
});

describe('installing and removing', () => {
  it('installs through the harness’s own command and says what it did', async () => {
    const dir = profile();
    const harness = withPlugins(dir, () => ({
      code: 0,
      stdout: 'Packages: +1\nDone in 1.1s using pnpm v10.8.0\n',
      stderr: 'dsh: warning: demo-plugin declares no dsh.bundle — installed as a plain dependency, not a profile layer\n',
    }));
    const state = await harness.plugins.act('install', 'demo-plugin');
    expect(harness.runs).toEqual([['add', 'demo-plugin']]);
    expect(state.message).toMatch(/declares no dsh\.bundle/);
  });

  it('refuses a target that is not a package name, without asking the CLI', async () => {
    const dir = profile();
    const harness = withPlugins(dir);
    await expect(harness.plugins.act('install', 'not a package; rm -rf /')).rejects.toThrow(/not a package name/);
    expect(harness.runs).toEqual([]);
  });

  it('reports what the harness printed when the command fails', async () => {
    const dir = profile();
    const harness = withPlugins(dir, () => ({
      code: 1,
      stdout: '',
      stderr: 'dsh: installation rejected: Plugin demo-plugin@0.0.1 is incompatible with dsh 0.2.0-rc.2\n',
    }));
    await expect(harness.plugins.act('install', 'demo-plugin')).rejects.toThrow(/incompatible with dsh/);
  });

  it('removes and updates with the harness’s own commands', async () => {
    const dir = profile({ ...bundles(), dependencies: { 'demo-plugin': '^1.0.0' } }, { 'demo-plugin': pluginPackage('1.0.0') });
    const harness = withPlugins(dir);
    await harness.plugins.act('uninstall', 'demo-plugin');
    await harness.plugins.act('update', 'demo-plugin');
    expect(harness.runs).toEqual([
      ['remove', 'demo-plugin'],
      ['update', 'demo-plugin'],
    ]);
  });

  it('refuses a plugin the profile does not have', async () => {
    const dir = profile();
    const harness = withPlugins(dir);
    await expect(harness.plugins.act('uninstall', 'ghost')).rejects.toThrow(/profile has no plugin 'ghost'/);
    expect(harness.runs).toEqual([]);
  });

  it('refuses the profile’s own composition', async () => {
    const dir = profile();
    const harness = withPlugins(dir);
    await expect(harness.plugins.act('uninstall', '@deepseek-ai/dsh-base')).rejects.toThrow(/profile's own composition/);
    await expect(harness.plugins.act('install', '@deepseek-ai/dsh-acp-app')).rejects.toThrow(/already installed/);
    expect(harness.runs).toEqual([]);
  });

  it('has no marketplaces to act on', async () => {
    const dir = profile();
    const harness = withPlugins(dir);
    await expect(harness.plugins.act('add-marketplace', 'owner/repo')).rejects.toThrow(/no plugin marketplaces/);
    await expect(harness.plugins.act('remove-marketplace', 'acme')).rejects.toThrow(/no plugin marketplaces/);
    await expect(harness.plugins.act('update-marketplace', 'acme')).rejects.toThrow(/no plugin marketplaces/);
  });
});

describe('switching a plugin off', () => {
  it('takes its layer out and leaves it installed', async () => {
    const dir = profile({ ...bundles('demo-plugin'), dependencies: { 'demo-plugin': '1.0.0' } }, { 'demo-plugin': pluginPackage('1.0.0') });
    const harness = withPlugins(dir);
    const disabled = await harness.plugins.act('disable', 'demo-plugin');
    expect(disabled.installed).toEqual([
      { id: '@deepseek-ai/dsh-acp-app', name: '@deepseek-ai/dsh-acp-app', version: undefined, enabled: true },
      { id: '@deepseek-ai/dsh-base', name: '@deepseek-ai/dsh-base', version: undefined, enabled: true },
      { id: 'demo-plugin', name: 'demo-plugin', version: '1.0.0', enabled: false },
    ]);
    expect(harness.manifest().dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app']);
    expect(harness.runs).toEqual([]);

    // Switched back on, it goes last: the layers are an ordered stack.
    const enabled = await harness.plugins.act('enable', 'demo-plugin');
    expect(enabled.installed.find((plugin) => plugin.name === 'demo-plugin')?.enabled).toBe(true);
    expect(harness.manifest().dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app', 'demo-plugin']);
  });

  it('refuses a plugin that is not installed, or is no layer', async () => {
    const dir = profile(
      { ...bundles(), dependencies: { 'plain-dep': '1.0.0' } },
      { 'plain-dep': { name: 'plain-dep', version: '1.0.0' } },
    );
    const harness = withPlugins(dir);
    await expect(harness.plugins.act('enable', 'ghost')).rejects.toThrow(/install it first/);
    await expect(harness.plugins.act('enable', 'plain-dep')).rejects.toThrow(/declares no dsh\.bundle/);
  });

  it('refuses to switch off the profile’s own composition', async () => {
    const dir = profile(bundles());
    const harness = withPlugins(dir);
    await expect(harness.plugins.act('disable', '@deepseek-ai/dsh-base')).rejects.toThrow(/cannot be switched off/);
  });
});

describe('the configuration version', () => {
  // A harness composes its layers once, as it boots: a change is what makes
  // the next session need a fresh process, and nothing else may.
  it('counts a layer switched on or off, and not one already so', async () => {
    const dir = profile({ ...bundles(), dependencies: { 'demo-plugin': '1.0.0' } }, { 'demo-plugin': pluginPackage('1.0.0') });
    const harness = withPlugins(dir);
    await harness.plugins.act('enable', 'demo-plugin');
    expect(harness.config.current).toBe(1);
    await harness.plugins.act('enable', 'demo-plugin');
    expect(harness.config.current).toBe(1);
    await harness.plugins.act('disable', 'demo-plugin');
    expect(harness.config.current).toBe(2);
  });

  it('counts a command that changed what is installed, and not one that found nothing to do', async () => {
    const dir = profile({ ...bundles(), dependencies: { 'demo-plugin': '1.0.0' } }, { 'demo-plugin': pluginPackage('1.0.0') });
    // An update that left everything where it was.
    const harness = withPlugins(dir, (args) => {
      if (args[0] === 'remove') writeFileSync(path.join(dir, 'package.json'), JSON.stringify(bundles()));
      return { code: 0, stdout: '', stderr: '' };
    });
    await harness.plugins.act('update', 'demo-plugin');
    expect(harness.config.current).toBe(0);
    await harness.plugins.act('uninstall', 'demo-plugin');
    expect(harness.config.current).toBe(1);
  });

  it('counts an update that moved a plugin to another version', async () => {
    const dir = profile({ ...bundles(), dependencies: { 'demo-plugin': '^1.0.0' } }, { 'demo-plugin': pluginPackage('1.0.0') });
    const harness = withPlugins(dir, () => {
      writeFileSync(path.join(dir, 'node_modules', 'demo-plugin', 'package.json'), JSON.stringify(pluginPackage('1.1.0')));
      return { code: 0, stdout: '', stderr: '' };
    });
    await harness.plugins.act('update', 'demo-plugin');
    expect(harness.config.current).toBe(1);
  });

  it('counts nothing for a command the harness refused', async () => {
    const dir = profile();
    const harness = withPlugins(dir, () => ({ code: 1, stdout: '', stderr: 'dsh: no such package\n' }));
    await expect(harness.plugins.act('install', 'demo-plugin')).rejects.toThrow(/no such package/);
    expect(harness.config.current).toBe(0);
  });

  it('counts a failed command that still changed what is installed', async () => {
    const dir = profile({ ...bundles(), dependencies: { 'demo-plugin': '1.0.0' } }, { 'demo-plugin': pluginPackage('1.0.0') });
    const harness = withPlugins(dir, () => {
      // The removal got as far as the manifest before the command failed.
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify(bundles()));
      return { code: 1, stdout: '', stderr: 'ERR_PNPM_LINKING interrupted\n' };
    });
    await expect(harness.plugins.act('uninstall', 'demo-plugin')).rejects.toThrow(/interrupted/);
    expect(harness.config.current).toBe(1);
  });
});

describe('runDshPlugin', () => {
  class FakeChild extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    killed: string[] = [];
    kill(signal: string): boolean {
      this.killed.push(signal);
      return true;
    }
  }

  it('runs the harness CLI with the profile, the pnpm arguments and the sessions\' home', async () => {
    const child = new FakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
    const pending = runDshPlugin('/tree/dsh/lib/bin.js', '/data/dsh', 'acp', ['add', 'demo'], spawnFn);
    expect(spawnFn).toHaveBeenCalledWith(
      process.execPath,
      ['/tree/dsh/lib/bin.js', 'plugin', '--profile', 'acp', 'add', 'demo'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'], env: expect.objectContaining({ DSH_HOME: '/data/dsh' }) }),
    );
    child.stdout.emit('data', Buffer.from('installed\n'));
    child.stderr.emit('data', Buffer.from('a warning\n'));
    child.emit('close', 0);
    expect(await pending).toEqual({ code: 0, stdout: 'installed\n', stderr: 'a warning\n' });
  });

  it('answers a failure the CLI could not even start', async () => {
    const child = new FakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
    const pending = runDshPlugin('/tree/dsh/lib/bin.js', '/data/dsh', 'acp', ['add', 'demo'], spawnFn);
    child.emit('error', new Error('ENOENT'));
    await expect(pending).rejects.toThrow(/ENOENT/);
  });
});
