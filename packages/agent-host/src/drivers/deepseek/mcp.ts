/**
 * The DeepSeek Harness's MCP servers: the `dsh-mcp-client` rows a profile's
 * own patch layer holds.
 *
 * The harness reads a profile as an ordered stack of patch layers, and
 * `$DSH_HOME/profiles/<name>/cordis.patch.yml` is the last of them — the
 * user's own layer, the file the harness's own documentation says to edit.
 * Rows added there start with the harness, so they are part of the harness's
 * configuration rather than of this bridge: any `dsh --profile acp` run gets
 * them, and so does the next bridge that runs the same home.
 *
 * Only a delimited block of that file is this bridge's — everything around
 * it, comments included, is read, kept and written back untouched. The block
 * is a patch list: one `insert` row per server, and a `disabled` row after
 * the ones switched off (a row addressed by id later in the same layer wins).
 *
 * The servers are attached when the harness starts, in the harness's own
 * working directory, and a server that fails to start is logged rather than
 * fatal (the harness's log is where the status screen reads it from). A
 * session therefore shows them but cannot switch one: switching means
 * restarting the harness, which is what happens to the whole home's sessions
 * when this file changes and none is running.
 *
 * ACP could carry the same servers per session instead. That path was not
 * taken: the harness fails `session/new` outright when one of them cannot
 * start, so a single mistyped server would lock the user out of every
 * session, and each session would pay its own connections.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { load, dump } from 'js-yaml';
import type { McpManager, McpState } from '../../driver';
import { serverInfo } from '../../mcp';
import type { McpAction, McpServerAdd, McpServerInfo } from '../../types';

/** The plugin every managed row mounts. */
const MCP_CLIENT_PLUGIN = '@deepseek-ai/dsh-mcp-client';
/** Which servers are this bridge's, among the profile's other rows. */
const ROW_PREFIX = 'codedeck-mcp-';
const MARKER_BEGIN = '# --- CodeDeck+ MCP servers: managed from the MCP screen; everything outside this block is yours ---';
const MARKER_END = '# --- end CodeDeck+ MCP servers ---';

/** The harness's own rule for a server namespace, so a name this bridge
 *  writes is one the harness accepts (`mcp__<name>__<tool>` names follow). */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;

/** A server as this manager knows it: what the phone shows, and what to write
 *  back. */
interface ManagedServer extends McpServerInfo {
  /** The row's own configuration, as the harness's plugin takes it. */
  config: Record<string, unknown>;
}

export interface DeepSeekMcpOptions {
  /** The profile directory (`$DSH_HOME/profiles/acp`). */
  profileDir: string;
  log: (message: string) => void;
}

/** One patch document of the managed block. */
type PatchDoc = Record<string, unknown>;

export class DeepSeekMcp implements McpManager {
  /** One write at a time: each reads the file, edits, writes it back. */
  private queue: Promise<unknown> = Promise.resolve();
  /** How many times this manager changed the layer. A harness process records
   *  it as it starts, so a change made afterwards is configuration that
   *  process has not loaded — no file timestamp, and no clock, involved. */
  private versions = 0;

  constructor(private readonly options: DeepSeekMcpOptions) {}

  /** How many times the layer has changed since this bridge started. */
  get version(): number {
    return this.versions;
  }

  list(): Promise<McpState> {
    return this.serial(async () => this.state(await this.servers()));
  }

  act(action: McpAction, servers: McpServerAdd[], names: string[]): Promise<McpState> {
    return this.serial(async () => {
      const current = await this.servers();
      const next = applyAction(current, action, servers, names);
      await this.write(next);
      return this.state(next);
    });
  }

