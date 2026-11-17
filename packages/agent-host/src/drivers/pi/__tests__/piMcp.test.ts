/**
 * Pi's MCP servers, in `mcp.json` in its home. What matters is that Pi reads
 * the file this writes as intended, so the pinned Pi itself checks it
 * (`pi mcp list --json`, which reports every invalid entry and exits 1),
 * and that nothing secret comes back out.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { McpServerAdd } from '../../../sdk/types';
import { bundledPiExecutable } from '../install';
import { PiMcp } from '../mcp';

const piPath = bundledPiExecutable();
const real = piPath ? it : it.skip;

const LOCAL: McpServerAdd = {
  name: 'local-tools',
  setup: { type: 'stdio', command: 'node', args: ['server.js', '--token', 'arg-secret'], env: { API_KEY: 'env-secret' } },
};
const REMOTE: McpServerAdd = {
  name: 'docs',
  setup: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer header-secret' } },
};

function manager(): { mcp: PiMcp; home: string } {
  const home = mkdtempSync(path.join(tmpdir(), 'codedeck-pi-mcp-'));
  return { mcp: new PiMcp(home, () => {}), home };
}

function piList(home: string): { servers: Array<{ name: string; state: string }>; errors: string[] } {
  const out = execFileSync(process.execPath, [piPath!, 'mcp', 'list', '--json'], {
    cwd: home,
    env: { ...process.env, PI_CODING_AGENT_DIR: home },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return JSON.parse(out) as { servers: Array<{ name: string; state: string }>; errors: string[] };
}

describe('PiMcp', () => {
  real(
    'writes servers the pinned Pi reads without an error, and switches them off its way',
    async () => {
      const { mcp, home } = manager();
      await mcp.act('add', [LOCAL, REMOTE], []);
      // Off, so Pi checks the entries without trying to connect them.
      await mcp.act('disable', [], ['local-tools', 'docs']);
      const listed = piList(home);
      expect(listed.errors).toEqual([]);
      expect(listed.servers.map((server) => [server.name, server.state]).sort()).toEqual([
        ['docs', 'disabled'],
        ['local-tools', 'disabled'],
      ]);
    },
    60_000,
  );

  it('lists servers by name, program and keys, never a secret', async () => {
    const { mcp } = manager();
    const state = await mcp.act('add', [LOCAL, REMOTE], []);
    expect(state.servers).toEqual([
      expect.objectContaining({ name: 'docs', transport: 'http', headerKeys: ['Authorization'], enabled: true }),
      expect.objectContaining({ name: 'local-tools', transport: 'stdio', target: 'node', envKeys: ['API_KEY'], enabled: true }),
    ]);
    const shown = JSON.stringify(await mcp.list());
    for (const secret of ['arg-secret', 'env-secret', 'header-secret']) expect(shown).not.toContain(secret);
  });

  it('switches a server back on by dropping the flag, and removes one', async () => {
    const { mcp, home } = manager();
    await mcp.act('add', [LOCAL], []);
    await mcp.act('disable', [], ['local-tools']);
    await mcp.act('enable', [], ['local-tools']);
    const file = JSON.parse(readFileSync(path.join(home, 'mcp.json'), 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(file.mcpServers['local-tools']).not.toHaveProperty('enabled');
    expect((await mcp.act('remove', [], ['local-tools'])).servers).toEqual([]);
  });

  it('refuses what Pi would reject — an SSE server, a name it cannot take — and changes nothing', async () => {
    const { mcp } = manager();
    await expect(mcp.act('add', [{ name: 'old', setup: { type: 'sse', url: 'https://example.com/sse' } }], [])).rejects.toThrow(/SSE/);
    await expect(mcp.act('add', [{ ...LOCAL, name: 'bad name' }], [])).rejects.toThrow(/letters, digits/);
    await expect(mcp.act('remove', [], ['missing'])).rejects.toThrow(/no MCP server named missing/);
    expect((await mcp.list()).servers).toEqual([]);
  });

  it('counts only changes that change something', async () => {
    const { mcp } = manager();
    await mcp.act('add', [LOCAL], []);
    expect(mcp.version).toBe(1);
    await mcp.act('enable', [], ['local-tools']);
    expect(mcp.version).toBe(1);
  });
});
