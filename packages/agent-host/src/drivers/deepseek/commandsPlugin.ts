/**
 * The plugin that gives CodeDeck the harness's slash commands.
 *
 * The harness has commands (`/compact`, `/goal`, and whatever its plugins
 * add) in this profile: the registry is mounted. What it has no way to hand
 * them to is an ACP client — ACP carries no command list and no way to invoke
 * one, and a typed `/name` is prompt text that reaches the model. The
 * registry is reachable only from inside the process, through the harness's
 * client API, which the automation profile mounts no transport for.
 *
 * So CodeDeck brings its own transport: this plugin, installed into the
 * profile, holds the command service and answers two questions over a local
 * socket — what commands this session has, and "run this line". It is ours,
 * which is the point: no harness API is patched, and a harness that changes
 * under it leaves commands unreported (the driver treats every failure that
 * way) rather than breaking a session.
 *
 * The plugin is a package in the profile's own `node_modules`, written from
 * the source below — dsh resolves a row's plugin by name from there, so no
 * package manager is involved (and installing one later can prune the
 * directory, which is why it is rewritten when the host starts).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { ProfileLayer, type LayerBlock } from './profileLayer';

/** The package name the profile's row refers to. */
export const COMMANDS_PLUGIN = 'codedeck-dsh-commands';

/** This plugin's block in the profile's patch layer. */
const BLOCK: LayerBlock = {
  begin: '# --- CodeDeck+ commands: the local socket CodeDeck asks this profile for its slash commands over; everything outside this block is yours ---',
  end: '# --- end CodeDeck+ commands ---',
};

/**
 * The plugin, as it is written to disk. Plain JavaScript: the harness imports
 * it as it is, so nothing here may need a build step, and it must not import
 * anything of CodeDeck's — the profile has no idea this host exists.
 */
const SOURCE = `import { mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const name = 'codedeck-commands';
export const inject = ['agents', 'commands'];

/** Answer one connection's line-delimited JSON requests until it closes. */
export function apply(ctx, config) {
  const socket = config?.socket;
  if (typeof socket !== 'string' || socket === '') throw new Error('codedeck-commands: config.socket is required');
  const server = net.createServer((connection) => {
    connection.setEncoding('utf8');
    let buffered = '';
    connection.on('data', (chunk) => {
      buffered += chunk;
      for (;;) {
        const end = buffered.indexOf('\\n');
        if (end < 0) break;
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        if (line.trim() !== '') void respond(ctx, connection, line);
      }
    });
    connection.on('error', () => {});
  });
  mkdirSync(path.dirname(socket), { recursive: true });
  rmSync(socket, { force: true });
  server.on('error', (error) => ctx.logger?.warn?.(\`codedeck-commands: \${error.message}\`));
  server.listen(socket);
  ctx.effect(() => () => {
    server.close();
    rmSync(socket, { force: true });
  }, 'codedeck.commands');
}

async function respond(ctx, connection, line) {
  const reply = (body) => connection.write(JSON.stringify(body) + '\\n');
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    reply({ ok: false, error: 'malformed request' });
    return;
  }
  const id = request?.id;
  try {
    const agent = ctx.get('agents')?.get(request?.sessionId);
    if (agent === undefined) {
      reply({ id, ok: false, error: 'no live session with that id' });
      return;
    }
    const commands = ctx.get('commands');
    if (request.method === 'list') {
      reply({
        id,
        ok: true,
        commands: commands.list(agent).map((command) => ({
          name: command.name,
          description: command.description,
          ...(command.input?.hint === undefined ? {} : { hint: command.input.hint }),
        })),
      });
      return;
    }
    if (request.method === 'run') {
      // An empty attachment list: the phone sends the line, and a command
      // that wants files is out of scope for this bridge.
      const execution = await commands.execute(agent, String(request.line ?? ''), [], new AbortController().signal);
      if (execution === undefined) {
        reply({ id, ok: false, error: 'not a command this session has' });
        return;
      }
      reply({ id, ok: true, result: { kind: execution.result.kind, text: execution.result.text ?? '' } });
      return;
    }
    reply({ id, ok: false, error: \`unknown method \${String(request.method)}\` });
  } catch (error) {
    reply({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
`;

/** The package manifest the loader reads beside the source. */
function manifest(): string {
  return `${JSON.stringify(
    {
      name: COMMANDS_PLUGIN,
      version: '1.0.0',
      private: true,
      type: 'module',
      main: 'index.js',
      description: "CodeDeck+'s local command bridge for the harness's automation profile",
    },
    null,
    2,
  )}\n`;
}

/**
 * Put the plugin where the harness loads it from — its package in the
 * profile's `node_modules`, and a row naming it in the profile's patch layer
 * — and answer the directory it lives in.
 */
export async function installCommandsPlugin(profileDir: string, socket: string, log: (message: string) => void): Promise<void> {
  const dir = path.join(profileDir, 'node_modules', COMMANDS_PLUGIN);
  await mkdir(dir, { recursive: true });
  await writeIfChanged(path.join(dir, 'package.json'), manifest());
  await writeIfChanged(path.join(dir, 'index.js'), SOURCE);
  await new ProfileLayer(path.join(profileDir, 'cordis.patch.yml'), log).set(BLOCK, rows(socket));
}

/** The row that mounts it, with the socket it answers on. */
function rows(socket: string): string {
  return [
    '- insert:',
    '    - id: codedeck-commands',
    `      name: '${COMMANDS_PLUGIN}'`,
    '      config:',
    `        socket: ${JSON.stringify(socket)}`,
  ].join('\n');
}

/** A file the harness may be running: rewritten only when its content is. */
async function writeIfChanged(file: string, content: string): Promise<void> {
  try {
    if ((await readFile(file, 'utf8')) === content) return;
  } catch {
    // Not written yet.
  }
  await writeFile(file, content);
}
