/**
 * Real-socket transport smoke — the laptop-runnable slice of the device
 * run-sheet §3 (docs/CDX-009-3B-DEVICE-VERIFY.md).
 *
 * Drives the PRODUCTION phone core with the PRODUCTION relay transport
 * (nostr-tools SimplePool over a real WebSocket) against the real bridge-cli
 * (spawned as a child process, real `claude` on PATH) through a locally
 * served `apps/relay` worker (`wrangler dev`). Everything the contract tests
 * prove in-process is re-proven here over real sockets: pairing, heartbeat,
 * session creation, live output streaming, and bridge-restart reconnect with
 * the session list surviving.
 *
 * Gated off by default (needs a running relay + network + real claude):
 *
 *   # terminal 1
 *   pnpm --filter @codedeck/relay exec wrangler dev --ip 0.0.0.0 --port 8788 \
 *     --var RESTRICTED_WRITES:false
 *   # terminal 2
 *   CDX_REALSOCKET=1 pnpm --filter @codedeck/mobile exec vitest run \
 *     src/__tests__/realSocket.smoke.test.ts
 *
 * Optional: CDX_REALSOCKET_RELAY=ws://host:port (default ws://127.0.0.1:8788).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPhoneCore, memoryKV, parsePairingUrl, type PhoneCore } from '../core';
import { createRelayTransport } from '../platform/relayTransport';

const RELAY_URL = process.env.CDX_REALSOCKET_RELAY ?? 'ws://127.0.0.1:8788';
const ENABLED = process.env.CDX_REALSOCKET === '1';

const BRIDGE_MAIN = resolve(__dirname, '../../../bridge-cli/out/main.js');

interface Proc {
  child: ChildProcess;
  stdout: string;
  exited: Promise<number | null>;
}

function spawnBridge(args: string[], env: Record<string, string>): Proc {
  const child = spawn(process.execPath, [BRIDGE_MAIN, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const proc: Proc = {
    child,
    stdout: '',
    exited: new Promise((res) => child.on('exit', (code) => res(code))),
  };
  child.stdout!.on('data', (d: Buffer) => (proc.stdout += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (proc.stdout += d.toString()));
  return proc;
}

async function until(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
}

describe.runIf(ENABLED)('real-socket smoke (bridge-cli ↔ local relay ↔ phone core)', () => {
  const cleanups: Array<() => void> = [];
  afterAll(() => {
    for (const fn of cleanups.reverse()) {
      try {
        fn();
      } catch {
        /* best-effort */
      }
    }
  });

  it(
    'pairs, streams live output, and survives a bridge restart over real sockets',
    { timeout: 300_000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'cdx3d-bridge-home-'));
      const workspace = mkdtempSync(join(tmpdir(), 'cdx3d-workspace-'));
      cleanups.push(() => rmSync(home, { recursive: true, force: true }));
      cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
      const bridgeEnv = {
        CODEDECK_HOME: home,
        CODEDECK_RELAYS: RELAY_URL,
        CODEDECK_WORKSPACE_ROOTS: workspace,
        CODEDECK_MACHINE_NAME: 'realsocket-smoke',
      };

      // --- 1. `codedeck-bridge pair` prints a pairing URL over the real relay ---
      const pairProc = spawnBridge(['pair'], bridgeEnv);
      cleanups.push(() => pairProc.child.kill('SIGKILL'));
      await until(
        () => /Pairing URL: (codedeck:\/\/\S+)/.test(pairProc.stdout),
        30_000,
        'pairing URL in `pair` stdout',
      );
      const url = /Pairing URL: (codedeck:\/\/\S+)/.exec(pairProc.stdout)![1]!;

      // --- 2. production phone core + production relay transport ---
      const transport = createRelayTransport({ relays: [RELAY_URL] });
      const core: PhoneCore = await createPhoneCore({ kv: memoryKV(), transport });
      cleanups.push(() => void core.stop());
      core.start();

      const parsed = parsePairingUrl(url);
      if (!parsed.ok) throw new Error(`bad pairing URL: ${url}`);
      core.pairing.getState().beginPair(parsed.parts, 'realsocket-smoke-phone');
      await until(
        () => core.pairing.getState().phase === 'paired',
        30_000,
        'pairing phase → paired',
      );
      const machinePk = parsed.parts.pubkeyHex;
      expect((await pairProc.exited) ?? 0).toBe(0);

      // --- 3. `codedeck-bridge run`: heartbeat arrives, machine known ---
      let runProc = spawnBridge(['run'], bridgeEnv);
      cleanups.push(() => runProc.child.kill('SIGKILL'));
      await until(
        () => {
          const m = core.machines.getState().machine(machinePk);
          return m !== undefined && m.machineOffline !== true;
        },
        30_000,
        'first heartbeat from `run`',
      );

      // --- 4. create a session, stream real claude output into the transcript ---
      await core.api.createSession(machinePk);
      try {
        await until(
          () => Object.keys(core.machines.getState().machine(machinePk)?.sessions ?? {}).length > 0,
          60_000,
          'session appears in the session list',
        );
      } catch (err) {
        console.error('--- bridge `run` output ---\n' + runProc.stdout.slice(-4000));
        console.error('--- pendingSessions ---', JSON.stringify(core.pendingSessions.getState().pending));
        throw err;
      }
      const sessionId = Object.keys(core.machines.getState().machine(machinePk)!.sessions)[0]!;

      const outbox = await core.outbox
        .getState()
        .send(machinePk, sessionId, 'Reply with exactly the word: pong');
      await until(
        () =>
          core.transcript
            .getState()
            .entriesOf(machinePk, sessionId)
            .some(
              (e) =>
                e.entry.entryType === 'text' &&
                e.entry.metadata?.role !== 'user' &&
                e.entry.content.toLowerCase().includes('pong'),
            ),
        180_000,
        'assistant output containing "pong" in the transcript store',
      );
      // Outbox item confirmed by the bridge's input-ack echo.
      await until(
        () => core.outbox.getState().item(outbox.id)?.state === 'confirmed',
        30_000,
        'outbox item confirmed',
      );

      // --- 5. bridge restart: truthful offline publish, then reconnect + list survives ---
      const entriesBefore = core.transcript.getState().entriesOf(machinePk, sessionId).length;
      expect(entriesBefore).toBeGreaterThan(0);
      runProc.child.kill('SIGTERM');
      await runProc.exited;
      await until(
        () => core.machines.getState().machine(machinePk)?.machineOffline === true,
        30_000,
        'machineOffline after graceful shutdown publish',
      );
      // Absence never deletes: the session list still holds the session.
      expect(
        Object.keys(core.machines.getState().machine(machinePk)!.sessions),
      ).toContain(sessionId);

      runProc = spawnBridge(['run'], bridgeEnv);
      cleanups.push(() => runProc.child.kill('SIGKILL'));
      await until(
        () => core.machines.getState().machine(machinePk)?.machineOffline !== true,
        60_000,
        'machine live again after bridge restart',
      );
      // Transcript intact (nothing lost across the restart).
      expect(core.transcript.getState().entriesOf(machinePk, sessionId).length).toBeGreaterThanOrEqual(
        entriesBefore,
      );

      runProc.child.kill('SIGTERM');
      await runProc.exited;
    },
  );
});
