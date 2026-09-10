/**
 * NativeCoreControl — the outbound + lifecycle seam to the in-process Rust
 * `client-runtime` (migration F1).
 *
 * Present only when the APK is built with `native-core` (apps/mobile/src-tauri
 * `corebridge`) and the user opted in. `createPhoneCore` routes the bridge
 * protocol (30515 / 4515 / 4516 / 24515) through it instead of the WebView
 * transport + BridgeApi crypto + PhoneNostrClient; DM (1059) and Marmot (445)
 * stay on the WebView transport until F2a.
 *
 * Inbound is NOT part of this port: the boot layer subscribes to the native
 * events and pushes decoded messages onto `core.api.dispatchDecoded` and
 * connection snapshots onto `core.connection`.
 */
import type { BridgeToPhoneMessage, PhoneToBridgeMessage } from '@codedeck/protocol';
import type { PublishConfirmOptions, PublishResult } from './ports';

export interface NativeCoreInitConfig {
  relays: string[];
  /** The phone's persisted hex secret. Passed exactly once; never logged. */
  identitySecretHex: string;
  /** SOCKS5 `host:port` (Orbot), or null for a direct connection. */
  proxy: string | null;
  tor: boolean;
}

export interface NativeCoreControl {
  /** One-time: hand the runtime its relays + identity + proxy. Idempotent. */
  init(config: NativeCoreInitConfig): Promise<void>;
  /** Begin / end connecting. `start` is idempotent; the FSM inside owns
   *  reconnect/backoff. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** New paired-machine list (subscription authors + the known-machine gate). */
  setMachines(machines: string[]): Promise<void>;
  /** New relay list (settings changed). */
  setRelays(relays: string[]): Promise<void>;
  /** Send an UNSTAMPED phone→bridge command — the runtime stamps `v`/`caps`,
   *  NIP-44-encrypts, signs and publishes. Resolves false on failure (never
   *  throws through here). */
  send(machine: string, msg: PhoneToBridgeMessage): Promise<boolean>;
  /** As `send`, reporting the CDX-086 publish verdict (the image path). */
  publish(
    machine: string,
    msg: PhoneToBridgeMessage,
    opts?: PublishConfirmOptions,
  ): Promise<PublishResult>;
}

/** How the boot layer feeds decoded inbound messages back into the core. */
export type NativeCoreMessageSink = (machine: string, msg: BridgeToPhoneMessage) => void;
