import { describe, expect, it } from 'vitest';

import { Bridge, type BridgeState, type Command } from '../bridge.js';

/**
 * Stand-ins for `codedeck-bridge run`, as a Node script. They reproduce what
 * the real binary does that the extension reads: start-up log lines on
 * stderr, the banner on stdout only once the home's lock is held, and on an
 * error one `error: …` line on stderr and exit code 1 (main.rs `fail`), the
 * lock's being "a bridge is already running on <home>…" (state.rs).
 */
const fake = (script: string): Command => ({ command: process.execPath, args: ['-e', script] });

const SERVES = fake(`
  console.error('[INFO] loading config');
  setTimeout(() => console.log('codedeck-bridge 1.4.0'), 50);
  setInterval(() => {}, 1000);
`);
const LOCKED = fake(`
  console.error('error: a bridge is already running on /home/me/.codedeck (pid 4242). Stop it first, or use a different --home.');
  process.exit(1);
`);
const FAILS = fake(`
  console.error('[INFO] loading config');
  console.error('error: the agent host bundle is missing at /x/main.js');
  process.exit(1);
`);

function watch(): { bridge: Bridge; states: BridgeState['kind'][]; lines: string[]; until: (kind: BridgeState['kind']) => Promise<BridgeState> } {
  const states: BridgeState['kind'][] = [];
  const lines: string[] = [];
  const waiters: [BridgeState['kind'], (s: BridgeState) => void][] = [];
  const bridge = new Bridge(
    (state) => {
      states.push(state.kind);
      for (const [kind, resolve] of waiters) if (kind === state.kind) resolve(state);
    },
    (line) => lines.push(line),
  );
  const until = (kind: BridgeState['kind']): Promise<BridgeState> =>
    bridge.state.kind === kind ? Promise.resolve(bridge.state) : new Promise((resolve) => waiters.push([kind, resolve]));
  return { bridge, states, lines, until };
}

describe('Bridge', () => {
  it('is running once the banner is out, and stopped after stop()', async () => {
    const { bridge, states, lines, until } = watch();
    bridge.start(SERVES);
    const running = await until('running');
    expect(running.kind === 'running' && running.pid).toBeGreaterThan(0);
    expect(lines).toEqual(['[INFO] loading config', 'codedeck-bridge 1.4.0']);
    await bridge.stop();
    expect(states).toEqual(['starting', 'running', 'stopped']);
  });

  it('starts once while one runs', async () => {
    const { bridge, states, until } = watch();
    bridge.start(SERVES);
    bridge.start(SERVES);
    await until('running');
    await bridge.stop();
    expect(states).toEqual(['starting', 'running', 'stopped']);
  });

  it('tells a home another bridge holds from a failure', async () => {
    const locked = watch();
    locked.bridge.start(LOCKED);
    expect(await locked.until('elsewhere')).toEqual({ kind: 'elsewhere' });
    expect(locked.states).toEqual(['starting', 'elsewhere']);

    const failed = watch();
    failed.bridge.start(FAILS);
    expect(await failed.until('failed')).toEqual({
      kind: 'failed',
      message: 'error: the agent host bundle is missing at /x/main.js',
    });
  });

  it('reports a binary that cannot be run', async () => {
    const { bridge, until } = watch();
    bridge.start({ command: '/nonexistent/codedeck-bridge', args: ['run'] });
    const failed = await until('failed');
    expect(failed.kind === 'failed' && failed.message).toMatch(/cannot run \/nonexistent\/codedeck-bridge/);
  });
});
