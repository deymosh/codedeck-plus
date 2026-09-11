/**
 * A real `ws://` relay in front of `@codedeck/testkit`'s `InMemoryRelay` —
 * the socket half the F2b plan (§4 Capa 2) calls for: the relay's storage and
 * filter semantics stay the well-exercised in-memory implementation, but a
 * client now reaches it over a genuine TCP socket, so serialization/framing/
 * timing bugs that only show up on a real wire surface here instead of only
 * in production.
 *
 * Speaks the client-facing half of the Nostr relay wire protocol:
 *   in  — `REQ` `CLOSE` `EVENT` (an `AUTH` frame is accepted and ignored: this
 *         harness never challenges, so a client that never receives an `AUTH`
 *         challenge never sends one either)
 *   out — `EVENT` `EOSE` `OK`
 * Anything else (a malformed frame, `NOTICE`, `CLOSED`) is not needed by this
 * harness and is simply never sent — this is a test tool, not a relay
 * implementation to hold to the letter of NIP-01.
 */
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { InMemoryRelay, RelayEvent, RelayFilter, Subscription } from '@codedeck/testkit';

export interface RunningRelayServer {
  /** `ws://127.0.0.1:<port>` — feed to a bridge/client's relay list. */
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Parse one relay-bound text frame; `null` on anything unparseable — the
 *  socket stays open, the frame is just dropped (mirrors a real relay). */
function parseFrame(text: string): unknown[] | null {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Start a `ws://` server backed by `relay`. `port: 0` (the default) asks the
 *  OS for a free port — read the real one off the returned `port`/`url`. */
export async function startRelayServer(
  relay: InMemoryRelay,
  opts: { port?: number; host?: string } = {},
): Promise<RunningRelayServer> {
  const host = opts.host ?? '127.0.0.1';
  const httpServer: Server = createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (socket: WebSocket) => {
    const subs = new Map<string, Subscription>();

    socket.on('message', (data) => {
      const frame = parseFrame(data.toString('utf8'));
      if (frame === null || typeof frame[0] !== 'string') return;
      const verb = frame[0];

      if (verb === 'REQ' && typeof frame[1] === 'string') {
        const subId = frame[1];
        const filters = frame.slice(2) as RelayFilter[];
        subs.get(subId)?.close();
        const sub = relay.subscribe(
          filters,
          (event: RelayEvent) => {
            if (socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify(['EVENT', subId, event]));
            }
          },
          () => {
            if (socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify(['EOSE', subId]));
            }
          },
        );
        subs.set(subId, sub);
        return;
      }

      if (verb === 'CLOSE' && typeof frame[1] === 'string') {
        subs.get(frame[1])?.close();
        subs.delete(frame[1]);
        return;
      }

      if (verb === 'EVENT' && typeof frame[1] === 'object' && frame[1] !== null) {
        const event = frame[1] as RelayEvent;
        const accepted = relay.publish(event);
        socket.send(JSON.stringify(['OK', event.id, accepted, accepted ? '' : 'invalid: refused']));
        return;
      }

      // AUTH (and anything else): no challenge is ever issued, so there is
      // nothing to answer or verify — the frame is simply ignored.
    });

    socket.on('close', () => {
      for (const sub of subs.values()) sub.close();
      subs.clear();
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(opts.port ?? 0, host, resolve));
  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `ws://${host}:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        wss.close((err) => {
          httpServer.close((closeErr) => {
            if (err ?? closeErr) reject(err ?? closeErr);
            else resolve();
          });
        });
        for (const client of wss.clients) client.terminate();
      }),
  };
}
