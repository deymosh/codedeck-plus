/**
 * OpenCode's MCP servers for the whole machine: the `mcp` section of its
 * global config, which every project loads and the `opencode` terminal uses
 * too.
 *
 * The config file is where a server lasts. V2's MCP API changes only the
 * running inventory (verified against 2.1.4): a server added through it is
 * gone at the next start, a removed one comes back, and a `disconnect` is
 * forgotten. So every change here is written to the global config file,
 * which 2.1.4 watches and applies to the running server within half a second
 * (verified: an added entry is listed, a removed one leaves, `enabled:
 * false` reads as disabled). An add still goes through `mcp.add` first: the
 * server checks the entry there, and an entry it refuses must never reach
 * the file, where it would spoil the config every project loads.
 *
 * In the file a server is `mcp: {name: entry}` (2.1.4 also reads `mcp:
 * {servers: {…}}`, which is kept when a file already uses it), and the off
 * switch is `enabled: false` — a `disabled` flag in the file is ignored.
 *
 * In a session, a server is connected or disconnected for the session's
 * project — OpenCode has no narrower scope — so the switch is project-wide.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { OpenCodeClient } from '@opencode/client';
import type { McpManager, McpState, SessionMcpState } from '../../sdk/driver';
import { mcpStatus, serverInfo, setupSecrets } from '../../sdk/mcp';
import { redactSecrets } from '../../sdk/redact';
import type { McpAction, McpServerAdd, McpServerInfo } from '../../sdk/types';
import { openCodeGlobalConfigFiles } from './plugins';

/** A server as OpenCode v2's config holds it. Absent env or headers are left
 *  out entirely: an add replaces the whole entry, so nothing of an earlier
 *  server of that name can linger. */
export function openCodeServerConfig(add: McpServerAdd): Record<string, unknown> {
  const s = add.setup;
  const map = (m: Record<string, string> | undefined) => (m && Object.keys(m).length ? m : undefined);
  return s.type === 'stdio'
    ? { type: 'local', command: [s.command, ...(s.args ?? [])], ...(map(s.env) ? { environment: map(s.env) } : {}) }
    : // OpenCode's remote transport negotiates streamable HTTP or SSE itself.
      { type: 'remote', url: s.url, ...(map(s.headers) ? { headers: map(s.headers) } : {}) };
}

/** The servers a config's `mcp` map holds, secret-free: the command, URL and
 *  key names, and the file's own off switch. */
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

/** One global config file and the server map in it. */
interface ConfigFile {
  path: string;
  config: Record<string, unknown>;
  /** The map servers live in: the `mcp` section itself, or its `servers`. */
  servers: Record<string, unknown>;
  /** Whether the file nests its servers under `servers`. */
  nested: boolean;
}

/** The server map of a config's `mcp` section, in whichever spelling the
 *  file uses. A `servers` key holding entries rather than one entry (it has
 *  no `type`) is the nested spelling. */
function serverMap(mcp: unknown): { servers: Record<string, unknown>; nested: boolean } {
  if (!mcp || typeof mcp !== 'object') return { servers: {}, nested: false };
  const section = mcp as Record<string, unknown>;
  const inner = section.servers;
  if (inner && typeof inner === 'object' && !('type' in inner)) {
    return { servers: { ...(inner as Record<string, unknown>) }, nested: true };
  }
  return { servers: { ...section }, nested: false };
}

export class OpenCodeMcp implements McpManager {
  /** One change at a time: each reads the files, then writes one. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly client: () => Promise<OpenCodeClient>,
    private readonly configFiles: () => string[] = () => openCodeGlobalConfigFiles(),
  ) {}

  list(): Promise<McpState> {
    return this.serial(async () => this.state(await this.readable()));
  }

  act(action: McpAction, servers: McpServerAdd[], names: string[]): Promise<McpState> {
    return this.serial(async () => {
      if (action === 'add') {
        // A refusal can quote the config it was handed — env, headers and
        // all. The setup's credential values are removed before it travels.
        const secrets = servers.flatMap((add) => setupSecrets(add.setup));
        const client = await this.client();
        for (const add of servers) {
          const config = openCodeServerConfig(add);
          await this.call(`add ${add.name}`, () => client.mcp.add({ server: add.name, config: config as never }), secrets);
          // A name another file already holds is replaced there, so the
          // machine never has two entries for it.
          const file = (await this.holding(add.name)) ?? (await this.writable());
          file.servers[add.name] = config;
          await this.write(file);
        }
      } else {
        for (const name of names) {
          const file = await this.holding(name);
          if (!file) throw new Error(`OpenCode has no MCP server '${name}'.`);
          if (action === 'remove') {
            delete file.servers[name];
          } else {
            const entry = { ...(file.servers[name] as Record<string, unknown>) };
            if (action === 'disable') entry.enabled = false;
            else delete entry.enabled;
            file.servers[name] = entry;
          }
          await this.write(file);
        }
      }
      return this.state(await this.readable());
    });
  }

  /** Every global config file that exists and parses, in OpenCode's order. */
  private async readable(): Promise<ConfigFile[]> {
    const out: ConfigFile[] = [];
    for (const file of this.configFiles().filter((f) => existsSync(f))) {
      try {
        const config = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
        out.push({ path: file, config, ...serverMap(config.mcp) });
      } catch {
        // A file with comments is the user's own; it is read by OpenCode,
        // but not here (see `holding`).
        continue;
      }
    }
    return out;
  }

