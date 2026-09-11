/**
 * The stdin/stdout control protocol (F2b plan §4 Capa 2) — pure request →
 * response dispatch over a `Harness`, deliberately separated from process
 * I/O (`main.ts`) so it is unit-testable without a subprocess.
 *
 * See `README.md` for the wire shape and the full command list.
 */
import type { SdkMessage } from '@codedeck/core';
import type { PairingWindowOptions } from '@codedeck/core';
import type { Harness } from './harness';

export type HarnessCommand =
  | { id: string; cmd: 'get-relay-url' }
  | { id: string; cmd: 'open-pairing-window'; opts?: PairingWindowOptions }
  | { id: string; cmd: 'emit-sdk-message'; sessionId: string; message: SdkMessage }
  | { id: string; cmd: 'list-sdk-sessions' }
  | { id: string; cmd: 'get-bridge-transcript'; sessionId: string }
  | { id: string; cmd: 'restart-bridge' }
  | { id: string; cmd: 'drain-logs' }
  | { id: string; cmd: 'shutdown' };

export type HarnessResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

/** `id` alone, for a request too malformed to know its shape. */
export function errorResponse(id: string, error: unknown): HarnessResponse {
  return { id, ok: false, error: error instanceof Error ? error.message : String(error) };
}

export async function handleCommand(
  harness: Harness,
  req: HarnessCommand,
): Promise<HarnessResponse> {
  try {
    switch (req.cmd) {
      case 'get-relay-url':
        return { id: req.id, ok: true, result: { url: harness.relayServer.url } };

      case 'open-pairing-window': {
        const info = harness.openPairingWindow(req.opts);
        return {
          id: req.id,
          ok: true,
          result: {
            url: info.url,
            displayUrl: info.displayUrl,
            token: info.token,
            expiresAt: info.expiresAt.toISOString(),
          },
        };
      }

      case 'emit-sdk-message':
        harness.facade.emit(req.sessionId, req.message);
        return { id: req.id, ok: true, result: null };

      case 'list-sdk-sessions':
        // Insertion order — a driver that just called create-session over the
        // wire can safely take the last id as the one it caused.
        return { id: req.id, ok: true, result: [...harness.facade.sessions.keys()] };

      case 'get-bridge-transcript': {
        const rows = await harness.transcript(req.sessionId);
        return { id: req.id, ok: true, result: rows };
      }

      case 'restart-bridge':
        await harness.restart();
        return { id: req.id, ok: true, result: null };

      case 'drain-logs':
        return { id: req.id, ok: true, result: harness.drainLogs() };

      case 'shutdown':
        await harness.shutdown();
        return { id: req.id, ok: true, result: null };

      default: {
        // Exhaustiveness guard: a new HarnessCommand variant left unhandled
        // above fails the build here, not silently at runtime.
        const unreachable: never = req;
        return errorResponse((unreachable as { id: string }).id, 'unknown command');
      }
    }
  } catch (err) {
    return errorResponse(req.id, err);
  }
}
