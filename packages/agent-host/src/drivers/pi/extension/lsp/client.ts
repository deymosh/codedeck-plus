/**
 * One language server process and the diagnostics it gives for a file just
 * changed.
 *
 * Servers do not agree on how they deliver diagnostics, nor on when they are
 * done, so the rule below is the one that held for each of them when run
 * against the real binary:
 *
 * - typescript-language-server pushes (`publishDiagnostics`), with no
 *   version, about 0.4 s after a change (1.1 s cold), and reports its
 *   project load as `$/progress`.
 * - TypeScript 7's `tsc --lsp` only answers a pull (`textDocument/diagnostic`),
 *   at once.
 * - Pyright and basedpyright advertise no pull to this client and push, with
 *   the version, about 0.25 s after a change (1.3–1.9 s cold), between a
 *   `$/progress`; their messages follow `initialize`'s `locale`.
 * - rust-analyzer answers a pull with its own diagnostics, but with an empty
 *   list while it still loads the workspace (≈4–10 s cold, under
 *   `$/progress`); `cargo check`'s come only as a push after its
 *   `rust-analyzer/flycheck/0` progress ends, and it then asks for a re-pull
 *   (`workspace/diagnostic/refresh`, a request with no params).
 *
 * So, after sending the change: pull when the server can; then wait until no
 * progress is open and nothing has arrived for QUIET_MS — and, for a server
 * that only pushes, until its push for this change came; pull again when
 * the server did work meanwhile; the answer is the pulled list together with
 * the push, each problem once. A deadline bounds all of it: whatever has
 * arrived by then is the answer, marked unsettled.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ServerCommand } from './servers';

/** How long nothing may arrive, with no progress open, before the server
 *  counts as done. Longer than the gaps between rust-analyzer's load phases
 *  (up to ~0.2 s seen), short enough to cost little on every edit. */
export const QUIET_MS = 300;

/** One problem in a file, positions zero-based as LSP has them. */
export interface Diagnostic {
  line: number;
  character: number;
  /** 1 error, 2 warning, 3 information, 4 hint; absent = the server did not say. */
  severity?: number;
  message: string;
  source?: string;
  code?: string;
}

export interface DiagnosticsResult {
  diagnostics: Diagnostic[];
  /** False when the deadline came before the server was done. */
  settled: boolean;
}

/** What starting a process looks like, so a test can hand in its own. */
export type SpawnServer = (server: ServerCommand, cwd: string, env: NodeJS.ProcessEnv) => ChildProcess;

