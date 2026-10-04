/**
 * The ACP wire client: what the driver sends and receives over the harness's
 * stdio. The harness itself is the fake in fakeHarness.ts; here the peer is
 * whatever a test writes, which is how the wire's own cases (a malformed
 * line, a reply to nothing, a message split across chunks, the child going
 * away) are covered.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { AcpClient, AcpRequestError } from '../acp';

interface Wire {
  client: AcpClient;
  /** Everything the client wrote, in order. */
  sent: Array<Record<string, unknown>>;
  /** The last request the client wrote. */
  last(): Record<string, unknown>;
  /** One message from the agent. */
  reply(message: unknown): void;
  /** One raw line from the agent. */
  raw(line: string): void;
  /** End the agent's output, as a dead process does. */
  end(): void;
  logs: string[];
}

function wire(): Wire {
  const out = new PassThrough();
  const incoming = new PassThrough();
  const logs: string[] = [];
  const sent: Array<Record<string, unknown>> = [];
  out.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) if (line.trim() !== '') sent.push(JSON.parse(line));
  });
  const client = new AcpClient({ stdin: out, stdout: incoming, log: (line) => logs.push(line) });
  incoming.resume();
  return {
    client,
    sent,
    logs,
    last: () => sent[sent.length - 1]!,
    reply: (message) => incoming.write(`${JSON.stringify(message)}\n`),
    raw: (line) => incoming.write(line),
    end: () => incoming.end(),
  };
}

/** A client whose initialize has already been answered. */
async function connected(): Promise<Wire> {
  const w = wire();
  const initialized = w.client.request('initialize', { protocolVersion: 1 });
  w.reply({ jsonrpc: '2.0', id: w.last().id, result: { protocolVersion: 1, agentCapabilities: {} } });
  await initialized;
  return w;
}

describe('requests', () => {
  it('writes one JSON-RPC request per line and waits for its reply', async () => {
    const w = await connected();
    const pending = w.client.request('session/new', { cwd: '/work', mcpServers: [] });
    expect(w.last()).toEqual({ jsonrpc: '2.0', id: expect.any(Number), method: 'session/new', params: { cwd: '/work', mcpServers: [] } });
    w.reply({ jsonrpc: '2.0', id: w.last().id, result: { sessionId: 's1', configOptions: [] } });
    expect(await pending).toEqual({ sessionId: 's1', configOptions: [] });
  });

  it('matches replies to their own request, whichever order they arrive in', async () => {
    const w = await connected();
    const first = w.client.request('session/list', {});
    const firstId = w.last().id;
    const second = w.client.request('session/list', {});
    const secondId = w.last().id;
    w.reply({ jsonrpc: '2.0', id: secondId, result: { sessions: [{ sessionId: 's2', cwd: '/b' }] } });
    w.reply({ jsonrpc: '2.0', id: firstId, result: { sessions: [] } });
    expect(await first).toEqual({ sessions: [] });
    expect(await second).toEqual({ sessions: [{ sessionId: 's2', cwd: '/b' }] });
  });

  it('refuses with the agent’s own error', async () => {
    const w = await connected();
    const pending = w.client.request('session/resume', { sessionId: 'gone', cwd: '/work' });
    w.reply({ jsonrpc: '2.0', id: w.last().id, error: { code: -32602, message: 'Invalid params: session is not resumable: gone' } });
    await expect(pending).rejects.toBeInstanceOf(AcpRequestError);
    await expect(pending.catch((error: AcpRequestError) => [error.code, error.message])).resolves.toEqual([
      -32602,
      'Invalid params: session is not resumable: gone',
    ]);
  });

  it('gives up on a request that is never answered', async () => {
    const w = await connected();
    await expect(w.client.request('session/new', { cwd: '/work', mcpServers: [] }, { timeoutMs: 5 })).rejects.toThrow(/did not answer within 5ms/);
  });

  it('sends a notification without waiting for anything', async () => {
    const w = await connected();
    w.client.notify('session/cancel', { sessionId: 's1' });
    expect(w.last()).toEqual({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's1' } });
  });
});

