/**
 * LSP diagnostics on Pi's file changes: after an `edit` or `write` succeeds,
 * the project's language server checks the file, and what it reports is
 * added to the tool's result — so the model sees a type error it just made
 * in the same turn, and the phone shows it under the call like any result.
 *
 * One server per project and language, started on the first change to one of
 * its files and kept for the session (a cold start costs a second for
 * TypeScript or Python, several for rust-analyzer; a warm check a fraction of
 * that), stopped after IDLE_MS unused and when Pi exits. A server that is
 * missing, fails to start or dies is not tried again for that project this
 * session. Only errors and warnings, of the changed file only, are reported:
 * hints and the rest of the project would cost the model's context on every
 * edit.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { PROVIDER_ENV, PROVIDER_TOKEN_ENV } from '../provider';
import { LspClient, spawnServer, type DiagnosticsResult, type SpawnServer } from './client';
import { machine, serverFor, type Machine, type ServerChoice } from './servers';

/** The longest an edit waits for its diagnostics from a running server. */
export const DIAGNOSTICS_TIMEOUT_MS = 10_000;
/** The same for the first change that starts a server: its project load
 *  comes first (rust-analyzer took ~10 s for a one-file crate). */
export const COLD_TIMEOUT_MS = 30_000;
/** A server unused this long is stopped; the next change starts it again. */
export const IDLE_MS = 10 * 60_000;
/** The most problems one result lists. */
export const MAX_REPORTED = 20;
/** A file larger than this is not sent to a server. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Set to `off` in the bridge's environment to turn the checks off. */
export const LSP_ENV = 'CODEDECK_PI_LSP';

export interface DiagnosticsDeps {
  machine?: Machine;
  spawn?: SpawnServer;
  env?: NodeJS.ProcessEnv;
  clock?: () => number;
  timeoutMs?: number;
  coldTimeoutMs?: number;
  /** Stops a server's process tree when Pi exits. */
  kill?: (pid: number) => void;
}

/** The file a Pi file tool changed, resolved the way Pi resolves it
 *  (`resolveToCwd`): a leading `@` dropped, `~` the home directory. */
export function changedFile(input: Record<string, unknown>, cwd: string): string | undefined {
  let file = typeof input.path === 'string' ? input.path.trim() : '';
  if (!file) return undefined;
  if (file.startsWith('@')) file = file.slice(1);
  if (file === '~' || file.startsWith('~/') || file.startsWith('~\\')) file = path.join(homedir(), file.slice(1));
  return path.resolve(cwd, file);
}

const SEVERITY: Record<number, string> = { 1: 'error', 2: 'warning' };

/** What the model reads after the tool's own result, or `undefined` when
 *  there is nothing to report. */
export function formatDiagnostics(display: string, server: string, result: DiagnosticsResult): string | undefined {
  // A diagnostic without a severity is the client's to judge (LSP); an
  // error is the safe reading.
  const problems = result.diagnostics.filter((d) => (d.severity ?? 1) <= 2);
  if (problems.length === 0) return undefined;
  const errors = problems.filter((d) => (d.severity ?? 1) === 1).length;
  const warnings = problems.length - errors;
  const counts = [errors ? `${errors} error${errors === 1 ? '' : 's'}` : '', warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : '']
    .filter(Boolean)
    .join(', ');
  const lines = problems.slice(0, MAX_REPORTED).map((d) => {
    const code = d.code ? ` ${d.code}` : '';
    const message = d.message.trim().replace(/\s*\n\s*/g, '; ');
    return `${display}:${d.line + 1}:${d.character + 1} ${SEVERITY[d.severity ?? 1]}${code}: ${message}`;
  });
  if (problems.length > MAX_REPORTED) lines.push(`… and ${problems.length - MAX_REPORTED} more`);
  const unfinished = result.settled ? '' : ` (it had not finished checking; there may be more)`;
  return `${server} reports ${counts} in ${display}${unfinished}:\n${lines.join('\n')}`;
}

