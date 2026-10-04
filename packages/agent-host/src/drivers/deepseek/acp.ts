/**
 * The Agent Client Protocol side of the DeepSeek Harness driver: JSON-RPC 2.0
 * over the newline-delimited stdio of a `dsh --profile acp` child — the ACP
 * v1 wire the framing here implements, typed by the protocol's own schema
 * package (a type-only import, so nothing of that package ships in the host).
 *
 * Small on purpose: the host needs requests with their replies, the agent's
 * notifications, its `session/request_permission` asks answered asynchronously,
 * and a definite end when the child dies. Everything above that — which
 * session a notification belongs to, what a permission ask becomes on the
 * phone — is the driver's, not the wire's.
 *
 * A line that is not a JSON-RPC message is logged and dropped rather than
 * killing the connection: the runtime owns stdout for ACP, but a wrapped or
 * interleaved line is not worth losing every running session over. A closed
 * stdio is the end: every pending request is rejected and `closed` settles.
 */
import type {
  AgentNotificationParamsByMethod,
  AgentRequestParamsByMethod,
  AgentRequestResponsesByMethod,
  ClientNotificationParamsByMethod,
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
} from '@agentclientprotocol/sdk';

/** A JSON-RPC id as it rides the wire (the agent may use either kind). */
type WireId = string | number;

/** A failed request, with the agent's own JSON-RPC error text. */
export class AcpRequestError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data: unknown = undefined,
  ) {
    super(message);
    this.name = 'AcpRequestError';
  }
}

/** The end of a connection: `error` is absent for an orderly close. */
export interface AcpClosed {
  error?: string;
}

export interface AcpClientOptions {
  /** The child's stdin — messages are written here. */
  stdin: NodeJS.WritableStream;
  /** The child's stdout — messages are read from here. */
  stdout: NodeJS.ReadableStream;
  /** Diagnostics (the host's stderr). Never given message contents verbatim
   *  beyond what a protocol error already says. */
  log: (message: string) => void;
}

/** Milliseconds a request may wait before it is abandoned. `initialize` gets
 *  one because a first run initializes the profile; a prompt does not, since
 *  a turn is as long as the model takes. */
export const INITIALIZE_TIMEOUT_MS = 120_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

/** A notification the agent sent. */
type NotificationHandler<M extends keyof ClientNotificationParamsByMethod> = (
  params: ClientNotificationParamsByMethod[M],
) => void;

/** An agent request (currently only permission) the client answers. */
type RequestHandler<M extends keyof ClientRequestParamsByMethod> = (
  params: ClientRequestParamsByMethod[M],
) => Promise<ClientRequestResponsesByMethod[M]>;

export class AcpClient {
  private readonly pending = new Map<WireId, Pending>();
  private readonly notifications = new Map<string, (params: never) => void>();
  private readonly requests = new Map<string, (params: never) => Promise<unknown>>();
  private nextId = 1;
  private buffer = '';
  private ending: AcpClosed | undefined;
  private readonly done: Promise<AcpClosed>;
  private settleDone!: (closed: AcpClosed) => void;
  private readonly onData: (chunk: Buffer | string) => void;
  private readonly onEnd: () => void;
  private readonly onError: (error: Error) => void;

  constructor(private readonly options: AcpClientOptions) {
    this.done = new Promise((resolve) => {
      this.settleDone = resolve;
    });
    this.onData = (chunk) => this.receive(chunk.toString());
    this.onEnd = () => this.finish({ error: 'the agent closed its output' });
    this.onError = (error) => this.finish({ error: error.message });
    options.stdout.on('data', this.onData as (chunk: unknown) => void);
    options.stdout.on('end', this.onEnd);
    options.stdout.on('error', this.onError);
  }

  /** Settles when the connection is over (either side ended it). */
  get closed(): Promise<AcpClosed> {
    return this.done;
  }

  /** Whether the connection can still carry messages. */
  get isOpen(): boolean {
    return this.ending === undefined;
  }

