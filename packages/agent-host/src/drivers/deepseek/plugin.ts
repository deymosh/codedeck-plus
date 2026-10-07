/**
 * The plugin that carries what the harness's ACP surface does not: its slash
 * commands, and the questions its model asks the user.
 *
 * Both exist in this profile and neither is reachable from outside it. ACP has
 * no command list and no way to invoke one, and the harness keeps commands and
 * human-interaction for its own UI modules; the same is true of the
 * `user-questions` service, whose answerer is a browser panel and which every
 * ask goes through — the question tool, the timed one, and the plan review
 * `exit_plan_mode` presents. Inside the process both are ordinary services.
 *
 * So CodeDeck brings its own transport: this plugin, installed into the
 * profile, holds the command registry and composes the questions answerer, and
 * talks to the agent host over a local socket. It is ours, which is the point:
 * no harness API is patched, and a harness that changes under it leaves
 * commands or questions unanswered (the driver treats every failure that way)
 * rather than breaking a session.
 *
 * The plugin is a package in the profile's own `node_modules`, written from
 * the source below — dsh resolves a row's plugin by name from there, so no
 * package manager is involved (and installing one later can prune the
 * directory, which is why it is rewritten when the host starts).
 *
 * Two channels, deliberately: questions are *pushed* to the host as
 * marker-prefixed lines on stderr (the one stream the harness leaves free —
 * stdout is ACP), and every answer, like every command asked for, is a request
 * on the socket.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { ProfileLayer, type LayerBlock } from './profileLayer';

/** The package name the profile's row refers to. */
export const HARNESS_PLUGIN = 'codedeck-dsh-bridge';

/** This plugin's block in the profile's patch layer. */
const BLOCK: LayerBlock = {
  begin: '# --- CodeDeck+ bridge: brings this profile its slash commands and its questions, over a local socket; everything outside this block is yours ---',
  end: '# --- end CodeDeck+ bridge ---',
};

/** Where a pushed question starts on the harness's stderr (the host reads
 *  these lines and never logs them as harness output). */
export const QUESTION_MARKER = 'codedeck-question:';

/** The variable that names a harness process's own socket. The profile is
 *  shared by every process the runtime starts, so the path cannot live in
 *  the plugin's row; the runtime sets it per spawn. */
export const BRIDGE_SOCKET_ENV = 'CODEDECK_DSH_BRIDGE_SOCKET';

/**
 * The plugin, as it is written to disk. Plain JavaScript: the harness imports
 * it as it is, so nothing here may need a build step, and it must not import
 * anything of CodeDeck's — the profile has no idea this host exists.
 */
