/**
 * The CLI's BridgeHost implementation — deliberately razor-thin (the host.ts
 * design rule): config provider, state-file KV storage, state dir, stdout/
 * stderr logging, and presentPairing rendered as a terminal QR with a
 * manual-npub fallback. All engine logic stays in @codedeck/core.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  BridgeConfig,
  BridgeHost,
  LogLevel,
  PairingHandle,
  PairingPayload,
} from '@codedeck/core';
import type { CliState } from './state';
import { renderTerminalQr } from './terminalQr';

export interface CliHostOptions {
  config: BridgeConfig;
  state: CliState;
  homeDir: string;
  /** The bridge npub, shown beside the QR as the manual-pairing fallback. */
  npub: string;
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
  /** Suppress debug lines unless set (CODEDECK_DEBUG / --verbose). */
  verbose?: boolean;
}

export interface CliHost extends BridgeHost {
  /** Run every registered shutdown hook exactly once (signal handler entry). */
  runShutdownHooks(): Promise<void>;
}

export function createCliHost(options: CliHostOptions): CliHost {
  const out = options.out ?? process.stdout;
  const err = options.err ?? process.stderr;
  const hooks: Array<() => Promise<void> | void> = [];
  let shutdownRun: Promise<void> | null = null;

  const stateDir = path.join(options.homeDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  const write = (stream: NodeJS.WritableStream, line: string): void => {
    stream.write(`${line}\n`);
  };

  return {
    config: options.config,
    storage: options.state.storage(),
    sessionStateDir: () => stateDir,

    log: (level: LogLevel, msg: string): void => {
      if (level === 'debug' && !options.verbose) return;
      const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
      write(level === 'warn' || level === 'error' ? err : out, line);
    },

    notify: (level, msg): void => {
      write(err, `codedeck-bridge [${level}]: ${msg}`);
    },

    presentPairing: (payload: PairingPayload): PairingHandle => {
      // CDX-013: the QR carries the full URL (mesh invite included); the
      // printed text uses the redacted displayUrl so the nvpn invite secret
      // never sits on-screen/scrollback in plain text.
      const shownUrl = payload.displayUrl ?? payload.url;
      void renderTerminalQr(payload.url)
        .then((qr) => {
          write(out, '');
          write(out, 'Scan this QR with the CodeDeck app to pair your phone:');
          write(out, '');
          out.write(qr.endsWith('\n') ? qr : `${qr}\n`);
          write(out, `Pairing URL: ${shownUrl}`);
          write(out, '');
          write(out, 'No camera? Copy the pairing URL (or paste the bridge npub below) into');
          write(out, 'CodeDeck -> Settings -> Remote machines -> Pairing link.');
          write(out, `Bridge npub: ${options.npub}`);
          write(out, `The pairing window closes at ${payload.expiresAt.toLocaleString()}.`);
          write(out, '');
        })
        .catch((e) => {
          // QR rendering must never take pairing down — the URL still works.
          write(err, `codedeck-bridge: failed to render QR (${e}). Pairing URL: ${shownUrl}`);
        });
      return {
        close: () => {
          write(out, 'Pairing window closed.');
        },
      };
    },

    onShutdown: (fn): void => {
      hooks.push(fn);
    },

    runShutdownHooks: async (): Promise<void> => {
      shutdownRun ??= (async () => {
        for (const fn of hooks) {
          try {
            await fn();
          } catch (e) {
            write(err, `codedeck-bridge: shutdown hook failed: ${e}`);
          }
        }
      })();
      await shutdownRun;
    },
  };
}
