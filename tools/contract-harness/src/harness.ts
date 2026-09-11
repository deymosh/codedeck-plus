/**
 * The harness "world": a REAL `BridgeCore` behind a `FakeSdkFacade`, its own
 * temp `sessionStateDir`, and a relay reached over a genuine `ws://` socket
 * (`relayServer.ts`) — the same shape `phoneCore.contract.test.ts` drives
 * in-process, made reachable from outside the Node process so a native
 * `client-runtime` can be the other end.
 */
import { promises as fs, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BridgeCore,
  generateKeypair,
  type BridgeHost,
  type Keypair,
  type PairingHandle,
  type PairingPayload,
  type PairingWindowInfo,
  type PairingWindowOptions,
} from '@codedeck/core';
import { FakeSdkFacade, InMemoryRelay } from '@codedeck/testkit';
import type { OutputEntry, SeqRange } from '@codedeck/protocol';
import { startRelayServer, type RunningRelayServer } from './relayServer';

export interface HarnessLogLine {
  level: string;
  message: string;
}

export interface Harness {
  relay: InMemoryRelay;
  relayServer: RunningRelayServer;
  bridgeKeys: Keypair;
  facade: FakeSdkFacade;
  /** The live `BridgeCore` — a fresh instance after `restart()`. */
  readonly core: BridgeCore;
  /** Every log line the host received, in order (drained on read by the
   *  control loop so the driver sees each line exactly once). */
  drainLogs(): HarnessLogLine[];
  openPairingWindow(opts?: PairingWindowOptions): PairingWindowInfo;
  /** `readRange` over the session's whole known range — `[]` for an unknown
   *  session, never a throw (mirrors the transcript store's own tolerance). */
  transcript(sessionId: string): Promise<{ seq: number; entry: OutputEntry }[]>;
  /** Shut the current `BridgeCore` down and start a fresh one with the SAME
   *  identity/storage/state dir — simulates a bridge process restart without
   *  losing the phone's pairing or the on-disk transcript. */
  restart(): Promise<void>;
  shutdown(): Promise<void>;
}

async function makeBridge(deps: {
  host: BridgeHost;
  bridgeKeys: Keypair;
  facade: FakeSdkFacade;
}): Promise<BridgeCore> {
  return BridgeCore.start({
    host: deps.host,
    secretKey: deps.bridgeKeys.secretKey,
    facade: deps.facade,
    heartbeatIntervalMs: 0,
  });
}

export async function createHarness(opts: { port?: number } = {}): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codedeck-contract-harness-'));
  const stateDir = path.join(dir, 'state');
  const wsRoot = path.join(dir, 'workspace');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(path.join(wsRoot, 'default'), { recursive: true });

  const relay = new InMemoryRelay();
  const relayServer = await startRelayServer(relay, { port: opts.port });
  const bridgeKeys = generateKeypair();
  const facade = new FakeSdkFacade();
  const storage = new Map<string, string>();
  let logs: HarnessLogLine[] = [];

  const host: BridgeHost = {
    config: {
      machineName: 'contract-harness',
      host: 'cli',
      relays: [relayServer.url],
      workspaceRoots: [wsRoot],
    },
    storage: {
      get: async (k) => storage.get(k),
      set: async (k, v) => {
        storage.set(k, v);
      },
      delete: async (k) => {
        storage.delete(k);
      },
    },
    sessionStateDir: () => stateDir,
    log: (level, msg) => {
      logs.push({ level, message: msg });
    },
    notify: () => {},
    presentPairing: (_payload: PairingPayload): PairingHandle => ({ close: () => {} }),
    onShutdown: () => {},
  };

  let core = await makeBridge({ host, bridgeKeys, facade });

  return {
    relay,
    relayServer,
    bridgeKeys,
    facade,
    get core() {
      return core;
    },
    drainLogs: () => {
      const out = logs;
      logs = [];
      return out;
    },
    openPairingWindow: (windowOpts) => core.openPairingWindow(windowOpts),
    transcript: async (sessionId) => {
      const high = core.transcript.seqHigh(sessionId);
      if (high <= 0) return [];
      const range: SeqRange = [1, high];
      return core.transcript.readRange(sessionId, range);
    },
    restart: async () => {
      await core.shutdown();
      core = await makeBridge({ host, bridgeKeys, facade });
    },
    shutdown: async () => {
      await core.shutdown();
      await relayServer.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
