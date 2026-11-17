/**
 * Pi's MCP servers for the whole machine: the `mcpServers` map of `mcp.json`
 * in Pi's home — the file `pi mcp add` and `/mcp` edit, which every Pi
 * session on that home loads, in CodeDeck or in a terminal.
 *
 * The format is the common one (Pi's docs/mcp.md): `command`/`args`/`env`
 * for a stdio server, `url`/`headers` for a streamable HTTP one, and
 * `enabled: false` to keep a server without connecting it. Pi rejects the
 * legacy SSE transport, so an SSE server is refused here rather than
 * written into a file Pi would then report as invalid. A name is what Pi
 * accepts: letters, digits, `_` and `-`.
 *
 * A Pi process connects its servers as its session starts: a change reaches
 * the sessions started after it, while a running one keeps its own set.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { McpManager, McpState } from '../../sdk/driver';
import { serverInfo } from '../../sdk/mcp';
import type { McpAction, McpServerAdd, McpServerInfo } from '../../sdk/types';

/** What Pi accepts as a server name (docs/mcp.md, "Configuration rules"). */
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/** A server as Pi's `mcp.json` takes it: the phone's setup, secrets in
 *  place (the file is owner-only). */
export function piServerJson(add: McpServerAdd): Record<string, unknown> {
  const s = add.setup;
  switch (s.type) {
    case 'stdio':
      return {
        command: s.command,
        args: s.args ?? [],
        ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}),
      };
    case 'http':
      return { url: s.url, ...(s.headers && Object.keys(s.headers).length ? { headers: s.headers } : {}) };
    case 'sse':
      throw new Error(`Pi does not support SSE MCP servers ('${add.name}'): most of them also serve streamable HTTP, often at /mcp.`);
  }
}

/** The servers in an `mcp.json` document, secret-free. */
export function piServers(config: Record<string, unknown>): McpServerInfo[] {
  const out: McpServerInfo[] = [];
  for (const [name, raw] of Object.entries(record(config.mcpServers))) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as { command?: unknown; url?: unknown; env?: unknown; headers?: unknown; enabled?: unknown };
    const keys = (v: unknown) => (v && typeof v === 'object' ? Object.keys(v) : []);
    const transport = typeof r.url === 'string' ? 'http' : typeof r.command === 'string' ? 'stdio' : undefined;
    if (transport === undefined) continue;
    out.push(
      serverInfo({
        name,
        transport,
        ...(typeof r.command === 'string' ? { command: r.command } : {}),
        ...(transport === 'http' ? { url: r.url as string } : {}),
        envKeys: keys(r.env),
        headerKeys: keys(r.headers),
        enabled: r.enabled !== false,
      }),
    );
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** `config` with one change applied. Throws, changing nothing, when the
 *  change cannot be made as asked. */
export function applyPiMcp(
  config: Record<string, unknown>,
  action: McpAction,
  servers: McpServerAdd[],
  names: string[],
): Record<string, unknown> {
  const map = { ...record(config.mcpServers) };
  if (action === 'add') {
    for (const server of servers) {
      if (!SERVER_NAME.test(server.name)) {
        throw new Error(`Pi cannot name an MCP server '${server.name}': use letters, digits, '_' and '-'.`);
      }
      // Added again replaces it, and an added server is on.
      map[server.name] = piServerJson(server);
    }
  } else {
    const missing = names.filter((name) => !Object.hasOwn(map, name));
    if (missing.length > 0) throw new Error(`Pi has no MCP server named ${missing.join(', ')}.`);
    for (const name of names) {
      if (action === 'remove') {
        delete map[name];
        continue;
      }
      const entry = { ...record(map[name]) };
      if (action === 'disable') entry.enabled = false;
      else delete entry.enabled;
      map[name] = entry;
    }
  }
  return { ...config, mcpServers: map };
}

/** Pi's `mcp.json`, every edit waiting for the one before it: two
 *  overlapping rewrites of one file would keep only the last. */
export class PiMcp implements McpManager {
  private queue: Promise<unknown> = Promise.resolve();
  private changes = 0;

  /** How many changes this manager has made: a session that recorded fewer
   *  as its Pi started has not loaded the servers as they are now. */
  get version(): number {
    return this.changes;
  }

  constructor(
    private readonly home: string,
    private readonly log: (message: string) => void,
  ) {}

  async list(): Promise<McpState> {
    return { servers: piServers(await this.serial(() => this.read())), toggles: true };
  }

  async act(action: McpAction, servers: McpServerAdd[], names: string[]): Promise<McpState> {
    const next = await this.serial(async () => {
      const existing = await this.read();
      const edited = applyPiMcp(existing, action, servers, names);
      // A change that changes nothing (switching on a server that is on)
      // leaves running sessions as current as they were.
      if (JSON.stringify(edited) !== JSON.stringify(existing)) {
        await this.write(edited);
        this.changes += 1;
      }
      return edited;
    });
    return { servers: piServers(next), toggles: true };
  }

  private get file(): string {
    return path.join(this.home, 'mcp.json');
  }

  /** A missing or unreadable file is an empty configuration. */
  private async read(): Promise<Record<string, unknown>> {
    try {
      return record(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (error) {
      // Only the kind of failure: a JSON error quotes the text around it,
      // and the file holds servers' env and header values.
      const code = (error as { code?: string }).code;
      if (code !== 'ENOENT') {
        this.log(`[pi] ${this.file} could not be read (${code ?? (error instanceof SyntaxError ? 'not valid JSON' : 'unreadable')}) — treating it as empty`);
      }
      return {};
    }
  }

  /** Written beside the file and renamed over it, so a Pi that starts
   *  meanwhile reads the old servers or the new ones, never half of either;
   *  owner-only, for the env and header values it keeps. */
  private async write(config: Record<string, unknown>): Promise<void> {
    await mkdir(this.home, { recursive: true });
    const staged = `${this.file}.${process.pid}.tmp`;
    try {
      await writeFile(staged, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(staged, this.file);
    } catch (error) {
      await rm(staged, { force: true });
      throw error;
    }
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
