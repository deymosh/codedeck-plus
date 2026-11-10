/**
 * Qwen Code's MCP servers for the whole machine: the `mcpServers` map of its
 * `settings.json` under `$QWEN_HOME`, which every session loads and the
 * `qwen` terminal uses too. A server is switched off without being removed
 * by naming it in `mcp.excluded` — the list Qwen Code's own enable and
 * disable commands edit.
 *
 * A Qwen Code process reads its servers as it starts, so every change bumps
 * `version`: the process pool starts later sessions on a fresh process that
 * loads the new set, while a running session keeps its own.
 *
 * Entries take Qwen Code's own keys: `command`/`args`/`env` for a stdio
 * server, `httpUrl` for a streamable HTTP one and `url` for SSE, each with
 * `headers`. A server's env and header values are kept in the file, as every
 * agent keeps them in its own configuration; the driver writes it owner-only.
 */
import type { McpManager, McpState } from '../../sdk/driver';
import { serverInfo } from '../../sdk/mcp';
import type { McpAction, McpServerAdd, McpServerInfo } from '../../sdk/types';
import type { QwenSettingsFile } from './settings';

/** A server as Qwen Code's settings take it: the phone's setup, secrets in
 *  place. */
export function qwenServerJson(add: McpServerAdd): Record<string, unknown> {
  const s = add.setup;
  switch (s.type) {
    case 'stdio':
      return {
        command: s.command,
        args: s.args ?? [],
        ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}),
      };
    case 'http':
      return { httpUrl: s.url, ...(s.headers && Object.keys(s.headers).length ? { headers: s.headers } : {}) };
    case 'sse':
      return { url: s.url, ...(s.headers && Object.keys(s.headers).length ? { headers: s.headers } : {}) };
  }
}

/** The servers in a settings document, secret-free. */
export function qwenServers(settings: Record<string, unknown>): McpServerInfo[] {
  const servers = record(settings.mcpServers);
  const excluded = excludedOf(settings);
  const out: McpServerInfo[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as { command?: unknown; url?: unknown; httpUrl?: unknown; env?: unknown; headers?: unknown };
    const keys = (v: unknown) => (v && typeof v === 'object' ? Object.keys(v) : []);
    const transport = typeof r.httpUrl === 'string' ? 'http' : typeof r.url === 'string' ? 'sse' : typeof r.command === 'string' ? 'stdio' : undefined;
    if (transport === undefined) continue;
    out.push(
      serverInfo({
        name,
        transport,
        ...(typeof r.command === 'string' ? { command: r.command } : {}),
        ...(transport === 'http' ? { url: r.httpUrl as string } : transport === 'sse' ? { url: r.url as string } : {}),
        envKeys: keys(r.env),
        headerKeys: keys(r.headers),
        enabled: !excluded.includes(name),
      }),
    );
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** `settings` with one change applied. Throws, changing nothing, when the
 *  change names a server that is not there. */
export function applyQwenMcp(
  settings: Record<string, unknown>,
  action: McpAction,
  servers: McpServerAdd[],
  names: string[],
): Record<string, unknown> {
  const map = { ...record(settings.mcpServers) };
  let excluded = excludedOf(settings);
  if (action === 'add') {
    for (const server of servers) {
      if (server.name.trim() === '') throw new Error('An MCP server needs a name.');
      // Added again replaces it, and an added server is on.
      map[server.name] = qwenServerJson(server);
      excluded = excluded.filter((name) => name !== server.name);
    }
  } else {
    const missing = names.filter((name) => !(name in map));
    if (missing.length > 0) throw new Error(`Qwen Code has no MCP server named ${missing.join(', ')}.`);
    for (const name of names) {
      excluded = excluded.filter((n) => n !== name);
      if (action === 'remove') delete map[name];
      else if (action === 'disable') excluded.push(name);
    }
  }
  const mcp = { ...record(settings.mcp) };
  if (excluded.length > 0) mcp.excluded = excluded;
  else delete mcp.excluded;
  const next: Record<string, unknown> = { ...settings, mcpServers: map };
  if (Object.keys(mcp).length > 0) next.mcp = mcp;
  else delete next.mcp;
  return next;
}

export class QwenMcp implements McpManager {
  /** How many times this manager changed the servers. A process records it
   *  as it starts, so a change made afterwards is configuration that process
   *  has not loaded. */
  private versions = 0;

  constructor(private readonly settings: QwenSettingsFile) {}

  get version(): number {
    return this.versions;
  }

  async list(): Promise<McpState> {
    return { servers: qwenServers(await this.settings.read()), toggles: true };
  }

  async act(action: McpAction, servers: McpServerAdd[], names: string[]): Promise<McpState> {
    const next = await this.settings.edit((existing) => applyQwenMcp(existing, action, servers, names));
    this.versions++;
    return { servers: qwenServers(next), toggles: true };
  }
}

function excludedOf(settings: Record<string, unknown>): string[] {
  const excluded = record(settings.mcp).excluded;
  return Array.isArray(excluded) ? excluded.filter((name): name is string => typeof name === 'string') : [];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