  /** The file holding `name`, ready to be written. A file that is not plain
   *  JSON stops the change: rewriting it would lose the user's comments. */
  private async holding(name: string): Promise<ConfigFile | undefined> {
    for (const file of this.configFiles().filter((f) => existsSync(f))) {
      const text = await readFile(file, 'utf8');
      let config: Record<string, unknown>;
      try {
        config = JSON.parse(text) as Record<string, unknown>;
      } catch {
        if (text.includes(`"${name}"`)) {
          throw new Error(`${file} has comments, so it is not edited from here. Edit its "mcp" section by hand.`);
        }
        continue;
      }
      const map = serverMap(config.mcp);
      if (name in map.servers) return { path: file, config, ...map };
    }
    return undefined;
  }

  /** The file a new server goes to: the first one that exists, or a new
   *  `opencode.json` in OpenCode's global config directory, which it reads
   *  at the next start and watches from then on. */
  private async writable(): Promise<ConfigFile> {
    const files = this.configFiles();
    const existing = files.find((f) => existsSync(f));
    if (!existing) {
      const fresh = files.find((f) => path.basename(f) === 'opencode.json') ?? files[0]!;
      return { path: fresh, config: {}, servers: {}, nested: false };
    }
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(await readFile(existing, 'utf8')) as Record<string, unknown>;
    } catch {
      throw new Error(`${existing} has comments, so it is not edited from here. Add the server to its "mcp" section by hand.`);
    }
    return { path: existing, config, ...serverMap(config.mcp) };
  }

  private async write(file: ConfigFile): Promise<void> {
    const section = file.config.mcp && typeof file.config.mcp === 'object' ? (file.config.mcp as Record<string, unknown>) : {};
    const mcp = file.nested ? { ...section, servers: file.servers } : file.servers;
    await mkdir(path.dirname(file.path), { recursive: true });
    await writeFile(file.path, `${JSON.stringify({ ...file.config, mcp }, null, 2)}\n`);
  }

  private async call(what: string, work: () => Promise<unknown>, secrets: readonly string[] = []): Promise<void> {
    try {
      await work();
    } catch (err) {
      throw new Error(redactSecrets(`OpenCode could not ${what}: ${reason(err)}`, secrets));
    }
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  /** What the files hold. A name in more than one file is shown as the first
   *  file has it: that is the entry a change here edits. */
  private state(files: ConfigFile[]): McpState {
    const merged: Record<string, unknown> = {};
    for (const file of [...files].reverse()) Object.assign(merged, file.servers);
    return { servers: openCodeServers(merged), toggles: true };
  }
}

/** A session's servers, as OpenCode reports them for its project. */
export async function openCodeSessionMcp(client: OpenCodeClient, directory: string): Promise<SessionMcpState> {
  const listed = await client.mcp.list({ location: { directory } }).catch((err: unknown) => {
    throw new Error(`OpenCode could not report its MCP servers: ${reason(err)}`);
  });
  const servers = listed.data
    .map((s) => ({
      name: s.name,
      status: mcpStatus(s.status.status),
      ...(s.status.status === 'failed' ? { error: s.status.error } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { servers, toggles: true, projectWide: true };
}

/** Connect or disconnect one server for a session's project. */
export async function toggleOpenCodeMcp(
  client: OpenCodeClient,
  directory: string,
  name: string,
  enabled: boolean,
): Promise<SessionMcpState> {
  try {
    if (enabled) await client.mcp.connect({ server: name, location: { directory } });
    else await client.mcp.disconnect({ server: name, location: { directory } });
  } catch (err) {
    throw new Error(`OpenCode could not ${enabled ? 'connect' : 'disconnect'} ${name}: ${reason(err)}`);
  }
  return openCodeSessionMcp(client, directory);
}

/** A client error's reason, as a string. */
function reason(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return err instanceof Error ? err.message : String(err);
}
