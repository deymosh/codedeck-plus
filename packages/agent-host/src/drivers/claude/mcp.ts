/**
 * Claude Code's MCP servers for the whole machine: its user scope, which
 * every session loads and the `claude` terminal uses too. Changes go through
 * its own CLI (`claude mcp add-json` / `claude mcp remove`, `-s user`), which
 * keeps the config file consistent while sessions also write to it; the list
 * is read from that file (`$CLAUDE_CONFIG_DIR/.claude.json`, else
 * `~/.claude.json`), since `claude mcp list` health-checks every server.
 *
 * The CLI's arguments never pass through a shell, and a server name always
 * follows `--`. Claude Code has no user-scope switch to turn a server off
 * without removing it, so the library has no toggles; a server is switched
 * off per session instead.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { McpManager, McpState } from '../../sdk/driver';
import { serverInfo } from '../../sdk/mcp';
import type { McpAction, McpServerAdd, McpServerInfo } from '../../sdk/types';
import { failureMessage, type CliRunner } from './plugins';

const CHANGE_TIMEOUT_MS = 60_000;

/** Where Claude Code keeps its user-scope MCP servers. */
export function claudeUserConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  return dir ? path.join(dir, '.claude.json') : path.join(homedir(), '.claude.json');
}

/** A server as `add-json` takes it: the phone's setup, secrets in place. */
export function claudeServerJson(add: McpServerAdd): Record<string, unknown> {
  const s = add.setup;
  switch (s.type) {
    case 'stdio':
      return {
        type: 'stdio',
        command: s.command,
        args: s.args ?? [],
        ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}),
      };
    case 'http':
    case 'sse':
      return {
        type: s.type,
        url: s.url,
        ...(s.headers && Object.keys(s.headers).length ? { headers: s.headers } : {}),
      };
  }
}

/** The user-scope servers in Claude Code's config file, secret-free. */
export function claudeServers(config: unknown): McpServerInfo[] {
  const servers = (config as { mcpServers?: unknown } | null)?.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  const out: McpServerInfo[] = [];
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as { type?: unknown; command?: unknown; url?: unknown; env?: unknown; headers?: unknown };
    const keys = (v: unknown) => (v && typeof v === 'object' ? Object.keys(v) : []);
    const type = typeof r.type === 'string' ? r.type : typeof r.url === 'string' ? 'http' : 'stdio';
    if (type !== 'stdio' && type !== 'http' && type !== 'sse') continue;
    out.push(
      serverInfo({
        name,
        transport: type,
        ...(typeof r.command === 'string' ? { command: r.command } : {}),
        ...(typeof r.url === 'string' ? { url: r.url } : {}),
        envKeys: keys(r.env),
        headerKeys: keys(r.headers),
        enabled: true,
      }),
    );
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export class ClaudeMcp implements McpManager {
  constructor(
    private readonly run: CliRunner,
    /** Tells the running sessions to load the servers as they now are. */
    private readonly onChanged: () => Promise<void>,
    private readonly configFile: () => string = () => claudeUserConfigFile(),
  ) {}

  async list(): Promise<McpState> {
    let text: string;
    try {
      text = await readFile(this.configFile(), 'utf8');
    } catch {
      // No config yet: Claude Code has not run here, so nothing is set up.
      return { servers: [], toggles: false };
    }
    let config: unknown;
    try {
      config = JSON.parse(text);
    } catch {
      throw new Error("Claude Code's configuration file could not be read.");
    }
    return { servers: claudeServers(config), toggles: false };
  }

  async act(action: McpAction, servers: McpServerAdd[], names: string[]): Promise<McpState> {
    const runs: string[][] =
      action === 'add'
        ? servers.map((s) => ['mcp', 'add-json', '-s', 'user', '--', s.name, JSON.stringify(claudeServerJson(s))])
        : action === 'remove'
          ? names.map((n) => ['mcp', 'remove', '-s', 'user', '--', n])
          : [];
    if (runs.length === 0) {
      throw new Error('Claude Code cannot switch a server off without removing it. Switch it off in a session instead.');
    }
    for (const args of runs) {
      // A server added again replaces the old one: `add-json` refuses a
      // name that exists, so it is removed first (a missing one is fine).
      if (action === 'add') await this.run(['mcp', 'remove', '-s', 'user', '--', args[5]!], CHANGE_TIMEOUT_MS);
      const result = await this.run(args, CHANGE_TIMEOUT_MS);
      if (result.code !== 0) throw new Error(failureMessage(result));
    }
    await this.onChanged().catch(() => {});
    return this.list();
  }
}
