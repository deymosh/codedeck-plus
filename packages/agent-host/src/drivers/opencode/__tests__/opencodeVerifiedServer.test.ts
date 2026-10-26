/**
 * Behaviours the probes against OpenCode 2.1.4 established that the driver
 * did not follow: the config document's MCP section, a server that only
 * lives in the running inventory, the status word a disconnect leaves, and
 * a package plugin named by its source rather than by an `id`.
 *
 * These go through the driver's public managers, over the verified fake, so
 * breaking the driver here is what a real server would show.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OpenCodeMcp } from '../mcp';
import { OpenCodePlugins } from '../plugins';
import { fakeOpenCode } from './fakeServer';

const serverOf = () =>
  fakeOpenCode({
    mcpConfig: {
      fs: { type: 'local', command: ['npx', '-y', 'srv'], environment: { API_KEY: 'k' } },
    },
  });

describe('MCP servers as 2.1.4 holds them', () => {
  it('reads the config document\'s `servers` map, which is not the file\'s bare map', async () => {
    const server = serverOf();
    const mcp = new OpenCodeMcp(async () => server.client);
    const state = await mcp.list();
    // The config file spells `mcp: {fs: …}`; `config.get` reads it back as
    // `mcp: {servers: {fs: …}}`. Reading the section itself lists nothing.
    expect(state).toEqual({
      servers: [{ name: 'fs', transport: 'stdio', target: 'npx', envKeys: ['API_KEY'], enabled: true }],
      toggles: true,
    });
  });

  it('lists a server it added, which lives in the running inventory only', async () => {
    const server = serverOf();
    const mcp = new OpenCodeMcp(async () => server.client);
    const state = await mcp.act('add', [{ name: 'gh', setup: { type: 'http', url: 'https://new/mcp' } }], []);
    // `mcp.add` does not write the config document (verified); the server's
    // inventory is where the new server is.
    expect(server.state.mcpConfig).toEqual({ fs: { type: 'local', command: ['npx', '-y', 'srv'], environment: { API_KEY: 'k' } } });
    expect(state.servers.map((s) => s.name)).toEqual(['fs', 'gh']);
    expect(state.servers.find((s) => s.name === 'gh')).toMatchObject({ transport: 'http', target: 'https://new/mcp', enabled: true });
  });

  it('reports a server the API disconnected as disabled, where the config keeps saying nothing', async () => {
    const server = serverOf();
    const mcp = new OpenCodeMcp(async () => server.client);
    const state = await mcp.act('disable', [], ['fs']);
    // `mcp.disconnect` changes the inventory's status; the config entry is
    // untouched, so its `disabled` flag cannot be the switch.
    expect(server.state.mcpConfig.fs).toEqual({ type: 'local', command: ['npx', '-y', 'srv'], environment: { API_KEY: 'k' } });
    expect(state.servers[0]).toMatchObject({ name: 'fs', enabled: false });
    expect((await mcp.act('enable', [], ['fs'])).servers[0]).toMatchObject({ name: 'fs', enabled: true });
  });

  it('drops a removed server from the list for this server, though its file entry stays', async () => {
    const server = serverOf();
    const mcp = new OpenCodeMcp(async () => server.client);
    const state = await mcp.act('remove', [], ['fs']);
    // `mcp.remove` does not rewrite the file; a restart brings the config
    // server back, and so does a new manager over a new client.
    expect(server.state.mcpConfig).toHaveProperty('fs');
    expect(state.servers).toEqual([]);
    // Adding the same name again puts it back in the inventory.
    const added = await mcp.act('add', [{ name: 'fs', setup: { type: 'stdio', command: 'uvx', args: ['srv'] } }], []);
    expect(added.servers).toEqual([{ name: 'fs', transport: 'stdio', target: 'uvx', enabled: true }]);
  });
});

describe('plugins as 2.1.4 reports them', () => {
  it('matches a failed package by its source target, because a package entry has no id', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-plugins-'));
    const file = path.join(dir, 'opencode.json');
    await writeFile(file, JSON.stringify({ plugins: ['@acme/oc-plugin'] }));
    const server = fakeOpenCode({
      plugins: [
        {
          source: { type: 'package', target: '@acme/oc-plugin' },
          state: { status: 'failed', error: 'Plugin failed to load', ref: 'err_1' },
        },
      ],
    });
    const manager = new OpenCodePlugins(async () => server.client, () => [file]);
    const state = await manager.list();
    expect(state.installed).toEqual([
      { id: '@acme/oc-plugin', name: '@acme/oc-plugin', enabled: false, error: 'Plugin failed to load' },
    ]);
  });
});
