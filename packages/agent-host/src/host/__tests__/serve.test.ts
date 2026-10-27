/**
 * What main.ts composes: the host's stdio and the host itself. Two
 * invariants the bridge depends on — nothing but a protocol frame may reach
 * stdout (whatever a driver logs is on stderr), and a line the host cannot
 * parse is logged and dropped rather than ending the process.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import pkg from '../../../package.json';
import { DRIVER_PROTOCOL_VERSION } from '../../sdk/types';
import { startHost, wire } from '../serve';

const METHODS = ['log', 'info', 'debug', 'warn'] as const;
/** The console as it was before a test replaced it. */
const ORIGINAL = METHODS.map((method) => (console as unknown as Record<string, unknown>)[method]);
const dirs: string[] = [];

afterEach(() => {
  METHODS.forEach((method, index) => {
    (console as unknown as Record<string, unknown>)[method] = ORIGINAL[index];
  });
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A stream that keeps what was written to it. */
function sink() {
  const chunks: string[] = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, done) {
        chunks.push(String(chunk));
        done();
      },
    }),
    text: () => chunks.join(''),
  };
}

/** A scratch agent cache, so loading the fake driver touches nothing real. */
function cacheDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-serve-'));
  dirs.push(dir);
  return dir;
}

describe('the host process wiring', () => {
  it('sends a driver console.log to stderr, never onto the protocol stream', () => {
    const out = sink();
    const err = sink();
    const io = wire({ out: out.stream, err: err.stream });

    // What an SDK or a driver does when it has something to say. On stdout
    // this would be a line the bridge tries to parse as a frame.
    console.log('driver chatter', 42);
    console.info('more chatter');
    io.write('{"v":1,"kind":"ack"}');

    expect(out.text()).toBe('{"v":1,"kind":"ack"}\n');
    expect(err.text()).toBe('driver chatter 42\nmore chatter\n');
  });

  it('drops a line it cannot parse with a log, and keeps serving', async () => {
    const out = sink();
    const err = sink();
    const host = await startHost(wire({ out: out.stream, err: err.stream }), {
      CODEDECK_AGENT_HOST_DRIVERS: 'fake',
      CODEDECK_AGENT_CACHE: cacheDir(),
    });
    try {
      // Not JSON at all: nothing may be answered with a frame, and the host
      // must still answer the request that follows it.
      await host.handleLine('{ this is not a frame');
      expect(out.text()).toBe('');
      expect(err.text()).toContain('[agent-host] dropped frame: malformed frame:');

      await host.handleLine(
        JSON.stringify({ v: DRIVER_PROTOCOL_VERSION, id: 'b1', kind: 'initialize', payload: { bridgeVersion: '12.0.0' } }),
      );
      const frames = out
        .text()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({
        v: DRIVER_PROTOCOL_VERSION,
        id: 'b1',
        kind: 'initialized',
        payload: { hostVersion: pkg.version, agents: [{ id: 'fake' }] },
      });
    } finally {
      await host.shutdown();
    }
  });
});