const SOURCE = `import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const name = 'codedeck-bridge';
export const inject = ['agents', 'commands', 'userQuestions'];

const QUESTION_MARKER = 'codedeck-question:';
const SOCKET_ENV = '${BRIDGE_SOCKET_ENV}';

/**
 * Serve the host's socket, and answer the harness's questions over it.
 * @param ctx - the profile's plugin context.
 */
export function apply(ctx) {
  // The socket is this process's own, named by the host that spawned it. A
  // harness started any other way — the plugin CLI, a person running the
  // profile by hand — has no host to answer, and putting its questions on
  // stderr would leave them waiting forever: the harness's own "no answerer"
  // is the honest outcome there.
  const socket = process.env[SOCKET_ENV];
  if (typeof socket !== 'string' || socket === '') return;

  /** Questions waiting for the host's answer, by call id. */
  const pending = new Map();
  /** Whether the host can reach this process. Until it can — and if it never
   *  can — a question is not ours to take. */
  let listening = false;

  ctx.on('user-questions/request', async (request, next) => {
    const questions = Array.isArray(request?.questions) ? request.questions : [];
    const sessionId = request?.agent?.session?.id;
    // A request this bridge cannot show — nothing asked, no live session to
    // put it to, no socket the answer could come back on — goes on down the
    // chain, where the harness's own answerer or its "no answerer" error has
    // it. That hand-off is next(): a listener that simply returns has *vetoed*
    // the chain, which leaves the caller with undefined where an answer batch
    // belongs.
    if (!listening || questions.length === 0 || typeof sessionId !== 'string') return next();
    // The card is keyed by the tool call. An ask usually names it (in wait;
    // the timed one adds the deadline), a plan review names it on the
    // question's intent instead, and anything else gets a key of ours — it
    // only has to come back with the answer.
    const callId =
      [request?.wait?.callId, ...questions.map((question) => question?.intent?.callId)].find(
        (id) => typeof id === 'string' && id !== '',
      ) ?? randomUUID();
    const job = {};
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    pending.set(callId, job);
    // The host learns about the question on stderr — the one stream that is
    // not ACP's — and answers on the socket.
    process.stderr.write(QUESTION_MARKER + JSON.stringify({
      sessionId,
      callId,
      questions: request.questions,
    }) + '\\n');
    const onAbort = () => {
      pending.delete(callId);
      job.reject(new Error('the question was cancelled'));
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await job.promise;
    } finally {
      pending.delete(callId);
      request.signal?.removeEventListener('abort', onAbort);
    }
  });

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
        if (line.trim() !== '') void respond(ctx, connection, line, pending);
      }
    });
    connection.on('error', () => {});
  });
  // A named pipe is not a file; only a socket path has a directory to make
  // and a stale file (a process that was killed) to clear.
  const isPipe = socket.startsWith('\\\\\\\\.\\\\pipe\\\\');
  if (!isPipe) {
    mkdirSync(path.dirname(socket), { recursive: true });
    rmSync(socket, { force: true });
  }
  server.on('listening', () => {
    listening = true;
  });
  server.on('error', (error) => {
    listening = false;
    process.stderr.write('codedeck-bridge: cannot listen on ' + socket + ': ' + error.message + '\\n');
  });
  server.listen(socket);
  ctx.effect(() => () => {
    listening = false;
    server.close();
    if (!isPipe) rmSync(socket, { force: true });
  }, 'codedeck.bridge');
}

/** One socket request: what a session can run, or the answer to a question. */
async function respond(ctx, connection, line, pending) {
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
    if (request.method === 'answer') {
      const job = pending.get(request.callId);
      if (job === undefined) {
        reply({ id, ok: false, error: 'that question is no longer waiting' });
        return;
      }
      pending.delete(request.callId);
      if (request.answer === undefined) job.reject(new Error('the user did not answer'));
      else job.resolve({ answers: request.answer });
      reply({ id, ok: true });
      return;
    }
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
    reply({ id, ok: false, error: 'unknown method ' + String(request.method) });
  } catch (error) {
    reply({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
`;

/** The package manifest the loader reads beside the source. */
function manifest(): string {
  return `${JSON.stringify(
    {
      name: HARNESS_PLUGIN,
      version: '1.0.0',
      private: true,
      type: 'module',
      main: 'index.js',
      description: "CodeDeck+'s side channel into the harness's automation profile",
    },
    null,
    2,
  )}\n`;
}

/**
 * Put the plugin where the harness loads it from — its package in the
 * profile's `node_modules`, and a row naming it in the profile's patch layer.
 */
export async function installHarnessPlugin(profileDir: string, log: (message: string) => void): Promise<void> {
  const dir = path.join(profileDir, 'node_modules', HARNESS_PLUGIN);
  await mkdir(dir, { recursive: true });
  await writeIfChanged(path.join(dir, 'package.json'), manifest());
  await writeIfChanged(path.join(dir, 'index.js'), SOURCE);
  await new ProfileLayer(path.join(profileDir, 'cordis.patch.yml'), log).set(BLOCK, ROWS);
}

/** The row that mounts it. It carries no socket: that is each process's own
 *  (BRIDGE_SOCKET_ENV). */
const ROWS = ['- insert:', '    - id: codedeck-bridge', `      name: '${HARNESS_PLUGIN}'`].join('\n');

/** A file the harness may be running: rewritten only when its content is. */
async function writeIfChanged(file: string, content: string): Promise<void> {
  try {
    if ((await readFile(file, 'utf8')) === content) return;
  } catch {
    // Not written yet.
  }
  await writeFile(file, content);
}
