import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { InMemoryRelay } from '@codedeck/testkit';
import { startRelayServer, type RunningRelayServer } from '../relayServer';

const servers: RunningRelayServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  while (sockets.length > 0) sockets.pop()!.terminate();
  while (servers.length > 0) await servers.pop()!.close();
});

async function connect(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return ws;
}

/**
 * A queued frame reader, NOT one `.once('message', …)` per read: when a
 * server sends several frames back to back (e.g. an EVENT snapshot followed
 * immediately by EOSE), a single incoming TCP read can carry both, and `ws`'s
 * parser emits both `'message'` events synchronously in the same tick — a
 * fresh `.once` armed only after the first `await` resolves would miss the
 * second one forever. A persistent listener queues everything from the
 * moment the socket connects, so `next()` always sees what already arrived.
 */
function frameQueue(ws: WebSocket): { next(): Promise<unknown[]> } {
  const queue: unknown[][] = [];
  const waiters: ((frame: unknown[]) => void)[] = [];
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString('utf8')) as unknown[];
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else queue.push(frame);
  });
  return {
    next: () =>
      new Promise((resolve) => {
        const frame = queue.shift();
        if (frame) resolve(frame);
        else waiters.push(resolve);
      }),
  };
}

describe('startRelayServer', () => {
  it('assigns a real port and answers a REQ with a live EOSE', async () => {
    const relay = new InMemoryRelay();
    const server = await startRelayServer(relay);
    servers.push(server);
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`ws://127.0.0.1:${server.port}`);

    const ws = await connect(server.url);
    const frames = frameQueue(ws);
    ws.send(JSON.stringify(['REQ', 'sub-1', { kinds: [1] }]));
    expect(await frames.next()).toEqual(['EOSE', 'sub-1']);
  });

  it('replays stored events before EOSE, then live events after', async () => {
    const relay = new InMemoryRelay();
    const server = await startRelayServer(relay);
    servers.push(server);

    const stored = {
      id: 'evt-1', pubkey: 'aa'.repeat(32), kind: 1, created_at: 1000, tags: [], content: 'hi',
    };
    relay.publish(stored);

    const ws = await connect(server.url);
    const frames = frameQueue(ws);
    ws.send(JSON.stringify(['REQ', 'sub-1', { kinds: [1] }]));
    expect(await frames.next()).toEqual(['EVENT', 'sub-1', stored]);
    expect(await frames.next()).toEqual(['EOSE', 'sub-1']);

    // A publish from a second connection reaches the first as a live event.
    const publisher = await connect(server.url);
    const publisherFrames = frameQueue(publisher);
    const live = {
      id: 'evt-2', pubkey: 'bb'.repeat(32), kind: 1, created_at: 1001, tags: [], content: 'live',
    };
    publisher.send(JSON.stringify(['EVENT', live]));
    expect(await publisherFrames.next()).toEqual(['OK', 'evt-2', true, '']);
    expect(await frames.next()).toEqual(['EVENT', 'sub-1', live]);
  });

  it('CLOSE stops delivery to that subscription only', async () => {
    const relay = new InMemoryRelay();
    const server = await startRelayServer(relay);
    servers.push(server);

    const ws = await connect(server.url);
    const frames = frameQueue(ws);
    ws.send(JSON.stringify(['REQ', 'sub-1', {}]));
    await frames.next(); // EOSE
    ws.send(JSON.stringify(['CLOSE', 'sub-1']));

    let sawEvent = false;
    ws.on('message', () => {
      sawEvent = true;
    });
    const publisher = await connect(server.url);
    const publisherFrames = frameQueue(publisher);
    publisher.send(
      JSON.stringify([
        'EVENT',
        { id: 'evt-3', pubkey: 'cc'.repeat(32), kind: 1, created_at: 1002, tags: [], content: 'x' },
      ]),
    );
    await publisherFrames.next(); // OK
    await new Promise((r) => setTimeout(r, 30));
    expect(sawEvent).toBe(false);
  });

  it('a malformed frame is dropped, not a socket error', async () => {
    const relay = new InMemoryRelay();
    const server = await startRelayServer(relay);
    servers.push(server);

    const ws = await connect(server.url);
    const frames = frameQueue(ws);
    ws.send('not json at all');
    ws.send(JSON.stringify(['REQ', 'sub-1', {}]));
    expect(await frames.next()).toEqual(['EOSE', 'sub-1']);
  });
});
