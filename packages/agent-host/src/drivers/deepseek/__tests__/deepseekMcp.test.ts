/**
 * The harness's MCP servers: the managed block this driver keeps in a
 * profile's own patch layer — the file the harness reads after every bundle.
 * Everything around the block (comments, a user's rows) is read, kept and
 * written back untouched, which is what most of these cases are about.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { McpServerAdd } from '../../../sdk/types';
import { DeepSeekMcp } from '../mcp';

const INITIAL_LAYER = `# Your patch layer for this dsh profile, applied after every bundle layer.
[]`;

function profile(initial: string = INITIAL_LAYER): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'codedeck-dsh-mcp-'));
  writeFileSync(path.join(dir, 'cordis.patch.yml'), initial);
  return dir;
}

const layerOf = (dir: string): string => readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8');
const manager = (dir: string): DeepSeekMcp => new DeepSeekMcp({ profileDir: dir, log: () => {} });

const stdio = (name: string, command = '/usr/bin/tool', env?: Record<string, string>): McpServerAdd => ({
  name,
  setup: { type: 'stdio', command, ...(env ? { env } : {}), args: ['--serve'] },
});

describe('listing', () => {
  it('answers nothing for a profile without a patch layer', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codedeck-dsh-mcp-'));
    expect(await manager(dir).list()).toEqual({ servers: [], toggles: true });
  });

  it('answers nothing for the layer the harness writes itself', async () => {
    expect(await manager(profile()).list()).toEqual({ servers: [], toggles: true });
  });
});

describe('adding', () => {
  it('writes a managed block and reads it back without a secret value', async () => {
    const dir = profile();
    const state = await manager(dir).act('add', [stdio('demo', '/usr/bin/tool', { API_KEY: 'secret' })], []);
    expect(state.servers).toEqual([
      { name: 'demo', transport: 'stdio', target: '/usr/bin/tool', envKeys: ['API_KEY'], enabled: true },
    ]);
    const file = layerOf(dir);
    expect(file).toMatch(/codedeck-mcp-demo/);
    expect(file).toMatch(/@deepseek-ai\/dsh-mcp-client/);
    // The layer keeps its own header; the harness's initial empty list is
    // gone (an empty sequence and a block sequence cannot share a document).
    expect(file.startsWith('# Your patch layer')).toBe(true);
    expect(file).not.toMatch(/^\[\]$/m);
    // The value is in the file — the harness needs it — but never in what the
    // phone is shown.
    expect(file).toMatch(/secret/);
  });

  it('keeps an HTTP server’s URL in the layer and its redacted form on the wire', async () => {
    const dir = profile();
    const state = await manager(dir).act(
      'add',
      [{ name: 'remote', setup: { type: 'http', url: 'https://user:pw@mcp.example/mcp?key=q', headers: { Authorization: 'Bearer t' } } }],
      [],
    );
    expect(state.servers).toEqual([
      { name: 'remote', transport: 'http', target: 'https://mcp.example/mcp', headerKeys: ['Authorization'], enabled: true },
    ]);
    expect(layerOf(dir)).toMatch(/transport: streamable-http/);
  });

  it('replaces a server it already has, keeping the switch the user set', async () => {
    const dir = profile();
    const mcp = manager(dir);
    await mcp.act('add', [stdio('demo', '/usr/bin/one')], []);
    await mcp.act('disable', [], ['demo']);
    const state = await mcp.act('add', [stdio('demo', '/usr/bin/two')], []);
    expect(state.servers).toEqual([{ name: 'demo', transport: 'stdio', target: '/usr/bin/two', enabled: false }]);
  });

  it('refuses a name the harness cannot namespace', async () => {
    const dir = profile();
    await expect(manager(dir).act('add', [stdio('my server!')], [])).rejects.toThrow(/not a usable MCP server name/);
    await expect(manager(dir).act('add', [stdio('x'.repeat(33))], [])).rejects.toThrow(/not a usable MCP server name/);
  });

  it('refuses the SSE transport the harness does not speak', async () => {
    const dir = profile();
    await expect(manager(dir).act('add', [{ name: 'old', setup: { type: 'sse', url: 'https://x/mcp' } }], [])).rejects.toThrow(
      /stdio or streamable HTTP, not SSE/,
    );
  });
});

describe('switching', () => {
  it('switches a server off and on without removing it', async () => {
    const dir = profile();
    const mcp = manager(dir);
    await mcp.act('add', [stdio('demo')], []);
    expect((await mcp.act('disable', [], ['demo'])).servers).toEqual([
      { name: 'demo', transport: 'stdio', target: '/usr/bin/tool', enabled: false },
    ]);
    // The row stays, with a disable row after it — the layer's own way of
    // switching a row off.
    expect(layerOf(dir)).toMatch(/disabled: true/);
    expect((await mcp.act('enable', [], ['demo'])).servers).toEqual([
      { name: 'demo', transport: 'stdio', target: '/usr/bin/tool', enabled: true },
    ]);
    expect(layerOf(dir)).not.toMatch(/disabled: true/);
  });

  it('counts a change so a session can tell what its harness has loaded', async () => {
    // Nothing here restarts a running harness: the file is read as it starts,
    // which is what a session's MCP status reports as pending.
    const dir = profile();
    const mcp = manager(dir);
    expect(mcp.version).toBe(0);
    await mcp.act('add', [stdio('demo')], []);
    expect(mcp.version).toBe(1);
    // A write that changes nothing is not a change.
    await mcp.act('add', [stdio('demo')], []);
    expect(mcp.version).toBe(1);
    await mcp.act('remove', [], ['demo']);
    expect(mcp.version).toBe(2);
  });

  it('refuses to switch a server it does not have', async () => {
    const dir = profile();
    await expect(manager(dir).act('disable', [], ['ghost'])).rejects.toThrow(/has no MCP server named 'ghost'/);
    await expect(manager(dir).act('remove', [], ['ghost'])).rejects.toThrow(/has no MCP server named 'ghost'/);
  });
});

describe('removing', () => {
  it('takes the server out and leaves the layer as it was', async () => {
    const dir = profile();
    const mcp = manager(dir);
    await mcp.act('add', [stdio('demo')], []);
    expect(await mcp.act('remove', [], ['demo'])).toEqual({ servers: [], toggles: true });
    expect(layerOf(dir)).toBe(`${INITIAL_LAYER}\n`);
  });

  it('keeps everything outside the managed block', async () => {
    const mine = `# Your patch layer for this dsh profile.
- insert:
    - id: my-own-server
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: mine
        transport: stdio
        command: /usr/bin/mine

# a trailing note`;
    const dir = profile(mine);
    const mcp = manager(dir);
    await mcp.act('add', [stdio('demo')], []);
    expect(layerOf(dir).trimEnd().startsWith(mine)).toBe(true);

    // Adding a second one rewrites only the block, so the user's own rows are
    // still exactly where they were.
    await mcp.act('add', [stdio('other')], []);
    expect(layerOf(dir).trimEnd().startsWith(mine)).toBe(true);
    expect(await mcp.list()).toEqual({
      servers: [
        { name: 'demo', transport: 'stdio', target: '/usr/bin/tool', enabled: true },
        { name: 'other', transport: 'stdio', target: '/usr/bin/tool', enabled: true },
      ],
      toggles: true,
    });

    // Removing ours leaves the user's layer alone again.
    await mcp.act('remove', [], ['demo', 'other']);
    expect(layerOf(dir).trimEnd()).toBe(mine);
  });
});

describe('a layer this bridge cannot read', () => {
  it('says so instead of losing the servers quietly', async () => {
    const dir = profile(
      `# --- CodeDeck+ MCP servers: managed from the MCP screen; everything outside this block is yours ---\n: not: yaml: [\n# --- end CodeDeck+ MCP servers ---`,
    );
    await expect(manager(dir).list()).rejects.toThrow(/not valid YAML/);
  });
});

describe('the profile layer', () => {
  it('is created when the profile has none yet', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codedeck-dsh-mcp-'));
    mkdirSync(path.join(dir, 'profiles'), { recursive: true });
    const profileDir = path.join(dir, 'profiles', 'acp');
    await manager(profileDir).act('add', [stdio('demo')], []);
    expect(readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8')).toMatch(/codedeck-mcp-demo/);
  });
});
