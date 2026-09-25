/**
 * The agent host: routes driver-protocol frames between the bridge (stdio)
 * and the drivers.
 *
 * Invariants it keeps so drivers do not have to:
 * - every bridge request gets exactly one reply (its typed reply or
 *   `error`), even when a driver throws;
 * - a session's events reach the bridge only after `start-session` was
 *   acknowledged, and never after its `ended` or an `end-session`;
 * - a request the host sent is settled exactly once — by the bridge's reply,
 *   or with `cancelled` when the host shuts down.
 */
import type { Driver, DriverSession, SessionContext } from './driver';
import {
  DRIVER_PROTOCOL_VERSION,
  type BridgeFrame,
  type BridgeMessage,
  type HostMessage,
  type SelectOutcome,
  type SessionEvent,
} from './types';

export interface HostIo {
  /** Write one frame (a single line, no trailing newline). */
  write(line: string): void;
  /** A diagnostic line (stderr — the bridge prefixes it into its log). */
  log(message: string): void;
}

type Reply = Extract<BridgeMessage, { kind: 'permission-outcome' | 'plan-outcome' | 'question-outcome' | 'host-tool-result' }>;

interface SessionSlot {
  agent: string;
  session: DriverSession | null;
  /** Events emitted before the start was acknowledged, flushed right after. */
  buffered: SessionEvent[] | null;
  closed: boolean;
}

/** Parse one line into a bridge frame. Only the envelope is checked: the
 *  bridge is the authoritative, trusted peer, and payloads are typed by the
 *  generated protocol. */
