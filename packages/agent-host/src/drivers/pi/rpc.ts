/**
 * Pi's RPC framing: one JSON object per LF-terminated line, in both
 * directions, over the child's stdio.
 *
 * The framing rules are Pi's own (`docs/rpc.md`), and two of them are the
 * reason this is not `readline`:
 *
 * - records are split on LF only, with one optional carriage return stripped
 *   before it. `U+2028` and `U+2029` are valid inside JSON strings and are
 *   not record boundaries — Node's `readline` treats them as ones, which
 *   would cut a record in half;
 * - a line that does not read is logged and skipped. The decoder is total:
 *   stdout is a child process's, and a crash or a stray write must not take
 *   the host down with it.
 *
 * Commands carry an id and are answered by id, since Pi handles commands
 * asynchronously. Writes honour stdin backpressure: a command is queued until
 * the pipe drains, so a burst of large prompts does not grow an unbounded
 * buffer in the child.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/** One decoded RPC record. Only the envelope matters here; the driver reads
 *  the rest. */
export interface PiRecord {
  type?: string;
  [key: string]: unknown;
}

/** How a child is spawned. Tests inject their own; production uses Node's. */
export type PiSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; stdio: ['pipe', 'pipe', 'pipe'] },
) => ChildProcess;

/** How long a command may go unanswered before its promise rejects. A local
 *  process should answer in milliseconds; a wedged one must not hold a
 *  session open for ever. */
export const PI_REQUEST_TIMEOUT_MS = 15_000;

/** How long closing stdin may take before the child is killed. Pi disposes
 *  its runtime and finishes pending work on EOF, which can take a moment. */
export const PI_CLOSE_GRACE_MS = 5_000;

/** Splits a byte stream into JSON records on LF. `push` never throws. */
export class PiLineDecoder {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';

  constructor(
    private readonly onRecord: (record: PiRecord) => void,
    private readonly onBadLine: (line: string, reason: string) => void,
  ) {}

  push(chunk: Buffer | string): void {
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    for (;;) {
      const end = this.pending.indexOf('\n');
      if (end < 0) return;
      let line = this.pending.slice(0, end);
      this.pending = this.pending.slice(end + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim() === '') continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        this.onBadLine(line, error instanceof Error ? error.message : String(error));
        continue;
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        this.onBadLine(line, 'not a JSON object');
        continue;
      }
      this.onRecord(value as PiRecord);
    }
  }
}

/** Splits a byte stream into lines (stderr, which is plain text). */
class TextLineDecoder {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer | string): void {
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    for (;;) {
      const end = this.pending.indexOf('\n');
      if (end < 0) return;
      let line = this.pending.slice(0, end);
      this.pending = this.pending.slice(end + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim() !== '') this.onLine(line);
    }
  }
}

interface PendingCommand {
  type: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PiRpcOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** A session event (everything that is neither a command response nor an
   *  extension UI request). */
  onEvent(record: PiRecord): void;
  /** An `extension_ui_request`: a dialog or a notification from an
   *  extension. */
  onUiRequest(record: PiRecord): void;
  /** The child is gone. Called exactly once. */
  onExit(code: number | null, signal: NodeJS.Signals | null): void;
  /** A diagnostic line from Pi (stderr). */
  onStderr(line: string): void;
  /** A stdout line that was not a record. */
  onBadLine(line: string, reason: string): void;
  spawnFn?: PiSpawn;
  requestTimeoutMs?: number;
}

export class PiRpc {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly timeoutMs: number;
  private writing: Promise<void> = Promise.resolve();
  private nextId = 0;
  private exited = false;

  constructor(private readonly options: PiRpcOptions) {
    this.timeoutMs = options.requestTimeoutMs ?? PI_REQUEST_TIMEOUT_MS;
    const spawnFn: PiSpawn = options.spawnFn ?? ((command, args, opts) => spawn(command, args, opts));
    this.child = spawnFn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdout = new PiLineDecoder((record) => this.route(record), options.onBadLine);
    this.child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    const stderr = new TextLineDecoder((line) => options.onStderr(line));
    this.child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    this.child.stdin?.on('error', (error: Error) => options.onBadLine('', `stdin: ${error.message}`));
    this.child.on('error', (error: Error) => {
      options.onBadLine('', `process: ${error.message}`);
      this.finish(null, null);
    });
    // `close`, not `exit`: `exit` may come while stdout still holds the
    // child's last records (an error message, `agent_settled`), and those
    // must reach the driver before it hears the process is gone.
    this.child.on('close', (code, signal) => this.finish(code, signal));
  }

