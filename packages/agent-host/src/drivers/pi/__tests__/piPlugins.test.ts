/**
 * Pi's packages as the phone's plugins. Install, update and uninstall run
 * the pinned Pi's own commands on a local package (no network), so what is
 * checked is what Pi itself records; the parsing and refusals run alone.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundledPiExecutable } from '../install';
import { PiPlugins, piCliRunner, piPackageSources, piPlugin } from '../plugins';

const piPath = bundledPiExecutable();
const real = piPath ? it : it.skip;

function localPackage(root: string): string {
  const dir = path.join(root, 'my-pi-package');
  mkdirSync(path.join(dir, 'prompts'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'my-pi-package', version: '1.2.3', keywords: ['pi-package'] }));
  writeFileSync(path.join(dir, 'prompts', 'hello.md'), 'Say hello');
  return dir;
}

describe('PiPlugins', () => {
  real(
    'installs, updates and uninstalls through Pi’s own commands, and lists what Pi recorded',
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'codedeck-pi-plugins-'));
      const home = path.join(root, 'home');
      mkdirSync(home);
      const pkg = localPackage(root);
      const plugins = new PiPlugins(
        home,
        piCliRunner({ entryPoint: async () => piPath!, home, env: () => ({ ...process.env, PI_CODING_AGENT_DIR: home }) as Record<string, string> }),
      );

      const installed = await plugins.act('install', pkg);
      // Pi records a local path relative to its settings file; the plugin's
      // id is that record, which uninstall then resolves from Pi's home.
      expect(installed.installed).toEqual([expect.objectContaining({ name: 'my-pi-package', enabled: true })]);
      expect(installed.toggles).toBe(false);

      const updated = await plugins.act('update', installed.installed[0]!.id);
      expect(updated.message).toMatch(/already up to date/);

      expect((await plugins.act('uninstall', installed.installed[0]!.id)).installed).toEqual([]);
    },
    120_000,
  );

  it('explains a missing npm instead of Pi’s spawn error', async () => {
    const plugins = new PiPlugins(mkdtempSync(path.join(tmpdir(), 'codedeck-pi-plugins-')), async () => ({
      code: 1,
      stdout: 'Installing npm:some-package...\n',
      stderr: 'Error: spawn npm ENOENT\n',
    }));
    await expect(plugins.act('install', 'npm:some-package')).rejects.toThrow(/npm, which is not on this machine/);
  });

  it('refuses a switch, a marketplace, and a source that would read as an option, without running Pi', async () => {
    const ran: string[][] = [];
    const plugins = new PiPlugins(mkdtempSync(path.join(tmpdir(), 'codedeck-pi-plugins-')), async (args) => {
      ran.push(args);
      return { code: 0, stdout: '', stderr: '' };
    });
    await expect(plugins.act('disable', 'npm:x')).rejects.toThrow(/cannot be switched off/);
    await expect(plugins.act('add-marketplace', 'x')).rejects.toThrow(/not from marketplaces/);
    await expect(plugins.act('install', '--local')).rejects.toThrow(/not a package source/);
    expect(ran).toEqual([]);
  });

  it('reads the sources Pi keeps, as strings or filtered entries', () => {
    expect(
      piPackageSources({ packages: ['npm:@scope/tool@1.0.0', { source: 'git:github.com/me/pkg@v2', skills: [] }, 42, { other: 1 }] }),
    ).toEqual(['npm:@scope/tool@1.0.0', 'git:github.com/me/pkg@v2']);
    expect(piPlugin('npm:@scope/tool@1.0.0')).toEqual({ id: 'npm:@scope/tool@1.0.0', name: '@scope/tool', version: '1.0.0', enabled: true });
    expect(piPlugin('git:github.com/me/pkg@v2')).toEqual({ id: 'git:github.com/me/pkg@v2', name: 'github.com/me/pkg', version: 'v2', enabled: true });
    expect(piPlugin('..\\my-pkg').name).toBe('my-pkg');
    expect(piPlugin('../packages/my-pkg/').name).toBe('my-pkg');
  });
});