export const spawnServer: SpawnServer = (server, cwd, env) =>
  server.shell
    ? // A `.cmd` shim needs cmd.exe; the arguments are this file's own constants.
      spawn(`"${server.command}"`, server.args, { cwd, env, shell: true, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    : spawn(server.command, server.args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface Published {
  version?: number;
  diagnostics: Diagnostic[];
  /** The activity count when it arrived, to tell it from an older push. */
  at: number;
}

/** LSP error codes after which a pull is worth asking again. */
const CONTENT_MODIFIED = -32801;
const SERVER_CANCELLED = -32802;

/**
 * The file a document URI names, in one spelling. Servers do not echo the
 * URI they were sent: Pyright and typescript-language-server answer
 * `file:///C:/x` as `file:///c%3A/x` (VS Code's spelling), so documents are
 * keyed by path — and on Windows, whose paths ignore case, by its lower case.
 */
export function documentKey(uri: string): string | undefined {
  try {
    const file = path.normalize(fileURLToPath(uri));
    return process.platform === 'win32' ? file.toLowerCase() : file;
  } catch {
    return undefined;
  }
}

function toDiagnostic(raw: unknown): Diagnostic | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const d = raw as { range?: { start?: { line?: unknown; character?: unknown } }; severity?: unknown; message?: unknown; source?: unknown; code?: unknown };
  const start = d.range?.start;
  if (typeof d.message !== 'string' || typeof start?.line !== 'number') return undefined;
  return {
    line: start.line,
    character: typeof start.character === 'number' ? start.character : 0,
    ...(typeof d.severity === 'number' ? { severity: d.severity } : {}),
    message: d.message,
    ...(typeof d.source === 'string' && d.source ? { source: d.source } : {}),
    ...(typeof d.code === 'string' || typeof d.code === 'number' ? { code: String(d.code) } : {}),
  };
}

function diagnosticsOf(list: unknown): Diagnostic[] {
  return Array.isArray(list) ? list.flatMap((item) => toDiagnostic(item) ?? []) : [];
}

/** Each problem once: a pull and a push often carry the same one, and
 *  rust-analyzer's own check and `cargo check` word one error two ways
 *  under the same code at the same place (the first list's wording wins). */
export function mergeDiagnostics(...lists: Diagnostic[][]): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const d of lists.flat()) {
    const key = `${d.line}:${d.character}:${d.code !== undefined ? `code ${d.code}` : d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out.sort((a, b) => (a.severity ?? 1) - (b.severity ?? 1) || a.line - b.line || a.character - b.character);
}

export class LspClient {
  private child: ChildProcess | undefined;
  private buffer = Buffer.alloc(0);
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly versions = new Map<string, number>();
  private readonly published = new Map<string, Published>();
  private readonly progress = new Set<string>();
  /** Bumped by everything the server sends; `wake` fires with it. */
  private activity = 0;
  private lastActivityAt = 0;
  private refreshAt = -1;
  private wake: (() => void) | undefined;
  private pull = false;
  private queue: Promise<unknown> = Promise.resolve();
  /** Set once the process is gone, with why. */
  dead: string | undefined;
  lastUsed = Date.now();

  constructor(
    readonly server: ServerCommand,
    readonly root: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly spawnFn: SpawnServer = spawnServer,
    private readonly clock: () => number = Date.now,
    /** Stops a process tree: a `.cmd` shim's server is cmd.exe's child,
     *  which killing cmd.exe leaves running. */
    private readonly kill?: (pid: number) => void,
  ) {}

  /** Start the process and initialize it; rejects when either fails. */
  async start(timeoutMs: number): Promise<void> {
    const child = this.spawnFn(this.server, this.root, this.env);
    this.child = child;
    child.on('error', (error) => this.died(`could not start: ${error.message}`));
    child.on('exit', (code) => this.died(`exited (${code ?? 'signal'})`));
    child.stdin?.on('error', () => {});
    child.stdout?.on('data', (chunk: Buffer) => this.read(chunk));
    const rootUri = pathToFileURL(this.root).href;
    const result = (await this.withTimeout(
      this.request('initialize', {
        // Pi, as the parent LSP says a server should exit without.
        processId: process.pid,
        rootUri,
        rootPath: this.root,
        workspaceFolders: [{ uri: rootUri, name: 'project' }],
        // Pyright otherwise speaks the machine's locale; the model reads it.
        locale: 'en',
        capabilities: {
          window: { workDoneProgress: true },
          workspace: { configuration: true },
          textDocument: {
            synchronization: { didSave: true },
            publishDiagnostics: { versionSupport: true },
          },
        },
      }),
      timeoutMs,
      'initialize',
    )) as { capabilities?: { diagnosticProvider?: unknown } } | null;
    this.pull = Boolean(result?.capabilities?.diagnosticProvider);
    this.notify('initialized', {});
  }

  /**
   * Hand the server the file's new text (open on first sight, a whole-text
   * change after) and save it, then collect what it says about it. Calls on
   * one server run one at a time: a second edit waits for the first's answer.
   */
  diagnose(file: string, languageId: string, text: string, deadline: number, signal?: AbortSignal): Promise<DiagnosticsResult> {
    const run = this.queue.then(() => this.diagnoseNow(file, languageId, text, deadline, signal));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Ask the server to shut down and exit, and kill it a second later if it
   *  has not (a `.cmd` shim's server only hears the request). */
  close(): void {
    const child = this.child;
    if (!child || this.dead) {
      this.child = undefined;
      return;
    }
    try {
      this.request('shutdown', null).catch(() => {});
      this.notify('exit', null);
    } catch {
      // Its pipe is already gone.
    }
    this.dead = 'closed';
    this.child = undefined;
    setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (this.kill && child.pid !== undefined) this.kill(child.pid);
      else child.kill();
    }, 1_000).unref();
  }

  /** The process, for a hard stop when Pi itself exits. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  private async diagnoseNow(file: string, languageId: string, text: string, deadline: number, signal?: AbortSignal): Promise<DiagnosticsResult> {
    if (this.dead) throw new Error(`${this.server.name} ${this.dead}`);
    this.lastUsed = this.clock();
    const uri = pathToFileURL(file).href;
    const key = documentKey(uri) ?? uri;
    const version = (this.versions.get(key) ?? 0) + 1;
    this.versions.set(key, version);
    const mark = this.activity;
    this.touch();
    if (version === 1) {
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version, text } });
    } else {
      this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
    }
    this.notify('textDocument/didSave', { textDocument: { uri }, text });

    let pulled = this.pull ? await this.pullDiagnostics(uri, deadline) : [];
    const afterPull = this.activity;
    const settled = await this.settle(key, mark, version, deadline, signal);
    // The server worked after the first pull (a project load, `cargo check`)
    // or asked for a re-pull: what it says now is the fresher answer.
    if (this.pull && (this.activity > afterPull || this.refreshAt > mark) && this.clock() < deadline) {
      pulled = await this.pullDiagnostics(uri, deadline);
    }
    const push = this.published.get(key);
    const pushed = push && this.answers(push, mark, version) ? push.diagnostics : [];
    return { diagnostics: mergeDiagnostics(pulled, pushed), settled };
  }

  private async pullDiagnostics(uri: string, deadline: number): Promise<Diagnostic[]> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const left = deadline - this.clock();
      if (left <= 0) return [];
      try {
        const report = (await this.withTimeout(this.request('textDocument/diagnostic', { textDocument: { uri } }), left, 'pull')) as {
          items?: unknown;
        } | null;
        return diagnosticsOf(report?.items);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code !== CONTENT_MODIFIED && code !== SERVER_CANCELLED) return [];
      }
    }
    return [];
  }

  /** Whether a push is about this change: it came after the change was sent
   *  and, when the server says which version it read, not an older one (a
   *  push for the last change can arrive late, after this one was sent). */
  private answers(push: Published, mark: number, version: number): boolean {
    return push.at > mark && (push.version === undefined || push.version >= version);
  }

  /** Wait for the server to go quiet (see the file comment). */
  private settle(key: string, mark: number, version: number, deadline: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (settled: boolean) => {
        if (timer) clearTimeout(timer);
        this.wake = undefined;
        signal?.removeEventListener('abort', aborted);
        resolve(settled);
      };
      const aborted = () => finish(false);
      const check = () => {
        if (timer) clearTimeout(timer);
        if (this.dead) return finish(false);
        const now = this.clock();
        if (now >= deadline) return finish(false);
        const push = this.published.get(key);
        const pushed = push !== undefined && this.answers(push, mark, version);
        const quietFor = now - this.lastActivityAt;
        if (this.progress.size === 0 && quietFor >= QUIET_MS && (this.pull || pushed)) return finish(true);
        const until = this.progress.size === 0 && (this.pull || pushed) ? QUIET_MS - quietFor : deadline - now;
        timer = setTimeout(check, Math.max(1, Math.min(until, deadline - now)));
      };
      if (signal?.aborted) return finish(false);
      signal?.addEventListener('abort', aborted, { once: true });
      this.wake = check;
      check();
    });
  }

  private touch(): void {
    this.activity++;
    this.lastActivityAt = this.clock();
  }

  private died(reason: string): void {
    if (!this.dead) this.dead = reason;
    for (const pending of this.pending.values()) pending.reject(new Error(`${this.server.name} ${reason}`));
    this.pending.clear();
    this.wake?.();
  }

  private send(message: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (!stdin || this.dead) throw new Error(`${this.server.name} ${this.dead ?? 'is not running'}`);
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
    stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    stdin.write(body);
  }

  private notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.server.name} did not answer ${what} in time`)), Math.max(1, ms));
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error as Error);
        },
      );
    });
  }

  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const length = /content-length:\s*(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString('ascii'));
      if (!length) {
        // Not a frame header: drop it and look for the next one.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const start = headerEnd + 4;
      const end = start + Number(length[1]);
      if (this.buffer.length < end) return;
      const body = this.buffer.subarray(start, end).toString('utf8');
      this.buffer = this.buffer.subarray(end);
      let message: unknown;
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }
      // This runs in Pi's own process: nothing a server sends may throw here.
      if (typeof message !== 'object' || message === null || Array.isArray(message)) continue;
      try {
        this.handle(message as Record<string, unknown>);
      } catch {
        // A frame this client cannot read says nothing it can use.
      }
    }
  }

  private handle(message: Record<string, unknown>): void {
    const { id, method } = message;
    if (typeof method === 'string' && id !== undefined) {
      this.answer(id, method, message.params);
    } else if (typeof id === 'number') {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      const error = message.error as { code?: unknown; message?: unknown } | undefined;
      if (error) pending?.reject(Object.assign(new Error(String(error.message ?? 'error')), { code: error.code }));
      else pending?.resolve(message.result);
      return;
    } else if (method === 'textDocument/publishDiagnostics') {
      const params = message.params as { uri?: unknown; version?: unknown; diagnostics?: unknown } | undefined;
      const key = typeof params?.uri === 'string' ? documentKey(params.uri) : undefined;
      if (key && params) {
        this.touch();
        this.published.set(key, {
          ...(typeof params.version === 'number' ? { version: params.version } : {}),
          diagnostics: diagnosticsOf(params.diagnostics),
          at: this.activity,
        });
      }
    } else if (method === '$/progress') {
      const params = message.params as { token?: unknown; value?: { kind?: unknown } } | undefined;
      const token = String(params?.token);
      if (params?.value?.kind === 'begin') this.progress.add(token);
      else if (params?.value?.kind === 'end') this.progress.delete(token);
      this.touch();
    } else {
      // Logs and other notices say nothing about this file's state.
      return;
    }
    this.wake?.();
  }

  /** A request from the server. Only what the servers above ask is
   *  answered with a result; anything else is refused as unknown. */
  private answer(id: unknown, method: string, params: unknown): void {
    let result: unknown = null;
    switch (method) {
      case 'workspace/configuration': {
        const items = (params as { items?: unknown } | undefined)?.items;
        result = Array.isArray(items) ? items.map(() => null) : [];
        break;
      }
      case 'workspace/diagnostic/refresh':
        this.touch();
        this.refreshAt = this.activity;
        this.wake?.();
        break;
      case 'window/workDoneProgress/create':
      case 'client/registerCapability':
      case 'client/unregisterCapability':
        break;
      default:
        try {
          this.send({ id, error: { code: -32601, message: `${method} is not supported` } });
        } catch {
          // Gone.
        }
        return;
    }
    try {
      this.send({ id, result });
    } catch {
      // Gone.
    }
  }
}