describe('messages from the agent', () => {
  it('hands a notification to its handler', async () => {
    const w = await connected();
    const updates = vi.fn();
    w.client.on('session/update', updates);
    w.reply({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk' } } });
    expect(updates).toHaveBeenCalledWith({ sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk' } });
  });

  it('answers a request the agent makes', async () => {
    const w = await connected();
    w.client.onRequest('session/request_permission', async () => ({ outcome: { outcome: 'selected', optionId: 'allow-once' } }) as const);
    w.reply({ jsonrpc: '2.0', id: 77, method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: 'c1' }, options: [] } });
    await vi.waitFor(() => expect(w.sent.some((message) => message.id === 77 && message.result !== undefined)).toBe(true));
    expect(w.sent.find((message) => message.id === 77)?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
  });

  it('refuses a request it has no handler for, rather than leaving the agent waiting', async () => {
    const w = await connected();
    w.reply({ jsonrpc: '2.0', id: 78, method: 'fs/read_text_file', params: { sessionId: 's1', path: '/x' } });
    await vi.waitFor(() => expect(w.sent.some((message) => message.id === 78)).toBe(true));
    expect(w.sent.find((message) => message.id === 78)?.error).toEqual({ code: -32601, message: 'Method not found: fs/read_text_file' });
  });

  it('turns a handler failure into an error reply', async () => {
    const w = await connected();
    w.client.onRequest('session/request_permission', async () => {
      throw new Error('the phone is gone');
    });
    w.reply({ jsonrpc: '2.0', id: 79, method: 'session/request_permission', params: { sessionId: 's1', toolCall: {}, options: [] } });
    await vi.waitFor(() => expect(w.sent.some((message) => message.id === 79)).toBe(true));
    expect(w.sent.find((message) => message.id === 79)?.error).toEqual({ code: -32603, message: 'the phone is gone' });
  });

  it('survives a handler that throws synchronously', async () => {
    const w = await connected();
    w.client.on('session/update', () => {
      throw new Error('bad update');
    });
    w.reply({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: {} } });
    expect(w.logs.some((line) => /session\/update handler failed: bad update/.test(line))).toBe(true);
    expect(w.client.isOpen).toBe(true);
  });
});

describe('the wire itself', () => {
  it('drops a line that is not JSON and keeps going', async () => {
    const w = await connected();
    w.raw('not json at all\n');
    expect(w.logs.some((line) => /dropped a malformed line/.test(line))).toBe(true);
    const pending = w.client.request('session/list', {});
    w.reply({ jsonrpc: '2.0', id: w.last().id, result: { sessions: [] } });
    expect(await pending).toEqual({ sessions: [] });
  });

  it('drops a message that is not an object, and a reply to nothing', async () => {
    const w = await connected();
    w.raw('"just a string"\n');
    w.reply({ jsonrpc: '2.0', id: 4242, result: {} });
    expect(w.logs.some((line) => /dropped a non-object message/.test(line))).toBe(true);
    expect(w.logs.some((line) => /dropped a reply to unknown request 4242/.test(line))).toBe(true);
  });

  it('reads a message split across chunks, and tolerates CRLF', async () => {
    const w = new PassThrough();
    const incoming = new PassThrough();
    const client = new AcpClient({ stdin: w, stdout: incoming, log: () => {} });
    const updates = vi.fn();
    client.on('session/update', updates);
    const line = `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1' } })}\r\n`;
    incoming.write(line.slice(0, 20));
    incoming.write(line.slice(20));
    expect(updates).toHaveBeenCalledWith({ sessionId: 's1' });
  });

  it('refuses anything once the agent is gone', async () => {
    const w = await connected();
    const pending = w.client.request('session/list', {});
    w.end();
    await expect(pending).rejects.toThrow(/closed its output/);
    expect(await w.client.closed).toEqual({ error: 'the agent closed its output' });
    expect(w.client.isOpen).toBe(false);
    expect(() => w.client.notify('session/cancel', { sessionId: 's1' })).toThrow(/closed its output/);
  });

  it('reports an error the transport itself raised', async () => {
    const w = await connected();
    w.client.on('session/update', () => {});
    const incoming = new PassThrough();
    const client = new AcpClient({ stdin: new PassThrough(), stdout: incoming, log: () => {} });
    const closed = client.closed;
    incoming.emit('error', new Error('EPIPE'));
    expect(await closed).toEqual({ error: 'EPIPE' });
  });

  it('finishes once, however many ways it is ended', async () => {
    const w = await connected();
    let notifications = 0;
    void w.client.closed.then(() => {
      notifications++;
    });
    w.client.finish({ error: 'first' });
    w.client.finish({ error: 'second' });
    w.end();
    expect(await w.client.closed).toEqual({ error: 'first' });
    expect(notifications).toBe(1);
  });
});
