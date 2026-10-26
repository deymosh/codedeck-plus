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
import type { OpenCodeClient } from '@opencode/client';
import { OpenCodeDriver } from '../../drivers/opencode/driver';
import { Agents } from '../agents';
import { AgentHost } from '../host';

/** The v2 client calls a session makes as it starts, answered from one
 *  scripted room. Only what a default (no persona, no resume) start touches
 *  is here. */
function fakeClient(stream: () => AsyncGenerator<Record<string, unknown>>): OpenCodeClient {
  const session = () => ({
    id: 'ses_1',
    projectID: 'p',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    location: { directory: '/tmp' },
  });
  return {
    event: { subscribe: vi.fn(stream) },
    session: {
      create: vi.fn(async () => session()),
      get: vi.fn(async () => session()),
      remove: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      switchAgent: vi.fn(async () => undefined),
      switchModel: vi.fn(async () => undefined),
      interrupt: vi.fn(async () => undefined),
      prompt: vi.fn(async () => ({})),
      command: vi.fn(async () => undefined),
      compact: vi.fn(async () => ({})),
      diff: vi.fn(async () => []),
      revert: { stage: vi.fn(async () => ({})), clear: vi.fn(async () => undefined), commit: vi.fn(async () => undefined) },
      form: { reply: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) },
    },
    shell: { list: vi.fn(async () => ({ location: { directory: '/tmp' }, data: [] })) },
    permission: { reply: vi.fn(async () => undefined) },
    agent: {
      get: vi.fn(async ({ agentID }: { agentID: string }) => ({
        location: { directory: '/tmp' },
        data: { id: agentID, name: agentID, mode: 'primary', hidden: false, request: {}, permissions: [] },
      })),
      list: vi.fn(async () => ({
        location: { directory: '/tmp' },
        data: [
          { id: 'build', name: 'Build', mode: 'primary', hidden: false, request: {}, permissions: [] },
          { id: 'plan', name: 'Plan', mode: 'primary', hidden: false, request: {}, permissions: [] },
        ],
      })),
    },
    location: { get: vi.fn(async () => ({ directory: '/tmp' })) },
    message: { list: vi.fn(async () => ({ data: [], cursor: {} })) },
    command: { list: vi.fn(async () => ({ location: { directory: '/tmp' }, data: [] })) },
    mcp: { list: vi.fn(async () => ({ location: { directory: '/tmp' }, data: [] })) },
    provider: { list: vi.fn(async () => ({ location: { directory: '/tmp' }, data: [] })) },
    model: {
      list: vi.fn(async () => ({
        location: { directory: '/tmp' },
        data: [{ providerID: 'opencode', modelID: 'cat-jam-free', name: 'cat-jam-free', enabled: true, status: 'active' }],
      })),
      default: vi.fn(async () => ({ location: { directory: '/tmp' }, data: null })),
    },
    plugin: { list: vi.fn(async () => ({ location: { directory: '/tmp' }, data: [] })) },
    server: { info: vi.fn(async () => ({ version: '2.0.28' })) },
  } as unknown as OpenCodeClient;
}

/** The stream a session reads until the test ends it. */
async function* openStream(): AsyncGenerator<Record<string, unknown>> {
  await new Promise(() => {});
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
      connect: () => fakeClient(openStream),
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
      connect: () => fakeClient(openStream),
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
