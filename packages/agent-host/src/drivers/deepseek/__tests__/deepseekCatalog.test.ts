/**
 * The endpoint the harness is pointed at: reading the models it serves, and
 * writing them into the harness's own profile as its catalog — beside the
 * block the MCP list owns, since both live in that one file.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DeepSeekMcp } from '../mcp';
import { fetchEndpointCatalog, renderCatalogLayer, syncEndpointCatalog } from '../catalog';

function profile(initial = '# Your patch layer for this dsh profile.\n[]\n'): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'codedeck-dsh-gateway-'));
  writeFileSync(path.join(dir, 'cordis.patch.yml'), initial);
  return dir;
}

const layerOf = (dir: string): string => readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8');

/** A gateway answering with `body`. */
const answering = (body: unknown, status = 200, expectUrl?: string, expectKey?: string) =>
  vi.fn(async (url: string, headers: Record<string, string>) => {
    if (expectUrl !== undefined) expect(url).toBe(expectUrl);
    if (expectKey !== undefined) expect(headers.authorization).toBe(`Bearer ${expectKey}`);
    return { status, text: typeof body === 'string' ? body : JSON.stringify(body) };
  });

describe('the model list the endpoint serves', () => {
  it('is asked with the key, and answered with the endpoint as the harness reads it', async () => {
    const httpGet = answering({ data: [{ id: 'kimi-k2' }] }, 200, 'http://gw.example/v1/models', 'sk-1');
    const catalog = await fetchEndpointCatalog('http://gw.example/', 'sk-1', httpGet, () => {});
    expect(catalog).toEqual({ baseUrl: 'http://gw.example', models: [{ id: 'kimi-k2' }], defaultModel: 'kimi-k2' });
  });

  it('answers nothing — and says so — when the endpoint refuses, breaks or lists nothing', async () => {
    const logs: string[] = [];
    const log = (line: string): void => {
      logs.push(line);
    };
    expect(await fetchEndpointCatalog('http://gw.example', 'sk', answering({}, 401), log)).toBeUndefined();
    expect(await fetchEndpointCatalog('http://gw.example', 'sk', answering('<html>', 200), log)).toBeUndefined();
    expect(await fetchEndpointCatalog('http://gw.example', 'sk', answering({ data: [] }, 200), log)).toBeUndefined();
    expect(
      await fetchEndpointCatalog('http://gw.example', 'sk', async () => {
        throw new Error('ECONNREFUSED');
      }, log),
    ).toBeUndefined();
    expect(logs.some((line) => /refused the token \(HTTP 401\)/.test(line))).toBe(true);
    expect(logs.some((line) => /lists no models/.test(line))).toBe(true);
    expect(logs.some((line) => /ECONNREFUSED/.test(line))).toBe(true);
  });
});

describe('the catalog the harness reads', () => {
  it('is a row over the deployment entry, carrying the models and never the endpoint', () => {
    const rows = renderCatalogLayer({
      baseUrl: 'http://gw.example',
      models: [{ id: 'kimi-k2' }, { id: 'glm-4.6', contextWindow: 200_000 }],
      defaultModel: 'kimi-k2',
    });
    expect(rows).toMatch(/^- id: llm-deepseek/m);
    // An endpoint in the shared profile would outrank the one a provider-bound
    // session's own environment names, and take that profile's token to the
    // operator's gateway.
    expect(rows).not.toMatch(/baseURL/);
    expect(rows).not.toMatch(/gw\.example/);
    expect(rows).toMatch(/id: kimi-k2/);
    expect(rows).toMatch(/contextWindow: 200000/);
    // And the model a session starts on moves with the catalog: the harness
    // always offers the model it is on, so a default it does not serve would
    // show up as one nobody can run.
    expect(rows).toMatch(/^- id: acp$/m);
    expect(rows).toMatch(/^- id: agent-default-model/m);
    expect(rows).toMatch(/provider: deepseek-official/);
    expect(rows).toMatch(/model: kimi-k2/);
  });

  it('is written beside the MCP block without disturbing it, and taken back out again', async () => {
    const dir = profile();
    await new DeepSeekMcp({ profileDir: dir, log: () => {} }).act('add', [{ name: 'demo', setup: { type: 'stdio', command: '/usr/bin/demo' } }], []);
    await syncEndpointCatalog({ profileDir: dir, log: () => {}, httpGet: answering({ data: [{ id: 'kimi-k2' }] }) }, 'http://gw.example', 'sk-1');
    const both = layerOf(dir);
    expect(both).toMatch(/CodeDeck\+ MCP servers/);
    expect(both).toMatch(/serverName: demo/);
    expect(both).toMatch(/CodeDeck\+ gateway catalog/);
    expect(both).toMatch(/id: kimi-k2/);

    // The MCP list still reads exactly what it wrote.
    expect((await new DeepSeekMcp({ profileDir: dir, log: () => {} }).list()).servers).toEqual([
      { name: 'demo', transport: 'stdio', target: '/usr/bin/demo', enabled: true },
    ]);

    // No endpoint any more: its block goes, the MCP one stays.
    await syncEndpointCatalog({ profileDir: dir, log: () => {} }, undefined, undefined);
    const after = layerOf(dir);
    expect(after).not.toMatch(/gateway catalog/);
    expect(after).toMatch(/serverName: demo/);
  });

  it('stays as it was when the endpoint cannot be read', async () => {
    const dir = profile();
    const wrote = await syncEndpointCatalog({ profileDir: dir, log: () => {} }, 'http://gw.example', 'sk-1');
    expect(wrote).toBe(false);
    expect(layerOf(dir)).toBe('# Your patch layer for this dsh profile.\n[]\n');
  });

  it('is written only when it changed', async () => {
    const dir = profile();
    const httpGet = answering({ data: [{ id: 'kimi-k2' }] });
    expect(await syncEndpointCatalog({ profileDir: dir, log: () => {}, httpGet }, 'http://gw.example', 'sk-1')).toBe(true);
    expect(await syncEndpointCatalog({ profileDir: dir, log: () => {}, httpGet }, 'http://gw.example', 'sk-1')).toBe(false);
  });
});