  private file(): string {
    return path.join(this.options.profileDir, 'cordis.patch.yml');
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private state(servers: ManagedServer[]): McpState {
    return {
      servers: servers.map(({ config: _config, ...info }) => info).sort((a, b) => a.name.localeCompare(b.name)),
      // A server can be switched off without being removed: its row stays,
      // with a `disabled` row after it.
      toggles: true,
    };
  }

  /** The servers in the managed block, in the order they are written. */
  private async servers(): Promise<ManagedServer[]> {
    const text = await this.read();
    const block = extractBlock(text);
    if (block === undefined) return [];
    let docs: unknown;
    try {
      docs = load(block);
    } catch (error) {
      throw new Error(`${this.file()} has a CodeDeck MCP block that is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
    }
    return serversOf(Array.isArray(docs) ? (docs as PatchDoc[]) : []);
  }

  private async read(): Promise<string> {
    try {
      return await readFile(this.file(), 'utf8');
    } catch {
      return '';
    }
  }

  private async write(servers: ManagedServer[]): Promise<void> {
    const text = await this.read();
    const rest = removeBlock(text);
    const joined = servers.length === 0 ? restoreEmptyList(rest) : withBlock(rest, renderBlock(servers));
    const content = joined.endsWith('\n') ? joined : `${joined}\n`;
    // A change that leaves the layer as it was is not a change: a session
    // reads this version to tell a server its harness has from one it has
    // not loaded yet.
    if (content === text) return;
    this.versions++;
    const file = this.file();
    await mkdir(path.dirname(file), { recursive: true });
    // Written beside and renamed: a torn write would leave a profile the
    // harness cannot read at all.
    const temporary = `${file}.codedeck-${process.pid}`;
    await writeFile(temporary, content);
    await rename(temporary, file);
    this.options.log(`[deepseek] MCP servers updated in ${file}`);
  }
}

/** The block's own text, without its markers; `undefined` when there is none. */
function extractBlock(text: string): string | undefined {
  const start = text.indexOf(MARKER_BEGIN);
  if (start < 0) return undefined;
  const end = text.indexOf(MARKER_END, start);
  if (end < 0) return undefined;
  return text.slice(start + MARKER_BEGIN.length, end).trim();
}

/** `text` with the managed block taken out (markers included). */
function removeBlock(text: string): string {
  const start = text.indexOf(MARKER_BEGIN);
  if (start < 0) return text;
  const end = text.indexOf(MARKER_END, start);
  if (end < 0) return text;
  return `${text.slice(0, start)}${text.slice(end + MARKER_END.length)}`.trimEnd() + '\n';
}

/** Whether a profile patch layer holds anything but comments and blanks. */
function isEmptyLayer(text: string): boolean {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    // The profile's initial layer: an empty list, and nothing else.
    if (trimmed === '[]' || trimmed === '---') continue;
    return false;
  }
  return true;
}

/**
 * The layer's own rows, then the managed block, as one document. The
 * harness's initial layer is an empty list (`[]`) on its own, and an empty
 * sequence cannot share a document with a block sequence — nor can a `[]` a
 * user left after their own rows — so those lines go.
 */
function withBlock(rest: string, block: string): string {
  const head = withoutEmptyList(rest).trimEnd();
  return head === '' ? block : `${head}\n\n${block}`;
}

/** The layer with no managed block and no rows of ours: the profile's own
 *  comments and its empty list, which is the shape the harness starts from. */
function restoreEmptyList(rest: string): string {
  if (!isEmptyLayer(rest)) return rest.trimEnd();
  const head = rest
    .split('\n')
    .filter((line) => line.trim().startsWith('#'))
    .join('\n')
    .trimEnd();
  return head === '' ? '[]' : `${head}\n[]`;
}

/** `text` without a line that is an empty-list document (`[]` at the left
 *  margin; an argument's own `[]` is indented and kept). */
function withoutEmptyList(text: string): string {
  return text
    .split('\n')
    .filter((line) => line.replace(/\r$/, '') !== '[]')
    .join('\n');
}

/** The managed block for `servers`, as the patch list the harness loads. */
function renderBlock(servers: ManagedServer[]): string {
  const docs: PatchDoc[] = [];
  for (const server of servers) {
    docs.push({ insert: [{ id: `${ROW_PREFIX}${server.name}`, name: MCP_CLIENT_PLUGIN, config: server.config }] });
    if (!server.enabled) docs.push({ id: `${ROW_PREFIX}${server.name}`, disabled: true });
  }
  const body = dump(docs, { lineWidth: -1, noRefs: true, quotingType: "'" }).trimEnd();
  return `${MARKER_BEGIN}\n${body}\n${MARKER_END}`;
}

/** The servers a managed block describes, the last row per id winning. */
function serversOf(docs: PatchDoc[]): ManagedServer[] {
  const byName = new Map<string, ManagedServer>();
  for (const doc of docs) {
    const insert = doc.insert;
    if (Array.isArray(insert)) {
      for (const row of insert as PatchDoc[]) {
        if (row.name !== MCP_CLIENT_PLUGIN) continue;
        const config = record(row.config);
        const name = typeof config.serverName === 'string' ? config.serverName : undefined;
        if (!name) continue;
        byName.set(name, { ...infoOf(name, config), config, enabled: true });
      }
      continue;
    }
    const id = typeof doc.id === 'string' ? doc.id : '';
    if (doc.disabled === true && id.startsWith(ROW_PREFIX)) {
      const server = byName.get(id.slice(ROW_PREFIX.length));
      if (server) server.enabled = false;
    }
  }
  return [...byName.values()];
}

/** A server's row, as the phone shows it — never a secret value. */
function infoOf(name: string, config: Record<string, unknown>): McpServerInfo {
  const keys = (value: unknown) => (Object.keys(record(value)).length > 0 ? Object.keys(record(value)) : []);
  if (config.transport === 'stdio') {
    return serverInfo({
      name,
      transport: 'stdio',
      command: typeof config.command === 'string' ? config.command : '',
      envKeys: keys(config.env),
      enabled: true,
    });
  }
  return serverInfo({
    name,
    transport: 'http',
    url: typeof config.url === 'string' ? config.url : '',
    headerKeys: keys(config.headers),
    enabled: true,
  });
}

/** The managed rows for one added server, as the harness's plugin takes it. */
function serverConfig(add: McpServerAdd): Record<string, unknown> {
  const setup = add.setup;
  const name = add.name.trim();
  if (!SERVER_NAME.test(name)) {
    throw new Error(
      `'${add.name}' is not a usable MCP server name for the DeepSeek Harness: it takes 1–32 letters, digits, ` +
        'underscores or hyphens (the name becomes part of every tool the server contributes).',
    );
  }
  const common = { serverName: name, failOnStartupError: true };
  if (setup.type === 'stdio') {
    return {
      ...common,
      transport: 'stdio',
      command: setup.command,
      ...(setup.args?.length ? { args: [...setup.args] } : {}),
      ...(setup.env && Object.keys(setup.env).length > 0 ? { env: { ...setup.env } } : {}),
    };
  }
  if (setup.type === 'sse') {
    throw new Error('The DeepSeek Harness reaches MCP servers over stdio or streamable HTTP, not SSE.');
  }
  return {
    ...common,
    transport: 'streamable-http',
    url: setup.url,
    ...(setup.headers && Object.keys(setup.headers).length > 0 ? { headers: { ...setup.headers } } : {}),
  };
}

/** The list after one change. Unknown names are refused with the reason. */
function applyAction(
  current: ManagedServer[],
  action: McpAction,
  servers: McpServerAdd[],
  names: string[],
): ManagedServer[] {
  if (action === 'add') {
    const next = [...current];
    for (const add of servers) {
      const config = serverConfig(add);
      const name = add.name.trim();
      const at = next.findIndex((server) => server.name === name);
      const entry: ManagedServer = { ...infoOf(name, config), config, enabled: true };
      // Adding a server that is already there replaces it, keeping whatever
      // the user had switched it to.
      if (at >= 0) entry.enabled = next[at]!.enabled;
      if (at >= 0) next[at] = entry;
      else next.push(entry);
    }
    return next;
  }
  const wanted = new Set(names);
  const missing = names.find((name) => !current.some((server) => server.name === name));
  if (missing) throw new Error(`The DeepSeek Harness has no MCP server named '${missing}'.`);
  if (action === 'remove') return current.filter((server) => !wanted.has(server.name));
  return current.map((server) => (wanted.has(server.name) ? { ...server, enabled: action === 'enable' } : server));
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