  /** Send one request and wait for its reply. */
  request<M extends keyof AgentRequestParamsByMethod>(
    method: M,
    params: AgentRequestParamsByMethod[M],
    options?: { timeoutMs?: number },
  ): Promise<AgentRequestResponsesByMethod[M]> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const pending: Pending = { resolve, reject };
      if (options?.timeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${String(method)} did not answer within ${options.timeoutMs}ms`));
        }, options.timeoutMs);
        pending.timer.unref?.();
      }
      this.pending.set(id, pending);
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }) as Promise<AgentRequestResponsesByMethod[M]>;
  }

  /** Send one notification (no reply follows, by definition). */
  notify<M extends keyof AgentNotificationParamsByMethod>(
    method: M,
    params: AgentNotificationParamsByMethod[M],
  ): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /** Handle one notification kind the agent sends. */
  on<M extends keyof ClientNotificationParamsByMethod>(method: M, handler: NotificationHandler<M>): void {
    this.notifications.set(method, handler as (params: never) => void);
  }

  /** Answer one kind of request the agent sends. */
  onRequest<M extends keyof ClientRequestParamsByMethod>(method: M, handler: RequestHandler<M>): void {
    this.requests.set(method, handler as (params: never) => Promise<unknown>);
  }

  /** Stop reading and end every pending request. Idempotent. */
  finish(closed: AcpClosed): void {
    if (this.ending !== undefined) return;
    this.ending = closed;
    this.options.stdout.off?.('data', this.onData as (chunk: unknown) => void);
    this.options.stdout.off?.('end', this.onEnd);
    this.options.stdout.off?.('error', this.onError);
    const reason = new Error(closed.error ?? 'the agent connection was closed');
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
    this.settleDone(closed);
  }

  private send(message: object): void {
    if (this.ending !== undefined) throw new Error(this.ending.error ?? 'the agent connection was closed');
    this.options.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** One chunk of the child's output: whole lines are dispatched, a partial
   *  one waits for the rest. */
  private receive(text: string): void {
    this.buffer += text;
    for (;;) {
      const end = this.buffer.indexOf('\n');
      if (end < 0) return;
      const line = this.buffer.slice(0, end).replace(/\r$/, '');
      this.buffer = this.buffer.slice(end + 1);
      if (line.trim() !== '') this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.options.log(`[deepseek] dropped a malformed line from the agent: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof message !== 'object' || message === null) {
      this.options.log('[deepseek] dropped a non-object message from the agent');
      return;
    }
    const frame = message as { id?: WireId; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
    if (typeof frame.method === 'string') {
      if (frame.id === undefined || frame.id === null) this.notifyIncoming(frame.method, frame.params);
      else void this.answer(frame.id, frame.method, frame.params);
      return;
    }
    if (frame.id === undefined || frame.id === null) {
      this.options.log('[deepseek] dropped a message from the agent with no id and no method');
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) {
      this.options.log(`[deepseek] dropped a reply to unknown request ${String(frame.id)}`);
      return;
    }
    this.pending.delete(frame.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (frame.error !== undefined && frame.error !== null) {
      const error = frame.error as { code?: unknown; message?: unknown; data?: unknown };
      const code = typeof error.code === 'number' ? error.code : -32603;
      const text = typeof error.message === 'string' ? error.message : 'the agent refused the request';
      pending.reject(new AcpRequestError(text, code, error.data));
    } else {
      pending.resolve(frame.result);
    }
  }

  private notifyIncoming(method: string, params: unknown): void {
    const handler = this.notifications.get(method);
    if (!handler) return;
    try {
      (handler as (params: unknown) => void)(params);
    } catch (error) {
      this.options.log(`[deepseek] ${method} handler failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Answer one agent request. A handler that throws becomes a JSON-RPC
   *  error, so the agent is never left waiting on a reply. */
  private async answer(id: WireId, method: string, params: unknown): Promise<void> {
    const handler = this.requests.get(method);
    if (!handler) {
      this.reply({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      return;
    }
    try {
      const result = await (handler as (params: unknown) => Promise<unknown>)(params);
      this.reply({ jsonrpc: '2.0', id, result });
    } catch (error) {
      this.reply({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private reply(message: object): void {
    // A reply to a request the agent sent is best effort: a connection that
    // closed in the meantime has nobody left to answer.
    try {
      this.send(message);
    } catch (error) {
      this.options.log(`[deepseek] could not answer the agent: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
