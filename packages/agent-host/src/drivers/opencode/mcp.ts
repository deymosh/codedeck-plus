/**
 * OpenCode's MCP servers for the whole machine: the `mcp` section of its
 * global config, which every project loads and the `opencode` terminal uses
 * too.
 *
 * The config file is where a server lasts. V2's MCP API changes only the
 * running inventory (verified against 2.1.4): a server added through it is
 * gone at the next start, a removed one comes back, and a `disconnect` is
 * forgotten. So every change here is written to the global config files
 * (`globalConfig.ts`: JSONC, edited in place as OpenCode edits them), which
 * 2.1.4 watches and applies to the running server within half a second
 * (verified: an added entry is listed, a removed one leaves, `enabled:
 * false` reads as disabled). An add still goes through `mcp.add` first: the
 * server checks the entry there, and an entry it refuses must never reach
 * the file, where it would spoil the config every project loads.
 *
 * In a file a server is `mcp: {name: entry}` (2.1.4 also reads `mcp:
 * {servers: {…}}`, which is kept when a file already uses it), and the off
 * switch is `enabled: false` — a `disabled` flag in the file is ignored. A
 * later file overrides an earlier one, so a name is listed as the last file
 * holding it says, and a change reaches every file that holds it.
 *
 * In a session, a server is connected or disconnected for the session's
 * project — OpenCode has no narrower scope — so the switch is project-wide.
 */
import type { OpenCodeClient } from '@opencode/client';
import type { McpManager, McpState, SessionMcpState } from '../../sdk/driver';
import { mcpStatus, serverInfo, setupSecrets } from '../../sdk/mcp';
import { redactSecrets } from '../../sdk/redact';
import type { McpAction, McpServerAdd, McpServerInfo } from '../../sdk/types';
import { type ConfigEdit, editGlobalConfig, type GlobalConfig, newEntryFile, openCodeGlobalConfigFiles, readGlobalConfig, readGlobalConfigs } from './globalConfig';

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

const configFile = ({ path, config }: GlobalConfig): ConfigFile => ({ path, ...serverMap(config.mcp) });

/** Where server `name`'s entry is in a file. */
const entryPath = (file: ConfigFile, name: string): ConfigEdit['path'] => (file.nested ? ['mcp', 'servers', name] : ['mcp', name]);

export class OpenCodeMcp implements McpManager {
  /** One change at a time: each reads the files, then edits them. */
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
          // The files are settled first: one that cannot be edited (it does
          // not parse) must stop the add before the running server has taken
          // it. A name a file already holds is replaced there, every copy of
          // it, so no older entry can show through.
          const holding = await this.holding(add.name);
          const target = holding.length > 0 ? holding : [await this.newEntry()];
          await this.call(`add ${add.name}`, () => client.mcp.add({ server: add.name, config: config as never }), secrets);
          for (const file of target) await editGlobalConfig(file.path, [{ path: entryPath(file, add.name), value: config }]);
        }
      } else {
        for (const name of names) {
          const holding = await this.holding(name);
          if (holding.length === 0) throw new Error(`OpenCode has no MCP server '${name}'.`);
          for (const file of holding) {
            const at = entryPath(file, name);
            const edit: ConfigEdit =
              action === 'remove' ? { path: at, value: undefined } : { path: [...at, 'enabled'], value: action === 'disable' ? false : undefined };
            await editGlobalConfig(file.path, [edit]);
          }
        }
      }
      return this.state(await this.readable());
    });
  }

  /** Every global config file that exists and parses, in OpenCode's order. */
  private async readable(): Promise<ConfigFile[]> {
    return (await readGlobalConfigs(this.configFiles())).map(configFile);
  }

  /** The files holding `name`. A file that does not parse stops the change:
   *  editing it would guess at what it means. */
  private async holding(name: string): Promise<ConfigFile[]> {
    const out: ConfigFile[] = [];
    for (const file of this.configFiles()) {
      const read = await readGlobalConfig(file);
      if (!read) continue;
      const parsed = configFile(read);
      if (name in parsed.servers) out.push(parsed);
    }
    return out;
  }

  /** The file a new server goes to, as OpenCode's own `mcp add --global`
   *  picks it. A new file is read at OpenCode's next start and watched from
   *  then on. */
  private async newEntry(): Promise<ConfigFile> {
    const file = newEntryFile(this.configFiles());
    const read = await readGlobalConfig(file);
    return read ? configFile(read) : { path: file, servers: {}, nested: false };
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

  /** What the files hold. A later file overrides an earlier one, as OpenCode
   *  reads them. */
  private state(files: ConfigFile[]): McpState {
    const merged: Record<string, unknown> = {};
    for (const file of files) Object.assign(merged, file.servers);
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
