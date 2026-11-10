/**
 * Qwen Code's extensions as plugins: against the real CLI where the pinned
 * devDependency is installed (it skips, saying so, where it is not), and a
 * scripted CLI for what the real one cannot be made to do on demand.
 *
 * Facts checked against Qwen Code 0.27.1: an extension directory's
 * `qwen-extension.json` and `.qwen-extension-install.json`, a linked one's
 * manifest at its `source`, the enablement rules in
 * `extensions/extension-enablement.json`, a disable under the home directory
 * (`!$HOME/*`) leaving the extension loaded in a session outside it, and an
 * install without `--consent` and without stdin exiting 0 having installed
 * nothing.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundledQwenExecutable } from '../install';
import { enabledEverywhere, qwenCli, QwenPlugins, readQwenExtensions, type CliResult, type QwenCliRunner } from '../plugins';
import { QwenConfigVersion } from '../runtime';

let home: string;
let work: string;

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'codedeck-qwen-ext-'));
  home = path.join(work, 'home');
  mkdirSync(home);
});

afterEach(() => rmSync(work, { recursive: true, force: true }));

/** An extension's source directory, as `qwen extensions new … context`
 *  lays one out. */
function extensionSource(name: string, manifest: Record<string, unknown>): string {
  const dir = path.join(work, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'qwen-extension.json'), JSON.stringify({ name, ...manifest }));
  writeFileSync(path.join(dir, 'QWEN.md'), 'Context for every session.\n');
  return dir;
}

const rules = (name: string): unknown =>
  (JSON.parse(readFileSync(path.join(home, 'extensions', 'extension-enablement.json'), 'utf8')) as Record<string, { overrides?: unknown }>)[name]
    ?.overrides;

const entry = bundledQwenExecutable();

describe.skipIf(entry === null)('Qwen Code extensions through the real CLI', () => {
  const plugins = (config: QwenConfigVersion) => new QwenPlugins(home, qwenCli(async () => entry!, home, process.env), config);

  it('installs, switches off and on for every workspace, updates and uninstalls', async () => {
    const config = new QwenConfigVersion();
    const manager = plugins(config);
    const source = extensionSource('ctx-ext', {
      displayName: { en: 'Context Ext', zh: '上下文' },
      description: { en: 'Adds context to every session' },
      version: '1.0.0',
    });
    expect((await manager.list(false)).installed).toEqual([]);

    const installed = await manager.act('install', source);
    expect(installed).toMatchObject({ toggles: true, installHint: expect.any(String), installNote: expect.any(String) });
    expect(installed.installed).toEqual([
      { id: 'ctx-ext', name: 'Context Ext', version: '1.0.0', description: 'Adds context to every session', enabled: true },
    ]);
    expect(config.current).toBe(1);

    expect((await manager.act('disable', 'ctx-ext')).installed[0]?.enabled).toBe(false);
    // The rule covers every path (on Windows, the drive's), not only the home
    // directory's.
    const drive = path.parse(path.resolve(home)).root.replace(/\\/g, '/');
    expect(rules('ctx-ext')).toEqual([process.platform === 'win32' ? `!/${drive}*` : '!/*']);
    expect(config.current).toBe(2);
    // Switching off what is off leaves the warm process alone.
    await manager.act('disable', 'ctx-ext');
    expect(config.current).toBe(2);

    expect((await manager.act('enable', 'ctx-ext')).installed[0]?.enabled).toBe(true);
    expect(config.current).toBe(3);

    const updated = await manager.act('update', 'ctx-ext');
    expect(updated.message).toMatch(/already up to date/i);
    expect(config.current).toBe(3);

    expect((await manager.act('uninstall', 'ctx-ext')).installed).toEqual([]);
    expect(config.current).toBe(4);
  }, 120_000);

  it('refuses with the CLI’s own reason', async () => {
    const config = new QwenConfigVersion();
    await expect(plugins(config).act('install', path.join(work, 'missing'))).rejects.toThrow(/Install source not found/);
    await expect(plugins(config).act('disable', 'nope')).rejects.toThrow(/does not exist/);
    expect(config.current).toBe(0);
  }, 60_000);
});

describe('Qwen Code extensions, scripted', () => {
  const answering = (result: CliResult, calls: Parameters<QwenCliRunner>[] = []): QwenCliRunner =>
    async (...args) => {
      calls.push(args);
      return result;
    };

  it('fails an install that exited cleanly having installed nothing', async () => {
    const config = new QwenConfigVersion();
    const calls: Parameters<QwenCliRunner>[] = [];
    const manager = new QwenPlugins(home, answering({ code: 0, stdout: 'Do you want to continue? [Y/n]: ', stderr: '' }, calls), config);
    await expect(manager.act('install', 'https://github.com/acme/ext')).rejects.toThrow(/installed nothing/);
    expect(calls[0]?.[0]).toEqual(['extensions', 'install', 'https://github.com/acme/ext', '--consent']);
    expect(config.current).toBe(0);
  });

  it('runs only the switches with the home directory at the root', async () => {
    const calls: Parameters<QwenCliRunner>[] = [];
    const manager = new QwenPlugins(home, answering({ code: 0, stdout: '', stderr: '' }, calls), new QwenConfigVersion());
    await manager.act('disable', 'a');
    await manager.act('uninstall', 'a');
    expect(calls.map(([args, options]) => [args[1], options.rootHome])).toEqual([['disable', true], ['uninstall', false]]);
  });

  it('has no marketplaces, and takes no option for a target', async () => {
    const manager = new QwenPlugins(home, answering({ code: 0, stdout: '', stderr: '' }), new QwenConfigVersion());
    await expect(manager.act('add-marketplace', 'acme/market')).rejects.toThrow(/no marketplaces/);
    await expect(manager.act('install', '--scope=project')).rejects.toThrow(/not an extension/);
  });

  it('reads a linked extension’s manifest at its source, and skips a directory that is no extension', async () => {
    const source = extensionSource('linked-ext', { description: 'Linked', version: '0.1.0' });
    const dir = path.join(home, 'extensions');
    mkdirSync(path.join(dir, 'linked-ext'), { recursive: true });
    writeFileSync(path.join(dir, 'linked-ext', '.qwen-extension-install.json'), JSON.stringify({ source, type: 'link' }));
    mkdirSync(path.join(dir, 'stray'));
    writeFileSync(path.join(dir, 'extension-enablement.json'), JSON.stringify({ 'linked-ext': { overrides: ['!/*'] } }));
    expect(await readQwenExtensions(home)).toEqual([
      { id: 'linked-ext', name: 'linked-ext', version: '0.1.0', description: 'Linked', enabled: false },
    ]);
  });

  it('takes the last rule over every path as the switch, ignoring narrower ones', () => {
    expect(enabledEverywhere(undefined)).toBe(true);
    expect(enabledEverywhere(['!/*'])).toBe(false);
    expect(enabledEverywhere(['!/*', '/*'])).toBe(true);
    // The terminal's own disable covers the home directory only.
    expect(enabledEverywhere(['/*', '!/home/me/*'])).toBe(true);
    // Windows: a drive root, as Qwen Code writes it.
    expect(enabledEverywhere(['!/D:/*'])).toBe(false);
    expect(enabledEverywhere(['/*', '!/D:/Users/me/*'])).toBe(true);
  });
});
