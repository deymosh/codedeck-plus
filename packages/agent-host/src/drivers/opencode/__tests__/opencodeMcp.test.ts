import { describe, expect, it } from 'vitest';
import { OpenCodeMcp, openCodeServerConfig, openCodeServers, openCodeSessionMcp, toggleOpenCodeMcp } from '../mcp';
import { redactUrl } from '../../../sdk/mcp';
import { fakeOpenCode } from './fakeServer';

const at = { location: { directory: '/w' } };

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
    const server = fakeOpenCode();
    const mcp = new OpenCodeMcp(async () => server.client);
    const state = await mcp.act('add', [{ name: 'gh', setup: { type: 'http', url: 'https://new/mcp' } }], []);
    // The API keeps it in the running inventory; the config document is not
    // where 2.1.4 records an add.
    expect(server.state.mcpConfig).toEqual({});
    expect(server.state.mcp.get('gh')).toMatchObject({ status: 'connected' });
    expect(state.servers.map((s) => s.name)).toEqual(['gh']);

    await mcp.act('add', [{ name: 'fs', setup: { type: 'stdio', command: 'uvx', args: ['srv'], env: { K: 'v' } } }], []);
    expect((await mcp.list()).servers.find((s) => s.name === 'fs')).toMatchObject({
      transport: 'stdio',
      target: 'uvx',
      envKeys: ['K'],
    });
  });

  it('switches a server off and on through the MCP API', async () => {
    const server = fakeOpenCode({ mcpConfig: { fs: { type: 'local', command: ['uvx', 'srv'] } } });
    const mcp = new OpenCodeMcp(async () => server.client);
    expect((await mcp.act('disable', [], ['fs'])).servers[0]!.enabled).toBe(false);
    expect(server.state.mcp.get('fs')!.status).toBe('disabled');
    expect((await mcp.act('enable', [], ['fs'])).servers[0]!.enabled).toBe(true);
    expect(server.state.mcp.get('fs')!.status).toBe('connected');
    await expect(mcp.act('enable', [], ['nope'])).rejects.toThrow(/no MCP server 'nope'/);
    await expect(mcp.act('remove', [], ['nope'])).rejects.toThrow(/no MCP server 'nope'/);
  });

  it('removes a server through the MCP API, from the running inventory', async () => {
    const server = fakeOpenCode({ mcpConfig: { gh: { type: 'remote', url: 'https://x' }, fs: { type: 'local', command: ['x'] } } });
    const mcp = new OpenCodeMcp(async () => server.client);
    expect((await mcp.act('remove', [], ['gh'])).servers.map((s) => s.name)).toEqual(['fs']);
    expect(server.client.mcp.remove).toHaveBeenCalledWith({ server: 'gh' });
    // The config file keeps the entry; a new server would start with it.
    expect(server.state.mcpConfig).toHaveProperty('gh');
  });

  it('reports and switches a session project-wide', async () => {
    const server = fakeOpenCode({
      mcpServers: [
        { name: 'gh', status: 'connected' },
        { name: 'lin', status: 'needs_auth', error: 'login' },
        { name: 'fs', status: 'failed', error: 'exit 1' },
      ],
    });
    expect(await openCodeSessionMcp(server.client, '/w')).toEqual({
      servers: [
        { name: 'fs', status: 'failed', error: 'exit 1' },
        { name: 'gh', status: 'connected' },
        { name: 'lin', status: 'needs-auth' },
      ],
      toggles: true,
      projectWide: true,
    });
    await toggleOpenCodeMcp(server.client, '/w', 'gh', false);
    expect(server.client.mcp.disconnect).toHaveBeenCalledWith({ server: 'gh', ...at });
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
