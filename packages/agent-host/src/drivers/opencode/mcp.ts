/**
 * OpenCode's MCP servers for the whole machine: the `mcp` section of its
 * config, which every project loads and the `opencode` terminal uses too.
 *
 * V2 serves the whole lifecycle over its API — list, add, remove, connect,
 * disconnect — so nothing here edits a config file by hand any more (v1 had
 * no way to delete a server, and rewrote the global config itself). Its
 * running inventory and its config file are not the same thing (verified
 * against 2.1.4): `add` and `remove` change the inventory only, so a removed
 * config server comes back on the next start and an added one is gone; a
 * `disconnect` is the inventory's `disabled` status, not a config flag. This
 * manager therefore holds the adds and removes of the current server, and
 * reads the switch from `mcp.list`.
 *
 * In a session, a server is connected or disconnected for the session's
 * project — OpenCode has no narrower scope — so the switch is project-wide.
 */
import type { OpenCodeClient } from '@opencode/client';
import type { McpManager, McpState, SessionMcpState } from '../../sdk/driver';
import { mcpStatus, serverInfo, setupSecrets } from '../../sdk/mcp';
import { redactSecrets } from '../../sdk/redact';
import type { McpAction, McpServerAdd, McpServerInfo } from '../../sdk/types';

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

/** The servers OpenCode's config holds, secret-free: v2 lists the servers it
 *  knows with their connection state, and nothing else about them, so the
 *  command, URL and key names come from the config itself. */
export function openCodeServers(mcp: unknown): McpServerInfo[] {
  if (!mcp || typeof mcp !== 'object') return [];
  const out: McpServerInfo[] = [];
  for (const [name, raw] of Object.entries(mcp as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as { type?: unknown; command?: unknown; url?: unknown; environment?: unknown; headers?: unknown; disabled?: unknown };
    const keys = (v: unknown) => (v && typeof v === 'object' ? Object.keys(v) : []);
    const enabled = r.disabled !== true;
    if (r.type === 'local' && Array.isArray(r.command) && typeof r.command[0] === 'string') {
      out.push(serverInfo({ name, transport: 'stdio', command: r.command[0], envKeys: keys(r.environment), enabled }));
    } else if (r.type === 'remote' && typeof r.url === 'string') {
      out.push(serverInfo({ name, transport: 'http', url: r.url, headerKeys: keys(r.headers), enabled }));
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export class OpenCodeMcp implements McpManager {
  /** One MCP change at a time: each reads the list, then writes it. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Servers added through the API in this server's lifetime. V2 keeps an
   *  added server in its running inventory and not in the config document
   *  (verified against 2.1.4), so the manager is the only other place that
   *  knows what they are. */
  private readonly added = new Map<string, Record<string, unknown>>();
  /** Servers removed through the API: a config-file server leaves the
   *  running inventory but not the file, so it would otherwise be listed
   *  again at once. A new server (and so a restart) clears both. */
  private readonly removed = new Set<string>();
  /** The client these two sets belong to. */
  private lastClient: OpenCodeClient | undefined;

  constructor(private readonly client: () => Promise<OpenCodeClient>) {}

  list(): Promise<McpState> {
    return this.serial(async () => {
      const client = await this.client();
      this.forClient(client);
      return this.state(client);
    });
  }

  act(action: McpAction, servers: McpServerAdd[], names: string[]): Promise<McpState> {
    return this.serial(async () => {
      const client = await this.client();
      this.forClient(client);
      const current = await this.known(client);
      if (action === 'remove') {
        const missing = names.find((n) => !current.has(n));
        if (missing) throw new Error(`OpenCode has no MCP server '${missing}'.`);
        for (const name of names) await this.call(`remove ${name}`, () => client.mcp.remove({ server: name }));
        for (const name of names) {
          this.added.delete(name);
          this.removed.add(name);
        }
      } else if (action === 'add') {
        // A refusal can quote the config it was handed — env, headers and
        // all. The setup's credential values are removed before it travels.
        const secrets = servers.flatMap((add) => setupSecrets(add.setup));
        for (const add of servers) {
          const config = openCodeServerConfig(add);
          await this.call(`add ${add.name}`, () => client.mcp.add({ server: add.name, config: config as never }), secrets);
          this.added.set(add.name, config);
          this.removed.delete(add.name);
        }
      } else {
        const missing = names.find((n) => !current.has(n));
        if (missing) throw new Error(`OpenCode has no MCP server '${missing}'.`);
        for (const name of names) {
          await this.call(
            `${action === 'enable' ? 'connect' : 'disconnect'} ${name}`,
            () => (action === 'enable' ? client.mcp.connect({ server: name }) : client.mcp.disconnect({ server: name })),
          );
        }
      }
      return this.state(client);
    });
  }

  /** The servers the server knows, by name. */
  private async known(client: OpenCodeClient): Promise<Set<string>> {
    const listed = await client.mcp.list().catch((err: unknown) => {
      throw new Error(`OpenCode could not report its MCP servers: ${reason(err)}`);
    });
    return new Set(listed.data.map((s) => s.name));
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

  /** Forget what belongs to a server process that has been replaced. */
  private forClient(client: OpenCodeClient): void {
    if (this.lastClient === client) return;
    this.added.clear();
    this.removed.clear();
    this.lastClient = client;
  }

  private async state(client: OpenCodeClient): Promise<McpState> {
    // What was added or removed belongs to one server process: a replaced
    // server has started from its config again.
    this.forClient(client);
    // The server lists which servers exist; only the config says what each
    // one is (its command, its URL), so both are read. V2's config answer is
    // a list of documents, and its `mcp` section holds the servers under
    // `servers` — the file's bare `mcp` map is not the shape of the answer.
    const [config, listed] = await Promise.all([
      client.config.get().catch(() => []),
      client.mcp.list().catch((err: unknown) => {
        throw new Error(`OpenCode could not report its MCP servers: ${reason(err)}`);
      }),
    ]);
    const documents = config as unknown as Array<{ type?: string; info?: { mcp?: { servers?: Record<string, unknown> } } }>;
    const configured = documents.find((entry) => entry.info?.mcp?.servers !== undefined)?.info?.mcp?.servers ?? {};
    // A server added through the API is not in the config document; the
    // manager's record stands in for it, and a removed one is kept out until
    // this server process starts again.
    const known = new Map<string, unknown>();
    for (const [name, entry] of Object.entries(configured)) if (!this.removed.has(name)) known.set(name, entry);
    for (const [name, entry] of this.added) known.set(name, entry);
    // The switch is the inventory's status, not a flag in the config: a
    // `disconnect` leaves the config entry as it was (verified against 2.1.4).
    const off = new Set(listed.data.filter((server) => server.status.status === 'disabled').map((server) => server.name));
    return {
      servers: openCodeServers(Object.fromEntries(known)).map((server) => (off.has(server.name) ? { ...server, enabled: false } : server)),
      toggles: true,
    };
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
