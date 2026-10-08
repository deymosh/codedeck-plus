import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import { OpenCodeMcp, openCodeSessionMcp, openCodeServerConfig, toggleOpenCodeMcp } from '../mcp';
import { redactUrl } from '../../../sdk/mcp';

/** A server whose global config is `config`; an update first re-reads the
 *  global config file when `reload` is given, then merges into it the way
 *  OpenCode's does (a `null` field is cleared). */
function server(mcp: Record<string, Record<string, unknown>>, reload?: () => Promise<Record<string, Record<string, unknown>>>) {
  const config: { mcp: Record<string, Record<string, unknown>> } = { mcp };
  const update = vi.fn(async ({ config: next }: { config: { mcp?: Record<string, Record<string, unknown>> } }) => {
    if (reload) config.mcp = await reload();
    for (const [name, entry] of Object.entries(next.mcp ?? {})) {
      const merged: Record<string, unknown> = { ...(config.mcp[name] ?? {}), ...entry };
      for (const [k, v] of Object.entries(merged)) if (v === null) delete merged[k];
      config.mcp[name] = merged;
    }
    return { data: config, error: undefined };
  });
  const client = {
    global: { config: { get: vi.fn(async () => ({ data: config, error: undefined })), update } },
  } as unknown as OpencodeClient;
  return { client, update, config };
}

describe('OpenCode MCP servers', () => {
  it('are listed without a secret: the program, the redacted URL, the key names', async () => {
    const { client } = server({
      fs: { type: 'local', command: ['npx', '-y', 'srv', '--token', 't0k'], environment: { API_KEY: 'k' }, enabled: false },
      gh: { type: 'remote', url: 'https://u:p@api.example/mcp?key=q', headers: { Authorization: 'Bearer b' } },
    });
    const state = await new OpenCodeMcp(async () => client, () => []).list();
    expect(state).toEqual({
      servers: [
        { name: 'fs', transport: 'stdio', target: 'npx', envKeys: ['API_KEY'], enabled: false },
        { name: 'gh', transport: 'http', target: 'https://api.example/mcp', headerKeys: ['Authorization'], enabled: true },
      ],
      toggles: true,
    });
    expect(JSON.stringify(state)).not.toMatch(/t0k|Bearer|API_KEY":"k|u:p|key=q/);
  });

  it('adds a server whole, clearing what an older one of that name had', async () => {
    const { client, config } = server({ gh: { type: 'remote', url: 'https://old/mcp', headers: { Authorization: 'old' } } });
    const mcp = new OpenCodeMcp(async () => client, () => []);
    await mcp.act('add', [{ name: 'gh', setup: { type: 'http', url: 'https://new/mcp' } }], []);
    expect(config.mcp.gh).toEqual({ type: 'remote', url: 'https://new/mcp', enabled: true });
    await mcp.act('add', [{ name: 'fs', setup: { type: 'stdio', command: 'uvx', args: ['srv'], env: { K: 'v' } } }], []);
    expect(config.mcp.fs).toEqual({ type: 'local', command: ['uvx', 'srv'], environment: { K: 'v' }, enabled: true });
  });

  it('switches a server off and on, keeping the rest of its settings', async () => {
    const { client, config } = server({ fs: { type: 'local', command: ['uvx', 'srv'], environment: { K: 'v' } } });
    const mcp = new OpenCodeMcp(async () => client, () => []);
    expect((await mcp.act('disable', [], ['fs'])).servers[0]!.enabled).toBe(false);
    expect(config.mcp.fs).toEqual({ type: 'local', command: ['uvx', 'srv'], environment: { K: 'v' }, enabled: false });
    await expect(mcp.act('enable', [], ['nope'])).rejects.toThrow(/no MCP server 'nope'/);
  });

  it('removes a server by editing a plain-JSON config file, never a commented one', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-mcp-'));
    const json = path.join(dir, 'opencode.json');
    const jsonc = path.join(dir, 'opencode.jsonc');
    await writeFile(json, JSON.stringify({ model: 'a/b', mcp: { gh: { type: 'remote', url: 'https://x' }, fs: { type: 'local', command: ['x'] } } }));
    const fromFile = async () => (JSON.parse(await readFile(json, 'utf8')) as { mcp: Record<string, Record<string, unknown>> }).mcp;
    const { client } = server(await fromFile(), fromFile);
    const mcp = new OpenCodeMcp(async () => client, () => [json, jsonc]);
    // The list after a removal is the reloaded config, without the server.
    expect((await mcp.act('remove', [], ['gh'])).servers.map((s) => s.name)).toEqual(['fs']);
    expect(JSON.parse(await readFile(json, 'utf8'))).toEqual({ model: 'a/b', mcp: { fs: { type: 'local', command: ['x'] } } });

    await writeFile(jsonc, '{\n  // mine\n  "mcp": { "fs": { "type": "local", "command": ["x"] } }\n}\n');
    await expect(mcp.act('remove', [], ['fs'])).rejects.toThrow(/has comments/);
    await expect(mcp.act('remove', [], ['nope'])).rejects.toThrow(/no MCP server 'nope'/);
    await rm(dir, { recursive: true });
  });

  it('reports and switches a session project-wide', async () => {
    const status = vi.fn(async () => ({
      data: { gh: { status: 'connected' }, lin: { status: 'needs_auth' }, fs: { status: 'failed', error: 'exit 1' } },
      error: undefined,
    }));
    const disconnect = vi.fn(async () => ({ data: true, error: undefined }));
    const client = { mcp: { status, disconnect, connect: vi.fn() } } as unknown as OpencodeClient;
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
    expect(disconnect).toHaveBeenCalledWith({ name: 'gh', directory: '/w' });
  });

  it('writes remote servers as OpenCode remote, stdio as local', () => {
    expect(openCodeServerConfig({ name: 's', setup: { type: 'sse', url: 'https://x/sse' } })).toEqual({
      type: 'remote',
      url: 'https://x/sse',
      headers: null,
      enabled: true,
    });
    expect(redactUrl('https://tok@h.example/a/b?x=1#f')).toBe('https://h.example/a/b');
  });
});
