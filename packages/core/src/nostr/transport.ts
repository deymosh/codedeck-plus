/**
 * Tor/SOCKS5-routed WebSocket implementation for BridgePool — for a bridge
 * whose only route to its relay(s) is Tor (e.g. alongside a Tor-only CLN
 * node). Off by default: only used when BridgeConfig.torProxyUrl is set
 * (see host.ts / bridge.ts).
 */
import WS from 'ws';
import { SocksProxyAgent } from 'socks-proxy-agent';

/**
 * Build a WebSocket class that routes every connection through a SOCKS5
 * proxy (typically a local Tor daemon's SocksPort, e.g.
 * `socks5h://127.0.0.1:9050`).
 *
 * The defensive `.on('error', ...)` below is deliberate and NOT redundant
 * with nostr-tools' own `ws.onerror` wiring (abstract-relay.ts): that guards
 * the WebSocket-protocol layer, but `ws`'s `agent` option hands connection
 * setup to the proxy agent's own socket, and a SOCKS5 CONNECT failure (Tor
 * circuit down, refused, timed out — routine on Tor, not exceptional) can
 * surface as a raw EventEmitter 'error' on that socket before `ws` finishes
 * forwarding it. An EventEmitter 'error' with zero listeners throws
 * synchronously and becomes an uncaughtException — exactly the crash this
 * feature exists to prevent. The no-op listener here is pure insurance:
 * nostr-tools' own onerror/onclose handling (which DOES see the error) still
 * drives the actual reconnect logic in BridgePool.
 */
export function createTorWebSocket(socksProxyUrl: string): typeof WebSocket {
  const agent = new SocksProxyAgent(socksProxyUrl);

  class TorWebSocket extends WS {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, { agent });
      this.on('error', () => {
        /* swallow — see comment above; nostr-tools handles the real
           reporting/reconnect via ws.onerror/ws.onclose. */
      });
    }
  }

  return TorWebSocket as unknown as typeof WebSocket;
}