/** `promise`, or `undefined` as soon as `signal` aborts: a stopped turn
 *  does not wait for a server (which goes on starting, for the next one). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const aborted = () => resolve(undefined);
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted);
        reject(error as Error);
      },
    );
  });
}

export class ProjectServers {
  private readonly clients = new Map<string, LspClient>();
  /** Servers still initializing: stopped with the rest when Pi exits. */
  private readonly launching = new Set<LspClient>();
  private readonly starting = new Map<string, Promise<LspClient | undefined>>();
  private readonly broken = new Set<string>();
  private readonly machine: Machine;
  private readonly spawn: SpawnServer;
  private readonly env: NodeJS.ProcessEnv;
  private readonly clock: () => number;
  private readonly timeoutMs: number;
  private readonly coldTimeoutMs: number;
  private readonly kill: ((pid: number) => void) | undefined;
  private sweeper: NodeJS.Timeout | undefined;

  constructor(deps: DiagnosticsDeps = {}) {
    // A server runs the project's build (`cargo check` runs build scripts):
    // it gets Pi's environment without the provider profile's token.
    const env = { ...(deps.env ?? process.env) };
    delete env[PROVIDER_ENV];
    delete env[PROVIDER_TOKEN_ENV];
    this.env = env;
    this.machine = deps.machine ?? machine(env);
    this.spawn = deps.spawn ?? spawnServer;
    this.clock = deps.clock ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? DIAGNOSTICS_TIMEOUT_MS;
    this.coldTimeoutMs = deps.coldTimeoutMs ?? COLD_TIMEOUT_MS;
    this.kill = deps.kill;
  }

  /** The diagnostics of a file just changed, as the model reads them, or
   *  `undefined` when there is no server for it or nothing to report. */
  async check(file: string, cwd: string, signal?: AbortSignal): Promise<string | undefined> {
    if (signal?.aborted) return undefined;
    const choice = serverFor(file, this.machine);
    if (!choice) return undefined;
    const running = this.clients.get(this.key(choice));
    const warm = running !== undefined && running.dead === undefined;
    const deadline = this.clock() + (warm ? this.timeoutMs : this.coldTimeoutMs);
    const client = await untilAborted(this.client(choice, deadline), signal);
    if (!client) return undefined;
    let text: string;
    try {
      const buffer = await readFile(file);
      if (buffer.length > MAX_FILE_BYTES) return undefined;
      text = buffer.toString('utf8');
    } catch {
      return undefined;
    }
    let result: DiagnosticsResult | undefined;
    try {
      result = await untilAborted(client.diagnose(file, choice.languageId, text, deadline, signal), signal);
      if (!result) return undefined;
    } catch {
      this.drop(choice, client);
      return undefined;
    }
    if (client.dead) this.drop(choice, client);
    const relative = path.relative(cwd, file);
    const parts = relative.split(path.sep);
    const display = relative && parts[0] !== '..' && !path.isAbsolute(relative) ? parts.join('/') : file;
    return formatDiagnostics(display, client.server.name, result);
  }

  /** Every server stopped (Pi is exiting, or the session ended). */
  stopAll(kill: ((pid: number) => void) | undefined = this.kill): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    for (const client of [...this.clients.values(), ...this.launching]) {
      const pid = client.pid;
      if (kill && pid !== undefined) kill(pid);
      else client.close();
    }
    this.clients.clear();
    this.launching.clear();
  }

  /** One server per server and project; on Windows `C:\repo` and `c:\repo` are
   *  one project. */
  private key(choice: ServerChoice): string {
    const root = this.machine.platform === 'win32' ? choice.root.toLowerCase() : choice.root;
    return `${choice.server.name}\0${root}`;
  }

  private drop(choice: ServerChoice, client: LspClient): void {
    const key = this.key(choice);
    if (this.clients.get(key) === client) this.clients.delete(key);
    this.broken.add(key);
    client.close();
  }

  private async client(choice: ServerChoice, deadline: number): Promise<LspClient | undefined> {
    const key = this.key(choice);
    if (this.broken.has(key)) return undefined;
    const running = this.clients.get(key);
    if (running && !running.dead) return running;
    // Two parallel edits in one project share one start.
    let starting = this.starting.get(key);
    if (!starting) {
      starting = this.start(choice, key, deadline);
      this.starting.set(key, starting);
      void starting.finally(() => this.starting.delete(key));
    }
    return starting;
  }

  private async start(choice: ServerChoice, key: string, deadline: number): Promise<LspClient | undefined> {
    const client = new LspClient(choice.server, choice.root, this.env, this.spawn, this.clock, this.kill);
    this.launching.add(client);
    try {
      await client.start(Math.max(1, deadline - this.clock()));
    } catch {
      this.broken.add(key);
      client.close();
      return undefined;
    } finally {
      this.launching.delete(client);
    }
    this.clients.set(key, client);
    this.sweep();
    return client;
  }

  /** Stop the servers nobody used for IDLE_MS; runs while any is up. */
  private sweep(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const now = this.clock();
      for (const [key, client] of this.clients) {
        if (now - client.lastUsed >= IDLE_MS) {
          this.clients.delete(key);
          client.close();
        }
      }
      if (this.clients.size === 0 && this.sweeper) {
        clearInterval(this.sweeper);
        this.sweeper = undefined;
      }
    }, 60_000);
    this.sweeper.unref();
  }
}

/** The file tools whose results carry diagnostics: Pi's own. */
const FILE_TOOLS = new Set(['edit', 'write']);

export function registerDiagnostics(pi: Pick<ExtensionAPI, 'on'>, deps: DiagnosticsDeps = {}): ProjectServers | undefined {
  const env = deps.env ?? process.env;
  if (env[LSP_ENV] === 'off') return undefined;
  const servers = new ProjectServers(deps);
  // A server must not outlive the Pi that started it.
  process.once('exit', () => servers.stopAll());
  pi.on('tool_result', async (event, ctx) => {
    if (event.isError || !FILE_TOOLS.has(event.toolName)) return undefined;
    const file = changedFile(event.input, ctx.cwd);
    if (!file) return undefined;
    const report = await servers.check(file, ctx.cwd, ctx.signal);
    if (!report) return undefined;
    return { content: [...event.content, { type: 'text' as const, text: report }] };
  });
  return servers;
}
