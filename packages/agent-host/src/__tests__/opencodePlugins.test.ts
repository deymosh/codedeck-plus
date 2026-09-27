import { describe, expect, it, vi } from 'vitest';
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import { OpenCodePlugins, toInstalledPlugin } from '../drivers/opencode/plugins';

/** A server whose global config lists `plugin`, and records every write. */
function server(plugin: unknown[]) {
  const config = { plugin };
  const update = vi.fn(async ({ config: next }: { config: { plugin: unknown[] } }) => {
    config.plugin = next.plugin;
    return { data: config, error: undefined };
  });
  const client = {
    global: { config: { get: vi.fn(async () => ({ data: config, error: undefined })), update } },
  } as unknown as OpencodeClient;
  return { plugins: new OpenCodePlugins(async () => client), update, config };
}

describe('OpenCode plugins', () => {
  it('lists the packages its global config names, with their pinned version', async () => {
    const { plugins } = server(['opencode-wakatime', ['@acme/oc-plugin@1.2.0', { key: 'x' }]]);
    expect(await plugins.list()).toEqual({
      installed: [
        { id: 'opencode-wakatime', name: 'opencode-wakatime', enabled: true },
        { id: '@acme/oc-plugin@1.2.0', name: '@acme/oc-plugin', version: '1.2.0', enabled: true },
      ],
      toggles: false,
    });
    expect(toInstalledPlugin('@acme/oc-plugin')).toEqual({ id: '@acme/oc-plugin', name: '@acme/oc-plugin', enabled: true });
  });

  it('installs and uninstalls by rewriting that list, keeping the other entries whole', async () => {
    const { plugins, update, config } = server([['@acme/oc-plugin', { key: 'x' }]]);
    expect((await plugins.act('install', 'opencode-wakatime@latest')).installed.map((p) => p.id)).toEqual([
      '@acme/oc-plugin',
      'opencode-wakatime@latest',
    ]);
    expect(config.plugin).toEqual([['@acme/oc-plugin', { key: 'x' }], 'opencode-wakatime@latest']);
    await plugins.act('install', 'opencode-wakatime@latest');
    expect(update).toHaveBeenCalledTimes(1);
    await plugins.act('uninstall', '@acme/oc-plugin');
    expect(config.plugin).toEqual(['opencode-wakatime@latest']);
  });

  it('refuses what OpenCode cannot do, and names that are not packages', async () => {
    const { plugins, update } = server([]);
    await expect(plugins.act('disable', 'x')).rejects.toThrow(/uninstall it instead/);
    await expect(plugins.act('add-marketplace', 'me/skills')).rejects.toThrow(/no plugin marketplaces/);
    await expect(plugins.act('install', 'rm -rf /')).rejects.toThrow(/not an npm package/);
    await expect(plugins.act('uninstall', 'ghost')).rejects.toThrow(/no plugin 'ghost'/);
    expect(update).not.toHaveBeenCalled();
  });
});
