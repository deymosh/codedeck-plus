/**
 * OpenCode's MCP servers for the whole machine: the `mcp` section of its
 * global config, which every project loads and the `opencode` terminal uses
 * too.
 *
 * OpenCode's server merges a config update into what it has — a server left
 * out stays, and a field left out keeps its old value — so an added server
 * is written whole, with the env or headers it no longer has cleared by
 * `null`. Its API cannot delete a server at all, so removing one edits the
 * global config file itself and has the server reload: only a file that is
 * plain JSON (what OpenCode itself writes), so no comment of the user's is
 * lost; a hand-edited file with comments is left alone, with the reason.
 * Every config change reloads the projects OpenCode has open, which restarts
 * their running sessions, as for any change to its config.
 *
 * In a session, a server is connected or disconnected for the session's
 * project — OpenCode has no narrower scope — so the switch is project-wide.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import type { McpManager, McpState, SessionMcpState } from '../../driver';
import { mcpStatus, serverInfo } from '../../mcp';
import type { McpAction, McpServerAdd, McpServerInfo } from '../../types';

type RawConfig = Record<string, unknown>;

/** The files OpenCode reads its global config from. */
export function openCodeGlobalConfigFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const base = env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), '.config');
  return ['config.json', 'opencode.json', 'opencode.jsonc'].map((f) => path.join(base, 'opencode', f));
}

/** A server as OpenCode's config holds it. Absent env or headers are
 *  `null`, which clears what an earlier server of that name had. */
export function openCodeServerConfig(add: McpServerAdd, enabled = true): RawConfig {
  const s = add.setup;
  const map = (m: Record<string, string> | undefined) => (m && Object.keys(m).length ? m : null);
  return s.type === 'stdio'
    ? { type: 'local', command: [s.command, ...(s.args ?? [])], environment: map(s.env), enabled }
    : // OpenCode's remote transport negotiates streamable HTTP or SSE itself.
      { type: 'remote', url: s.url, headers: map(s.headers), enabled };
}

/** The servers in OpenCode's `mcp` config section, secret-free. */
export function openCodeServers(mcp: unknown): McpServerInfo[] {
  if (!mcp || typeof mcp !== 'object') return [];
  const out: McpServerInfo[] = [];
  for (const [name, raw] of Object.entries(mcp as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as { type?: unknown; command?: unknown; url?: unknown; environment?: unknown; headers?: unknown; enabled?: unknown };
    const keys = (v: unknown) => (v && typeof v === 'object' ? Object.keys(v) : []);
    const enabled = r.enabled !== false;
    if (r.type === 'local' && Array.isArray(r.command) && typeof r.command[0] === 'string') {
      out.push(serverInfo({ name, transport: 'stdio', command: r.command[0], envKeys: keys(r.environment), enabled }));
    } else if (r.type === 'remote' && typeof r.url === 'string') {
      out.push(serverInfo({ name, transport: 'http', url: r.url, headerKeys: keys(r.headers), enabled }));
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export class OpenCodeMcp implements McpManager {
  /** One config change at a time: each reads, then writes. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly client: () => Promise<OpencodeClient>,
    private readonly configFiles: () => string[] = () => openCodeGlobalConfigFiles(),
  ) {}

  list(): Promise<McpState> {
    return this.serial(async () => this.state(await this.mcp(await this.client())));
  }

  act(action: McpAction, servers: McpServerAdd[], names: string[]): Promise<McpState> {
    return this.serial(async () => {
      const client = await this.client();
      if (action === 'remove') {
        await this.remove(names);
        await client.global.dispose().catch(() => {});
        return this.state(await this.mcp(client));
      }
      const current = await this.mcp(client);
      let patch: Record<string, RawConfig>;
      if (action === 'add') {
        patch = Object.fromEntries(servers.map((s) => [s.name, openCodeServerConfig(s)]));
      } else {
        const missing = names.find((n) => !current[n]);
        if (missing) throw new Error(`OpenCode has no MCP server '${missing}'.`);
        patch = Object.fromEntries(names.map((n) => [n, { ...(current[n] as RawConfig), enabled: action === 'enable' }]));
      }
      const { error } = await client.global.config.update({ config: { mcp: patch } as never });
      if (error) throw new Error(`OpenCode refused the change: ${JSON.stringify(error)}`);
      return this.state(await this.mcp(client));
    });
  }

  /** Delete `names` from every global config file that has them. */
  private async remove(names: string[]): Promise<void> {
    const edits: [string, RawConfig][] = [];
    const found = new Set<string>();
    for (const file of this.configFiles().filter((f) => existsSync(f))) {
      const text = await readFile(file, 'utf8');
      let config: RawConfig;
      try {
        config = JSON.parse(text) as RawConfig;
      } catch {
        if (names.some((n) => text.includes(`"${n}"`))) {
          throw new Error(`${file} has comments, so it is not edited from here. Remove the server from it by hand.`);
        }
        continue;
      }
      const mcp = config.mcp as Record<string, unknown> | undefined;
      const here = names.filter((n) => mcp && n in mcp);
      if (!mcp || here.length === 0) continue;
      for (const n of here) {
        delete mcp[n];
        found.add(n);
      }
      edits.push([file, config]);
    }
    const missing = names.find((n) => !found.has(n));
    if (missing) throw new Error(`OpenCode's global config has no MCP server '${missing}'.`);
    for (const [file, config] of edits) await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private async mcp(client: OpencodeClient): Promise<Record<string, unknown>> {
    const { data, error } = await client.global.config.get();
    if (error || !data) throw new Error(`OpenCode could not read its config: ${JSON.stringify(error ?? 'no config')}`);
    return ((data as { mcp?: Record<string, unknown> }).mcp ?? {}) as Record<string, unknown>;
  }

  private state(mcp: Record<string, unknown>): McpState {
    return { servers: openCodeServers(mcp), toggles: true };
  }
}

/** A session's servers, as OpenCode reports them for its project. */
export async function openCodeSessionMcp(client: OpencodeClient, directory: string): Promise<SessionMcpState> {
  const { data, error } = await client.mcp.status({ directory });
  if (error || !data) throw new Error(`OpenCode could not report its MCP servers: ${JSON.stringify(error ?? 'no status')}`);
  const servers = Object.entries(data as Record<string, { status?: string; error?: string }>)
    .map(([name, s]) => ({ name, status: mcpStatus(s?.status), ...(s?.error ? { error: s.error } : {}) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { servers, toggles: true, projectWide: true };
}

/** Connect or disconnect one server for a session's project. */
export async function toggleOpenCodeMcp(client: OpencodeClient, directory: string, name: string, enabled: boolean): Promise<SessionMcpState> {
  const { error } = enabled ? await client.mcp.connect({ name, directory }) : await client.mcp.disconnect({ name, directory });
  if (error) throw new Error(`OpenCode could not ${enabled ? 'connect' : 'disconnect'} ${name}: ${JSON.stringify(error)}`);
  return openCodeSessionMcp(client, directory);
}
