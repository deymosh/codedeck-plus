import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderBinding } from '../../../sdk/types';
import { QwenMcp } from '../mcp';
import { mergeQwenSettings, QwenSettingsFile } from '../settings';

let home: string;
let file: QwenSettingsFile;
let mcp: QwenMcp;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'codedeck-qwen-mcp-'));
  file = new QwenSettingsFile(home, () => {});
  mcp = new QwenMcp(file);
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const onDisk = (): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(home, 'settings.json'), 'utf8')) as Record<string, unknown>;

const profile: ProviderBinding = {
  id: 'p1',
  label: 'Gateway',
  baseUrl: 'https://gateway.example',
  authToken: 'sk-secret',
  models: [{ id: 'glm-5.3', label: 'GLM 5.3' }],
  defaultModel: 'glm-5.3',
};

describe('Qwen Code MCP servers', () => {
  it('writes each transport under the key Qwen Code reads it from, and lists them without their secrets', async () => {
    writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ theme: 'dark' }));
    const state = await mcp.act(
      'add',
      [
        { name: 'files', setup: { type: 'stdio', command: 'npx', args: ['-y', 'server', '--token=t1'], env: { API_KEY: 'k1' } } },
        { name: 'remote', setup: { type: 'http', url: 'https://mcp.example/mcp?key=q', headers: { Authorization: 'Bearer h1' } } },
        { name: 'legacy', setup: { type: 'sse', url: 'https://sse.example/sse' } },
      ],
      [],
    );

    expect(onDisk().theme).toBe('dark');
    expect(onDisk().mcpServers).toEqual({
      files: { command: 'npx', args: ['-y', 'server', '--token=t1'], env: { API_KEY: 'k1' } },
      remote: { httpUrl: 'https://mcp.example/mcp?key=q', headers: { Authorization: 'Bearer h1' } },
      legacy: { url: 'https://sse.example/sse' },
    });
    expect(state.toggles).toBe(true);
    expect(state.servers.map((s) => [s.name, s.transport, s.enabled])).toEqual([
      ['files', 'stdio', true],
      ['legacy', 'sse', true],
      ['remote', 'http', true],
    ]);
    // What the phone is told names what is set, never a value.
    const told = JSON.stringify(await mcp.list());
    for (const secret of ['t1', 'k1', 'h1', 'key=q']) expect(told).not.toContain(secret);
  });

  it('switches a server off through mcp.excluded, and on again, without touching its entry', async () => {
    await mcp.act('add', [{ name: 'files', setup: { type: 'stdio', command: 'srv' } }], []);

    let state = await mcp.act('disable', [], ['files']);
    expect(onDisk().mcp).toEqual({ excluded: ['files'] });
    expect(state.servers[0]?.enabled).toBe(false);

    state = await mcp.act('enable', [], ['files']);
    expect(onDisk().mcp).toBeUndefined();
    expect(state.servers[0]?.enabled).toBe(true);
    expect(onDisk().mcpServers).toEqual({ files: { command: 'srv', args: [] } });
  });

  it('removes a server along with its off switch, keeping the operator’s own exclusions', async () => {
    writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ mcp: { excluded: ['theirs*'] } }));
    await mcp.act('add', [{ name: 'files', setup: { type: 'stdio', command: 'srv' } }], []);
    await mcp.act('disable', [], ['files']);

    await mcp.act('remove', [], ['files']);
    expect(onDisk().mcpServers).toEqual({});
    expect(onDisk().mcp).toEqual({ excluded: ['theirs*'] });
  });

  it('refuses to switch a server it does not have, and changes nothing', async () => {
    await mcp.act('add', [{ name: 'files', setup: { type: 'stdio', command: 'srv' } }], []);
    const before = readFileSync(path.join(home, 'settings.json'), 'utf8');

    await expect(mcp.act('disable', [], ['ghost'])).rejects.toThrow(/no MCP server named ghost/);
    expect(readFileSync(path.join(home, 'settings.json'), 'utf8')).toBe(before);
  });

  it('keeps the servers when the driver rewrites its provider entries, even at the same moment', async () => {
    // Both edit one file: the provider write must not put back a copy read
    // before the server was added.
    await Promise.all([
      mcp.act('add', [{ name: 'files', setup: { type: 'stdio', command: 'srv' } }], []),
      file.edit((existing) => mergeQwenSettings(existing, [profile])),
    ]);
    expect(Object.keys(onDisk().mcpServers as object)).toEqual(['files']);
    expect((onDisk().modelProviders as { openai: unknown[] }).openai).toHaveLength(1);
  });
});
