import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { OpenCodeMcp, openCodeServerConfig, openCodeServers, openCodeSessionMcp, toggleOpenCodeMcp } from '../mcp';
import { redactUrl } from '../../../sdk/mcp';
import { expectNoSecretLeaks, TEST_SECRETS } from '../../../sdk/__tests__/secrets';
import { fakeOpenCode } from './fakeServer';

const at = { location: { directory: '/w' } };

/** A global config directory of its own, holding `opencode.json` with
 *  `config` when one is given. */
function configDir(config?: unknown): { files: () => string[]; file: string; read: () => Record<string, unknown> } {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'oc-mcp-')), 'opencode');
  const file = path.join(dir, 'opencode.json');
  if (config !== undefined) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(config));
  }
  return {
    files: () => ['config.json', 'opencode.json', 'opencode.jsonc'].map((f) => path.join(dir, f)),
    file,
    read: () => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>,
  };
}

/** The manager of a server process that started now, over the same files:
 *  what a restart of OpenCode (and of the bridge) sees. */
const restarted = (files: () => string[]) => new OpenCodeMcp(async () => fakeOpenCode().client, files);

describe('OpenCode MCP servers', () => {
  it('are listed without a secret: the program, the redacted URL, the key names', () => {
    const servers = openCodeServers({
      fs: { type: 'local', command: ['npx', '-y', 'srv', '--token', 't0k'], environment: { API_KEY: 'k' }, enabled: false },
      gh: { type: 'remote', url: 'https://u:p@api.example/mcp?key=q', headers: { Authorization: 'Bearer b' } },
    });
    expect(servers).toEqual([
      { name: 'fs', transport: 'stdio', target: 'npx', envKeys: ['API_KEY'], enabled: false },
      { name: 'gh', transport: 'http', target: 'https://api.example/mcp', headerKeys: ['Authorization'], enabled: true },
    ]);
    expect(JSON.stringify(servers)).not.toMatch(/t0k|Bearer|API_KEY":"k|u:p|key=q/);
  });

  it('keeps an added server in the global config, so it outlives a restart', async () => {
    const server = fakeOpenCode();
    const config = configDir({ plugins: ['x-plugin'] });
    const mcp = new OpenCodeMcp(async () => server.client, config.files);
    const env = { API_KEY: TEST_SECRETS.apiKey };
    const state = await mcp.act('add', [{ name: 'fs', setup: { type: 'stdio', command: 'uvx', args: ['srv'], env } }], []);
    // The server checked it first; the file is what lasts.
    expect(server.client.mcp.add).toHaveBeenCalledOnce();
    expect(config.read()).toEqual({
      plugins: ['x-plugin'],
      mcp: { fs: { type: 'local', command: ['uvx', 'srv'], environment: env } },
    });
    expect(state.servers).toEqual([{ name: 'fs', transport: 'stdio', target: 'uvx', envKeys: ['API_KEY'], enabled: true }]);
    expectNoSecretLeaks({ frames: [state] });
    expect((await restarted(config.files).list()).servers.map((s) => s.name)).toEqual(['fs']);
  });

  it('writes nothing when the server refuses an add', async () => {
    const server = fakeOpenCode();
    vi.spyOn(server.client.mcp, 'add').mockRejectedValueOnce(new Error('invalid config'));
    const config = configDir({ mcp: {} });
    const mcp = new OpenCodeMcp(async () => server.client, config.files);
    await expect(mcp.act('add', [{ name: 'gh', setup: { type: 'http', url: 'not a url' } }], [])).rejects.toThrow(/could not add gh/);
    expect(config.read()).toEqual({ mcp: {} });
  });

  it('keeps a removed server out after a restart', async () => {
    const config = configDir({ mcp: { gh: { type: 'remote', url: 'https://x' }, fs: { type: 'local', command: ['x'] } } });
    const mcp = new OpenCodeMcp(async () => fakeOpenCode().client, config.files);
    expect((await mcp.act('remove', [], ['gh'])).servers.map((s) => s.name)).toEqual(['fs']);
    expect(Object.keys(config.read().mcp as object)).toEqual(['fs']);
    expect((await restarted(config.files).list()).servers.map((s) => s.name)).toEqual(['fs']);
    await expect(mcp.act('remove', [], ['nope'])).rejects.toThrow(/no MCP server 'nope'/);
  });

  it('keeps a server switched off after a restart, with the flag OpenCode reads', async () => {
    const config = configDir({ mcp: { fs: { type: 'local', command: ['uvx', 'srv'] } } });
    const mcp = new OpenCodeMcp(async () => fakeOpenCode().client, config.files);
    expect((await mcp.act('disable', [], ['fs'])).servers[0]!.enabled).toBe(false);
    // `enabled: false` is the switch 2.1.4 honours in the file; `disabled`
    // is ignored there.
    expect(config.read().mcp).toEqual({ fs: { type: 'local', command: ['uvx', 'srv'], enabled: false } });
    expect((await restarted(config.files).list()).servers[0]!.enabled).toBe(false);
    expect((await mcp.act('enable', [], ['fs'])).servers[0]!.enabled).toBe(true);
    expect(config.read().mcp).toEqual({ fs: { type: 'local', command: ['uvx', 'srv'] } });
    await expect(mcp.act('enable', [], ['nope'])).rejects.toThrow(/no MCP server 'nope'/);
  });

  it('keeps a file\'s nested `servers` spelling', async () => {
    const config = configDir({ mcp: { servers: { fs: { type: 'local', command: ['x'] } } } });
    const mcp = new OpenCodeMcp(async () => fakeOpenCode().client, config.files);
    await mcp.act('disable', [], ['fs']);
    expect(config.read().mcp).toEqual({ servers: { fs: { type: 'local', command: ['x'], enabled: false } } });
  });

  it('edits an opencode.jsonc in place, keeping its comments', async () => {
    // OpenCode's own tools may leave the global config as JSONC; it is
    // edited as OpenCode edits it, not refused and not rewritten.
    const config = configDir();
    const jsonc = path.join(path.dirname(config.file), 'opencode.jsonc');
    mkdirSync(path.dirname(jsonc), { recursive: true });
    writeFileSync(jsonc, '{\n  // the owner\'s note\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": { "fs": { "type": "local", "command": ["x"] }, },\n}\n');
    const mcp = new OpenCodeMcp(async () => fakeOpenCode().client, config.files);

    expect((await mcp.list()).servers.map((s) => s.name)).toEqual(['fs']);
    await mcp.act('add', [{ name: 'gh', setup: { type: 'http', url: 'https://x/mcp' } }], []);
    await mcp.act('disable', [], ['fs']);
    const text = readFileSync(jsonc, 'utf8');
    expect(text).toContain("// the owner's note");
    expect(text).toContain('"$schema"');
    expect(existsSync(config.file)).toBe(false);
    expect((await restarted(config.files).list()).servers).toEqual([
      { name: 'fs', transport: 'stdio', target: 'x', enabled: false },
      { name: 'gh', transport: 'http', target: 'https://x/mcp', enabled: true },
    ]);
  });

  it('lists a name as the last file has it, and removes it from every file', async () => {
    // OpenCode reads config.json, opencode.json, opencode.jsonc in that
    // order, a later file overriding an earlier one.
    const config = configDir({ mcp: { fs: { type: 'local', command: ['old'] } } });
    writeFileSync(path.join(path.dirname(config.file), 'opencode.jsonc'), '{ "mcp": { "fs": { "type": "local", "command": ["new"] } } }');
    const mcp = new OpenCodeMcp(async () => fakeOpenCode().client, config.files);
    expect((await mcp.list()).servers[0]).toMatchObject({ name: 'fs', target: 'new' });
    expect((await mcp.act('remove', [], ['fs'])).servers).toEqual([]);
    expect((await restarted(config.files).list()).servers).toEqual([]);
  });

  it('repairs a config file an interrupted write left empty', async () => {
    // The file is written through a rename for this reason; an empty one is
    // a config with nothing in it, not a broken one.
    const config = configDir();
    mkdirSync(path.dirname(config.file), { recursive: true });
    writeFileSync(config.file, '');
    const mcp = new OpenCodeMcp(async () => fakeOpenCode().client, config.files);
    await mcp.act('add', [{ name: 'gh', setup: { type: 'http', url: 'https://x/mcp' } }], []);
    expect(config.read()).toEqual({ mcp: { gh: { type: 'remote', url: 'https://x/mcp' } } });
  });

  it('a file that does not parse blocks only its own servers', async () => {
    // A broken later file that never mentions the name does not stop a
    // change to a server the readable file holds.
    const config = configDir({ mcp: { fs: { type: 'local', command: ['x'] } } });
    writeFileSync(path.join(path.dirname(config.file), 'opencode.jsonc'), '{ "mcp": { "gh": ');
    const mcp = new OpenCodeMcp(async () => fakeOpenCode().client, config.files);
    expect((await mcp.act('remove', [], ['fs'])).servers).toEqual([]);
    // But a change to the name it does mention still stops there.
    await expect(mcp.act('remove', [], ['gh'])).rejects.toThrow(/not a valid OpenCode config/);
  });

  it('leaves a file that does not parse untouched, and the server unasked', async () => {
    const config = configDir();
    mkdirSync(path.dirname(config.file), { recursive: true });
    const text = '{ "mcp": { "fs": ';
    writeFileSync(config.file, text);
    const server = fakeOpenCode();
    const mcp = new OpenCodeMcp(async () => server.client, config.files);
    await expect(mcp.act('add', [{ name: 'gh', setup: { type: 'http', url: 'https://x' } }], [])).rejects.toThrow(/not a valid OpenCode config/);
    expect(readFileSync(config.file, 'utf8')).toBe(text);
    // Refused before the running server took it: the two never disagree.
    expect(server.client.mcp.add).not.toHaveBeenCalled();
  });

  it('creates the global config when the machine has none', async () => {
    const config = configDir();
    const mcp = new OpenCodeMcp(async () => fakeOpenCode().client, config.files);
    expect(existsSync(config.file)).toBe(false);
    await mcp.act('add', [{ name: 'gh', setup: { type: 'http', url: 'https://x/mcp' } }], []);
    expect(config.read()).toEqual({ mcp: { gh: { type: 'remote', url: 'https://x/mcp' } } });
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