  /** Whether the process is still running. */
  get alive(): boolean {
    return !this.exited;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Send one command and resolve with its `data` once Pi answers. Rejects
   *  with Pi's own error text, or when the timeout expires. */
  request(type: string, fields: Record<string, unknown> = {}, timeoutMs = this.timeoutMs): Promise<unknown> {
    const id = `cd${++this.nextId}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi did not answer '${type}' within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { type, resolve, reject, timer });
      this.write({ id, type, ...fields });
    });
  }

  /** Answer an extension UI request (`extension_ui_response`). Pi expects no
   *  command response to these. */
  respond(record: Record<string, unknown>): void {
    this.write(record);
  }

  /** Close stdin and wait for a graceful exit, killing the process when it
   *  does not come. Idempotent. */
  async close(graceMs = PI_CLOSE_GRACE_MS): Promise<void> {
    if (this.exited) return;
    // Queued commands go first, but only for the grace period: a Pi that
    // stopped reading its stdin never drains it, and closing must still end.
    await Promise.race([
      this.writing.catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, graceMs).unref?.()),
    ]);
    try {
      this.child.stdin?.end();
    } catch {
      // Already closed.
    }
    const exit = new Promise<void>((resolve) => {
      if (this.exited) return resolve();
      this.child.once('close', () => resolve());
    });
    const gaveUp = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, graceMs);
      timer.unref?.();
    });
    await Promise.race([exit, gaveUp]);
    if (!this.exited) {
      try {
        this.child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      await Promise.race([exit, new Promise<void>((resolve) => setTimeout(resolve, 1_000).unref?.())]);
    }
  }

  /** Stop the process now, without a graceful shutdown. Idempotent. */
  kill(): void {
    if (this.exited) return;
    try {
      this.child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }

  private route(record: PiRecord): void {
    if (record.type === 'response') {
      const id = typeof record.id === 'string' ? record.id : undefined;
      if (id !== undefined) {
        const pending = this.pending.get(id);
        if (!pending) {
          this.options.onBadLine('', `response for unknown command '${String(record.command ?? '?')}'`);
          return;
        }
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (record.success === false) {
          const reason = typeof record.error === 'string' && record.error !== '' ? record.error : 'the command failed';
          pending.reject(new Error(reason));
        } else {
          pending.resolve(record.data);
        }
        return;
      }
      // A parse error's response carries no id: Pi could not read a command.
      this.options.onBadLine('', `Pi reported: ${String(record.error ?? 'a command it could not parse')}`);
      return;
    }
    if (record.type === 'extension_ui_request') {
      this.options.onUiRequest(record);
      return;
    }
    this.options.onEvent(record);
  }

  /** Serialise writes and honour stdin backpressure. */
  private write(record: Record<string, unknown>): void {
    const line = `${JSON.stringify(record)}\n`;
    this.writing = this.writing.then(() => this.writeLine(line));
  }

  private writeLine(line: string): Promise<void> {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed || this.exited) return Promise.resolve();
    return new Promise<void>((resolve) => {
      // A pipe that closes (the child exited) neither drains nor always
      // errors: `close` settles the write too, so the queue never stalls.
      const done = (): void => {
        stdin.off('drain', done);
        stdin.off('error', done);
        stdin.off('close', done);
        resolve();
      };
      stdin.once('drain', done);
      stdin.once('error', done);
      stdin.once('close', done);
      try {
        if (stdin.write(line)) done();
      } catch {
        done();
      }
    });
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Pi exited before answering '${pending.type}'`));
    }
    this.pending.clear();
    this.options.onExit(code, signal);
  }
}