export function parseBridgeFrame(line: string): BridgeFrame | string {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (err) {
    return `malformed frame: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'malformed frame: not an object';
  const frame = value as { v?: unknown; id?: unknown; kind?: unknown; payload?: unknown };
  if (frame.v !== DRIVER_PROTOCOL_VERSION) return `driver protocol v${String(frame.v)} is not supported`;
  if (typeof frame.kind !== 'string') return 'malformed frame: no kind';
  if (typeof frame.payload !== 'object' || frame.payload === null) return 'malformed frame: no payload';
  if (frame.id !== undefined && frame.id !== null && typeof frame.id !== 'string') return 'malformed frame: bad id';
  return value as BridgeFrame;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AgentHost {
  private readonly drivers: Map<string, Driver>;
  private readonly sessions = new Map<string, SessionSlot>();
  private readonly pending = new Map<string, (reply: Reply | null) => void>();
  private nextRequestId = 0;
  private shuttingDown = false;

  constructor(
    drivers: Driver[],
    private readonly io: HostIo,
    private readonly hostVersion: string,
  ) {
    this.drivers = new Map(drivers.map((d) => [d.info().id, d]));
  }

  /** Handle one line from the bridge. Never rejects. */
  async handleLine(line: string): Promise<void> {
    if (line.trim() === '') return;
    const frame = parseBridgeFrame(line);
    if (typeof frame === 'string') {
      this.io.log(`[agent-host] dropped frame: ${frame}`);
      return;
    }
    const id = frame.id ?? undefined;
    const message = frame as unknown as BridgeMessage;
    if (isReply(message)) {
      const settle = id !== undefined ? this.pending.get(id) : undefined;
      if (!settle) {
        this.io.log(`[agent-host] reply ${message.kind} for unknown request ${String(id)}`);
        return;
      }
      this.pending.delete(id!);
      settle(message);
      return;
    }
    if (id === undefined) {
      this.io.log(`[agent-host] request ${message.kind} without an id — ignored`);
      return;
    }
    if (message.kind === 'start-session') {
      // Synchronous from start to ack, so no other request's reply can slip
      // between them; the events the driver emitted meanwhile follow the ack.
      let slot: SessionSlot | undefined;
      try {
        slot = this.startSession(message.payload);
        this.reply(id, ack());
      } catch (err) {
        this.reply(id, { kind: 'error', payload: { message: errorText(err) } });
        return;
      }
      const buffered = slot.buffered ?? [];
      slot.buffered = null;
      for (const event of buffered) this.emit(message.payload.sessionId, slot, event);
      return;
    }
    try {
      this.reply(id, await this.handleRequest(message));
    } catch (err) {
      this.reply(id, { kind: 'error', payload: { message: errorText(err) } });
    }
  }

  /** End every session and settle every open request. Called on stdin EOF. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const settle of this.pending.values()) settle(null);
    this.pending.clear();
    const ends = [...this.sessions.values()].map((slot) => {
      slot.closed = true;
      return slot.session?.end().catch(() => {});
    });
    this.sessions.clear();
    await Promise.all(ends);
    await Promise.all([...this.drivers.values()].map((d) => d.shutdown?.().catch(() => {})));
  }

  private async handleRequest(message: BridgeMessage): Promise<HostMessage> {
    switch (message.kind) {
      case 'initialize':
        return {
          kind: 'initialized',
          payload: { hostVersion: this.hostVersion, agents: [...this.drivers.values()].map((d) => d.info()) },
        };
      case 'end-session': {
        const slot = this.sessions.get(message.payload.sessionId);
        this.sessions.delete(message.payload.sessionId);
        if (slot) {
          slot.closed = true;
          await slot.session?.end();
        }
        return ack();
      }
      case 'prompt':
        this.session(message.payload.sessionId).prompt(message.payload.text);
        return ack();
      case 'interrupt':
        await this.session(message.payload.sessionId).interrupt();
        return ack();
      case 'set-option':
        await this.session(message.payload.sessionId).setOption(message.payload.option, message.payload.value);
        return ack();
      case 'list-models': {
        const result = await this.driver(message.payload.agent).listModels();
        return {
          kind: 'models',
          payload: { models: result.models, ...(result.defaultModel ? { defaultModel: result.defaultModel } : {}) },
        };
      }
      case 'get-usage': {
        const usage = await this.session(message.payload.sessionId).getUsage();
        return { kind: 'usage', payload: usage ? { usage } : {} };
      }
      case 'check-credential': {
        const driver = this.driver(message.payload.agent);
        const valid = await driver.checkCredential?.(message.payload.credential, message.payload.value);
        return { kind: 'credential-checked', payload: valid === undefined ? {} : { valid } };
      }
      default:
        throw new Error(`unsupported request ${(message as { kind: string }).kind}`);
    }
  }

  private startSession(params: Extract<BridgeMessage, { kind: 'start-session' }>['payload']): SessionSlot {
    const driver = this.driver(params.agent);
    const reason = driver.info().unavailableReason;
    if (reason) throw new Error(reason);
    if (this.sessions.has(params.sessionId)) throw new Error(`session ${params.sessionId} is already running`);
    const slot: SessionSlot = { agent: params.agent, session: null, buffered: [], closed: false };
    this.sessions.set(params.sessionId, slot);
    try {
      slot.session = driver.startSession(params, this.contextFor(params.sessionId, slot));
    } catch (err) {
      this.sessions.delete(params.sessionId);
      throw err;
    }
    return slot;
  }

  private contextFor(sessionId: string, slot: SessionSlot): SessionContext {
    return {
      sessionId,
      emit: (event) => {
        if (slot.buffered) slot.buffered.push(event);
        else this.emit(sessionId, slot, event);
      },
      requestPermission: async (request) =>
        selectOutcome(await this.request({ kind: 'request-permission', payload: { sessionId, ...request } }), 'permission-outcome'),
      askQuestion: async (requestId, questions) => {
        const reply = await this.request({ kind: 'ask-question', payload: { sessionId, requestId, questions } });
        return reply?.kind === 'question-outcome' ? reply.payload : cancelled();
      },
      requestPlanApproval: async (requestId, options) =>
        selectOutcome(
          await this.request({ kind: 'request-plan-approval', payload: { sessionId, requestId, options } }),
          'plan-outcome',
        ),
      callHostTool: async (tool, args) => {
        const reply = await this.request({ kind: 'call-host-tool', payload: { sessionId, tool, args } });
        return reply?.kind === 'host-tool-result'
          ? { text: reply.payload.text, isError: reply.payload.isError ?? false }
          : { text: 'The bridge did not answer the tool call.', isError: true };
      },
      log: (line) => this.io.log(line),
    };
  }

  private emit(sessionId: string, slot: SessionSlot, event: SessionEvent): void {
    if (slot.closed) return;
    this.write(undefined, { kind: 'session-event', payload: { sessionId, event } });
    if (event.type === 'ended') {
      slot.closed = true;
      if (this.sessions.get(sessionId) === slot) this.sessions.delete(sessionId);
    }
  }

  /** Send a request to the bridge; resolves with its reply, or null when the
   *  host shuts down first. */
  private request(message: HostMessage): Promise<Reply | null> {
    if (this.shuttingDown) return Promise.resolve(null);
    const id = `h${++this.nextRequestId}`;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.write(id, message);
    });
  }

  private reply(id: string, message: HostMessage): void {
    this.write(id, message);
  }

  private write(id: string | undefined, message: HostMessage): void {
    this.io.write(JSON.stringify({ v: DRIVER_PROTOCOL_VERSION, ...(id !== undefined ? { id } : {}), ...message }));
  }

  private driver(agent: string): Driver {
    const driver = this.drivers.get(agent);
    if (!driver) throw new Error(`no agent '${agent}' in this host`);
    return driver;
  }

  private session(sessionId: string): DriverSession {
    const slot = this.sessions.get(sessionId);
    if (!slot?.session || slot.closed) throw new Error(`no running session ${sessionId}`);
    return slot.session;
  }
}

function ack(): HostMessage {
  return { kind: 'ack' };
}

function cancelled(): { outcome: 'cancelled'; reason: string } {
  return { outcome: 'cancelled', reason: 'The agent host is shutting down' };
}

function selectOutcome(reply: Reply | null, kind: 'permission-outcome' | 'plan-outcome'): SelectOutcome {
  return reply?.kind === kind ? reply.payload : cancelled();
}

function isReply(message: BridgeMessage): message is Reply {
  return (
    message.kind === 'permission-outcome' ||
    message.kind === 'plan-outcome' ||
    message.kind === 'question-outcome' ||
    message.kind === 'host-tool-result'
  );
}
