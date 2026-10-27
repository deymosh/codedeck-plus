import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenCodePlugins, toInstalledPlugin } from '../plugins';
import { fakeOpenCode, type FakePlugin } from './fakeServer';

/** A server over one global config file: v2's config API cannot write the
 *  plugin list, so the file is the store and `plugin.list` is what the server
 *  reports as loaded. */
async function server(plugins: unknown[], loaded?: FakePlugin[]) {
  const dir = await mkdtemp(path.join(tmpdir(), 'oc-plugins-'));
  const file = path.join(dir, 'opencode.json');
  await writeFile(file, JSON.stringify({ plugins }));
  const fake = fakeOpenCode({ pluginConfig: plugins as Array<string | { package?: string }>, ...(loaded ? { plugins: loaded } : {}) });
  const manager = new OpenCodePlugins(async () => fake.client, () => [file]);
  const written = async () => JSON.parse(await readFile(file, 'utf8')) as { plugins: unknown[] };
  return { manager, written, client: fake.client, server: fake, dir, file };
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('OpenCode plugins', () => {
  it('lists the packages its global config names, with their pinned version', async () => {
    const { manager, dir } = await server(['opencode-wakatime', { package: '@acme/oc-plugin@1.2.0', options: { key: 'x' } }, '-off-plugin']);
    dirs.push(dir);
    expect(await manager.list()).toEqual({
      installed: [
        { id: 'opencode-wakatime', name: 'opencode-wakatime', enabled: true },
        { id: '@acme/oc-plugin@1.2.0', name: '@acme/oc-plugin', version: '1.2.0', enabled: true },
        { id: 'off-plugin', name: 'off-plugin', enabled: false },
      ],
      toggles: true,
    });
    expect(toInstalledPlugin('@acme/oc-plugin')).toEqual({ id: '@acme/oc-plugin', name: '@acme/oc-plugin', enabled: true });
  });

  it('reports a plugin the server could not load as failed', async () => {
    // 2.1.4 names a package plugin by `source.target`, not by an `id`.
    const { manager, dir } = await server(
      ['@acme/oc-plugin'],
      [{ source: { type: 'package', target: '@acme/oc-plugin' }, state: { status: 'failed', error: 'boom', ref: 'err_1' } }],
    );
    dirs.push(dir);
    const state = await manager.list();
    expect(state.installed[0]).toMatchObject({ id: '@acme/oc-plugin', enabled: false, error: 'boom' });
  });

  it('installs and uninstalls by rewriting that list, keeping the other entries whole', async () => {
    const { manager, written, dir } = await server([{ package: '@acme/oc-plugin', options: { key: 'x' } }]);
    dirs.push(dir);
    const state = await manager.act('install', 'opencode-wakatime@latest');
    expect(state.installed.map((p) => p.id)).toEqual(['@acme/oc-plugin', 'opencode-wakatime@latest']);
    expect((await written()).plugins).toEqual([{ package: '@acme/oc-plugin', options: { key: 'x' } }, 'opencode-wakatime@latest']);
    await manager.act('uninstall', '@acme/oc-plugin');
    expect((await written()).plugins).toEqual(['opencode-wakatime@latest']);
  });

  it('installs into an opencode.jsonc in place, keeping its comments', async () => {
    // OpenCode's own tools may leave the global config as JSONC; it is
    // edited as OpenCode edits it, not refused and not rewritten.
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-plugins-'));
    dirs.push(dir);
    const file = path.join(dir, 'opencode.jsonc');
    await writeFile(file, '{\n  // the owner\'s note\n  "plugins": ["opencode-wakatime",],\n}\n');
    const manager = new OpenCodePlugins(async () => fakeOpenCode().client, () => [file]);
    const state = await manager.act('install', 'x-plugin');
    expect(state.installed.map((p) => p.id)).toEqual(['opencode-wakatime', 'x-plugin']);
    expect(await readFile(file, 'utf8')).toContain("// the owner's note");
  });

  it('edits the file that holds the plugins list, not the first file', async () => {
    // A later config file overrides an earlier one, so writing the list to
    // the first file would change nothing behind the one holding it.
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-plugins-'));
    dirs.push(dir);
    const files = ['config.json', 'opencode.json', 'opencode.jsonc'].map((f) => path.join(dir, f));
    await writeFile(files[0]!, JSON.stringify({ theme: 'dark' }));
    await writeFile(files[1]!, JSON.stringify({ plugins: ['opencode-wakatime'] }));
    const manager = new OpenCodePlugins(async () => fakeOpenCode().client, () => files);
    const state = await manager.act('install', 'x-plugin');
    expect(state.installed.map((p) => p.id)).toEqual(['opencode-wakatime', 'x-plugin']);
    expect(JSON.parse(await readFile(files[1]!, 'utf8')).plugins).toEqual(['opencode-wakatime', 'x-plugin']);
    expect(JSON.parse(await readFile(files[0]!, 'utf8'))).toEqual({ theme: 'dark' });

    // No list anywhere: a new one goes where OpenCode's own edit would put
    // it, not into the first file, which the new file then overrides.
    const dir2 = await mkdtemp(path.join(tmpdir(), 'oc-plugins-'));
    dirs.push(dir2);
    const files2 = ['config.json', 'opencode.json', 'opencode.jsonc'].map((f) => path.join(dir2, f));
    await writeFile(files2[0]!, JSON.stringify({ theme: 'dark' }));
    const fresh = new OpenCodePlugins(async () => fakeOpenCode().client, () => files2);
    expect((await fresh.act('install', 'y-plugin')).installed.map((p) => p.id)).toEqual(['y-plugin']);
    expect(JSON.parse(await readFile(files2[1]!, 'utf8')).plugins).toEqual(['y-plugin']);
    expect(JSON.parse(await readFile(files2[0]!, 'utf8'))).toEqual({ theme: 'dark' });
  });

  it('switches a plugin off and on with a disabled entry', async () => {
    const { manager, written, dir } = await server(['opencode-wakatime']);
    dirs.push(dir);
    expect((await manager.act('disable', 'opencode-wakatime')).installed[0]!.enabled).toBe(false);
    expect((await written()).plugins).toEqual(['-opencode-wakatime']);
    expect((await manager.act('enable', 'opencode-wakatime')).installed[0]!.enabled).toBe(true);
    expect((await written()).plugins).toEqual(['opencode-wakatime']);
    await expect(manager.act('disable', 'ghost')).rejects.toThrow(/no plugin 'ghost'/);
  });

  it('asks the server to update a listed plugin, and refuses one it does not have', async () => {
    const { manager, client, dir } = await server(['@acme/oc-plugin']);
    dirs.push(dir);
    await manager.act('update', '@acme/oc-plugin');
    expect(client.plugin.update).toHaveBeenCalledWith({ targets: ['@acme/oc-plugin'] });
    await expect(manager.act('update', 'ghost')).rejects.toThrow(/no plugin 'ghost'/);
  });

  it('refuses what OpenCode cannot do, and names that are not packages', async () => {
    const { manager, dir } = await server([]);
    dirs.push(dir);
    await expect(manager.act('add-marketplace', 'me/skills')).rejects.toThrow(/no plugin marketplaces/);
    await expect(manager.act('install', 'rm -rf /')).rejects.toThrow(/not an npm package/);
    await expect(manager.act('uninstall', 'ghost')).rejects.toThrow(/no plugin 'ghost'/);
  });
});
