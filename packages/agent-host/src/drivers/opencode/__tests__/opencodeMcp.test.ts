import { describe, expect, it, vi } from 'vitest';
import type { OpenCodeClient } from '@opencode/client';
import { OpenCodeMcp, openCodeServerConfig, openCodeServers, openCodeSessionMcp, toggleOpenCodeMcp } from '../mcp';
import { redactUrl } from '../../../sdk/mcp';

type Entry = { name: string; status: { status: string; error?: string } };

/** A server that holds its MCP servers as v2 does: the config is where a
 *  server's own settings live, the MCP API is where its lifecycle does. */
function server(config: Record<string, Record<string, unknown>>, status: Entry[] = []) {
  const servers = [...status];
  const client = {
    config: {
      get: vi.fn(async () => [{ type: 'document', info: { mcp: config } }]),
    },
    mcp: {
      list: vi.fn(async () => ({ location: { directory: '/w' }, data: servers })),
      add: vi.fn(async ({ server: name, config: entry }: { server: string; config: Record<string, unknown> }) => {
        config[name] = entry;
        servers.push({ name, status: { status: 'connected' } });
      }),
      remove: vi.fn(async ({ server: name }: { server: string }) => {
        delete config[name];
        const at = servers.findIndex((s) => s.name === name);
        if (at >= 0) servers.splice(at, 1);
      }),
      connect: vi.fn(async ({ server: name }: { server: string }) => {
        const found = servers.find((s) => s.name === name);
        if (found) found.status = { status: 'connected' };
        if (config[name]) delete config[name]!.disabled;
      }),
      disconnect: vi.fn(async ({ server: name }: { server: string }) => {
        const found = servers.find((s) => s.name === name);
        if (found) found.status = { status: 'disabled' };
        // Switching a server off leaves it configured but disabled.
        if (config[name]) config[name] = { ...config[name], disabled: true };
      }),
    },
  } as unknown as OpenCodeClient;
  return { client, config, servers };
}

describe('OpenCode MCP servers', () => {
  it('are listed without a secret: the program, the redacted URL, the key names', () => {
    const servers = openCodeServers({
      fs: { type: 'local', command: ['npx', '-y', 'srv', '--token', 't0k'], environment: { API_KEY: 'k' }, disabled: true },
      gh: { type: 'remote', url: 'https://u:p@api.example/mcp?key=q', headers: { Authorization: 'Bearer b' } },
    });
    expect(servers).toEqual([
      { name: 'fs', transport: 'stdio', target: 'npx', envKeys: ['API_KEY'], enabled: false },
      { name: 'gh', transport: 'http', target: 'https://api.example/mcp', headerKeys: ['Authorization'], enabled: true },
    ]);
    expect(JSON.stringify(servers)).not.toMatch(/t0k|Bearer|API_KEY":"k|u:p|key=q/);
  });

  it('adds a server through the MCP API, whole', async () => {
    const { client, config } = server({});
    const mcp = new OpenCodeMcp(async () => client);
    const state = await mcp.act('add', [{ name: 'gh', setup: { type: 'http', url: 'https://new/mcp' } }], []);
    expect(config.gh).toEqual({ type: 'remote', url: 'https://new/mcp' });
    expect(state.servers.map((s) => s.name)).toEqual(['gh']);

    await mcp.act('add', [{ name: 'fs', setup: { type: 'stdio', command: 'uvx', args: ['srv'], env: { K: 'v' } } }], []);
    expect(config.fs).toEqual({ type: 'local', command: ['uvx', 'srv'], environment: { K: 'v' } });
  });

  it('switches a server off and on through the MCP API', async () => {
    const { client, servers } = server(
      { fs: { type: 'local', command: ['uvx', 'srv'] } },
      [{ name: 'fs', status: { status: 'connected' } }],
    );
    const mcp = new OpenCodeMcp(async () => client);
    expect((await mcp.act('disable', [], ['fs'])).servers[0]!.enabled).toBe(false);
    expect(servers[0]!.status.status).toBe('disabled');
    expect((await mcp.act('enable', [], ['fs'])).servers[0]!.enabled).toBe(true);
    await expect(mcp.act('enable', [], ['nope'])).rejects.toThrow(/no MCP server 'nope'/);
    await expect(mcp.act('remove', [], ['nope'])).rejects.toThrow(/no MCP server 'nope'/);
  });

  it('removes a server through the MCP API', async () => {
    const { client, config } = server(
      { gh: { type: 'remote', url: 'https://x' }, fs: { type: 'local', command: ['x'] } },
      [{ name: 'gh', status: { status: 'connected' } }, { name: 'fs', status: { status: 'connected' } }],
    );
    const mcp = new OpenCodeMcp(async () => client);
    expect((await mcp.act('remove', [], ['gh'])).servers.map((s) => s.name)).toEqual(['fs']);
    expect(Object.keys(config)).toEqual(['fs']);
    expect(client.mcp.remove).toHaveBeenCalledWith({ server: 'gh' });
  });

  it('reports and switches a session project-wide', async () => {
    const client = {
      mcp: {
        list: vi.fn(async () => ({
          location: { directory: '/w' },
          data: [
            { name: 'gh', status: { status: 'connected' } },
            { name: 'lin', status: { status: 'needs_auth', error: 'login' } },
            { name: 'fs', status: { status: 'failed', error: 'exit 1' } },
          ],
        })),
        connect: vi.fn(async () => {}),
        disconnect: vi.fn(async () => {}),
      },
    } as unknown as OpenCodeClient;
    expect(await openCodeSessionMcp(client, '/w')).toEqual({
      servers: [
        { name: 'fs', status: 'failed', error: 'exit 1' },
        { name: 'gh', status: 'connected' },
        { name: 'lin', status: 'needs-auth' },
      ],
      toggles: true,
      projectWide: true,
    });
    await toggleOpenCodeMcp(client, '/w', 'gh', false);
    expect(client.mcp.disconnect).toHaveBeenCalledWith({ server: 'gh', location: { directory: '/w' } });
  });

  it('writes remote servers as OpenCode remote, stdio as local', () => {
    expect(openCodeServerConfig({ name: 's', setup: { type: 'sse', url: 'https://x/sse' } })).toEqual({
      type: 'remote',
      url: 'https://x/sse',
    });
    expect(openCodeServerConfig({ name: 's', setup: { type: 'stdio', command: 'x' } })).toEqual({
      type: 'local',
      command: ['x'],
    });
    expect(redactUrl('https://tok@h.example/a/b?x=1#f')).toBe('https://h.example/a/b');
  });
});
