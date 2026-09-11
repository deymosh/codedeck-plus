/**
 * Process entry point (F2b plan §4 Capa 2): starts one harness world and
 * drives it from stdin/stdout JSON lines. See `README.md` for the protocol.
 *
 * The first line on stdout is always `{"type":"ready",...}` — a driver must
 * wait for it before sending commands (the relay socket isn't listening
 * until then).
 */
import { createInterface } from 'node:readline';
import { createHarness } from './harness';
import { handleCommand, errorResponse, type HarnessCommand } from './control';

function portFromArgv(): number {
  const arg = process.argv.find((a) => a.startsWith('--port='));
  return arg ? Number(arg.slice('--port='.length)) : 0;
}

async function main(): Promise<void> {
  const harness = await createHarness({ port: portFromArgv() });

  process.stdout.write(
    `${JSON.stringify({ type: 'ready', wsUrl: harness.relayServer.url, pid: process.pid })}\n`,
  );

  const rl = createInterface({ input: process.stdin, terminal: false });
  let closing = false;

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    void (async () => {
      let req: HarnessCommand;
      try {
        req = JSON.parse(trimmed) as HarnessCommand;
      } catch (err) {
        process.stdout.write(`${JSON.stringify(errorResponse('unknown', err))}\n`);
        return;
      }
      const res = await handleCommand(harness, req);
      process.stdout.write(`${JSON.stringify(res)}\n`);
      if (req.cmd === 'shutdown' && !closing) {
        closing = true;
        rl.close();
      }
    })();
  });

  rl.on('close', () => {
    process.exit(0);
  });

  // A dropped stdin (the driver process died) is the same signal as an
  // explicit shutdown command — never leave an orphaned harness running.
  process.stdin.on('end', () => {
    if (!closing) {
      closing = true;
      void harness.shutdown().finally(() => process.exit(0));
    }
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
