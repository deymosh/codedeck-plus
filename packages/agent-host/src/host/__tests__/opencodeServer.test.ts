/**
 * OpenCode's own server, as the host sees it. These go through
 * `AgentHost` on purpose: the host refuses a start-session while the driver
 * reports an `unavailableReason`, so a driver that marks a crashed or
 * unstartable server unavailable is never asked to start a new one.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeDriver } from '../../drivers/opencode/driver';
import { fakeOpenCode, type FakeOpenCodeServer } from '../../drivers/opencode/__tests__/fakeServer';
import { Agents } from '../agents';
import { AgentHost } from '../host';

/** A stock 2.1.4 server with one usable provider and its model, as the
 *  driver's catalog reads them. The stream stays open, so a session outlives
 *  the test's start until the fake server is lost. */
function fakeServer(): FakeOpenCodeServer {
  return fakeOpenCode({
    holdStream: true,
    providers: [
      {
        info: { id: 'opencode', name: 'OpenCode', activation: 'enabled', package: '@opencode/ai/providers/openai-compatible' },
        models: [
          {
            id: 'cat-jam-free',
            modelID: 'cat-jam-free',
            providerID: 'opencode',
            name: 'cat-jam-free',
            enabled: true,
            status: 'active',
            cost: [],
            variants: [],
            limit: { context: 0, output: 0 },
            capabilities: { tools: true, input: ['text'], output: ['text'] },
          } as never,
        ],
      },
    ],
  });
}

/** An AgentHost over one driver, with a reader for its session events. */
function hostFor(driver: OpenCodeDriver) {
  const out: Array<Record<string, unknown>> = [];
  const host = new AgentHost(Agents.of([driver]), {
    write: (line) => out.push(JSON.parse(line) as Record<string, unknown>),
    log: () => {},
  }, '9.9.9');
  const send = (id: string, kind: string, payload: Record<string, unknown>) =>
    host.handleLine(JSON.stringify({ v: 1, id, kind, payload }));
  const events = (sessionId: string): Array<Record<string, unknown>> => out
    .filter((frame) => frame.kind === 'session-event' && (frame.payload as { sessionId?: string } | undefined)?.sessionId === sessionId)
    .map((frame) => (frame.payload as { event?: Record<string, unknown> }).event ?? {});
  return { out, send, events };
}

describe('an OpenCode server the host starts', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is started again after it crashed, and its exit is not reported as unavailable', async () => {
    vi.stubEnv('XDG_DATA_HOME', mkdtempSync(path.join(tmpdir(), 'oc-data-')));
    const server = fakeServer();
    const exits: Array<() => void> = [];
    let starts = 0;
    const driver = await OpenCodeDriver.create({
      autoStart: true,
      binaryPath: process.execPath,
      log: () => {},
      modelsRefreshWaitMs: 0,
      startServer: async () => {
        starts++;
        const exited = new Promise<void>((resolve) => exits.push(resolve));
        return { url: 'http://127.0.0.1:4100', pid: 1, exited, close: async () => {} };
      },
      connect: () => server.client,
    });
    const { out, send, events } = hostFor(driver);
    await send('st1', 'start-session', { sessionId: 's1', agent: 'opencode', cwd: '/tmp' });
    expect(out.find((frame) => frame.id === 'st1')).toMatchObject({ kind: 'ack' });
    await vi.waitFor(() => expect(events('s1').some((event) => event.type === 'ready')).toBe(true));
    expect(starts).toBe(1);

    exits[0]!();
    await vi.waitFor(() => expect(events('s1').some((event) => event.type === 'ended')).toBe(true));
    expect(events('s1').find((event) => event.type === 'ended')).toMatchObject({
      error: expect.stringMatching(/server exited/i),
    });
    // The host refuses start-session while this is set, which would make the
    // relaunch below impossible.
    expect(driver.info().unavailableReason).toBeUndefined();

    // The dead server's client is not reused: the next session starts a new one.
    await send('st2', 'start-session', { sessionId: 's2', agent: 'opencode', cwd: '/tmp' });
    expect(out.find((frame) => frame.id === 'st2')).toMatchObject({ kind: 'ack' });
    await vi.waitFor(() => expect(events('s2').some((event) => event.type === 'ready')).toBe(true));
    expect(starts).toBe(2);
  });

  it('is started again on the next session after its first start failed', async () => {
    vi.stubEnv('XDG_DATA_HOME', mkdtempSync(path.join(tmpdir(), 'oc-data-')));
    const server = fakeServer();
    let starts = 0;
    const driver = await OpenCodeDriver.create({
      autoStart: true,
      binaryPath: process.execPath,
      log: () => {},
      modelsRefreshWaitMs: 0,
      startServer: async () => {
        starts++;
        if (starts === 1) throw new Error('port 4100 is in use');
        return { url: 'http://127.0.0.1:4100', pid: 1, exited: new Promise(() => {}), close: async () => {} };
      },
      connect: () => server.client,
    });
    // A failed first start is retried, not refused for the host's lifetime.
    expect(driver.info().unavailableReason).toBeUndefined();

    const { out, send, events } = hostFor(driver);
    await send('st1', 'start-session', { sessionId: 's1', agent: 'opencode', cwd: '/tmp' });
    expect(out.find((frame) => frame.id === 'st1')).toMatchObject({ kind: 'ack' });
    await vi.waitFor(() => expect(events('s1').some((event) => event.type === 'ready')).toBe(true));
    expect(starts).toBe(2);
  });
});
