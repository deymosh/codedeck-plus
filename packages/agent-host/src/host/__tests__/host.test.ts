/**
 * AgentHost routing, in-process, with the fake driver: request/reply
 * pairing, the ack-before-events ordering, requests the host sends to the
 * bridge, and session lifetimes.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import type { Driver } from '../../sdk/driver';
import type { DriverModule } from '../../sdk/module';
import { FakeDriver } from '../../drivers/fake/driver';
import { Agents } from '../agents';
import { AgentHost, parseBridgeFrame } from '../host';
import type { AgentInfo } from '../../sdk/types';

interface Frame {
  v: number;
  id?: string;
  kind: string;
  payload?: Record<string, unknown> & { event?: Record<string, unknown> };
}

function harness() {
  const out: Frame[] = [];
  const logs: string[] = [];
  const host = new AgentHost(Agents.of([new FakeDriver()]), { write: (l) => out.push(JSON.parse(l) as Frame), log: (m) => logs.push(m) }, '9.9.9');
  let next = 0;
  const send = (kind: string, payload: Record<string, unknown>, id: string | undefined = `b${++next}`) =>
    host.handleLine(JSON.stringify({ v: 1, ...(id ? { id } : {}), kind, payload }));
  const reply = (id: string) => out.find((f) => f.id === id && !['request-permission', 'ask-question', 'request-plan-approval'].includes(f.kind));
  const events = (sessionId = 's1') =>
    out.filter((f) => f.kind === 'session-event' && f.payload?.sessionId === sessionId).map((f) => f.payload!.event!);
  const until = async (pred: () => boolean, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const texts = (sessionId = 's1') =>
    events(sessionId).flatMap((e) => (e.type === 'entries' ? (e.entries as Array<{ entryType: string; text?: string }>) : []))
      .filter((e) => e.entryType === 'text').map((e) => e.text);
  return { host, out, logs, send, reply, events, until, texts };
}

describe('AgentHost', () => {
  it('initialize answers with the host version and every driver', async () => {
    const h = harness();
    await h.send('initialize', { bridgeVersion: '11.0.0' }, 'i1');
    expect(h.reply('i1')).toMatchObject({ v: 1, id: 'i1', kind: 'initialized', payload: { hostVersion: '9.9.9', agents: [{ id: 'fake' }] } });
  });

  it('start-session is acknowledged before the session reports anything', async () => {
    const h = harness();
    await h.send('start-session', { sessionId: 's1', agent: 'fake', cwd: '/w' }, 'st');
    const ackAt = h.out.findIndex((f) => f.id === 'st');
    expect(h.out[ackAt]).toEqual({ v: 1, id: 'st', kind: 'ack' });
    const firstEvent = h.out.findIndex((f) => f.kind === 'session-event');
    expect(firstEvent).toBeGreaterThan(ackAt);
    expect(h.events().map((e) => e.type)).toEqual(['info', 'ready']);
  });

  it('refuses an unknown agent, a duplicate session and requests for no session', async () => {
    const h = harness();
    await h.send('start-session', { sessionId: 's1', agent: 'pi', cwd: '/w' }, 'a');
    expect(h.reply('a')).toMatchObject({ kind: 'error', payload: { message: "no agent 'pi' in this host" } });
    await h.send('start-session', { sessionId: 's1', agent: 'fake', cwd: '/w' }, 'b');
    await h.send('start-session', { sessionId: 's1', agent: 'fake', cwd: '/w' }, 'c');
    expect(h.reply('c')).toMatchObject({ kind: 'error', payload: { message: expect.stringMatching(/already running/) } });
    await h.send('prompt', { sessionId: 'nope', text: 'hi' }, 'd');
    expect(h.reply('d')).toMatchObject({ kind: 'error', payload: { message: 'no running session nope' } });
    await h.send('start-session', { sessionId: 's2', agent: 'fake', cwd: '' }, 'e');
    expect(h.reply('e')).toMatchObject({ kind: 'error' });
  });

  it('a prompt runs a turn', async () => {
    const h = harness();
    await h.send('start-session', { sessionId: 's1', agent: 'fake', cwd: '/w' });
    await h.send('prompt', { sessionId: 's1', text: 'hello' }, 'p');
    expect(h.reply('p')).toMatchObject({ kind: 'ack' });
    await h.until(() => h.events().some((e) => e.type === 'turn' && e.state === 'idle'));
    expect(h.texts()).toEqual(['echo: hello']);
  });

  it('a permission request goes to the bridge and its reply reaches the driver', async () => {
    const h = harness();
    await h.send('start-session', { sessionId: 's1', agent: 'fake', cwd: '/w' });
    await h.send('prompt', { sessionId: 's1', text: 'permission rm -rf build' });
    await h.until(() => h.out.some((f) => f.kind === 'request-permission'));
    const req = h.out.find((f) => f.kind === 'request-permission')!;
    expect(req.payload).toMatchObject({ sessionId: 's1', requestId: 'perm-1', title: 'rm -rf build', kind: 'execute' });
    await h.send('permission-outcome', { outcome: 'selected', optionId: 'allow' }, req.id);
    await h.until(() => h.texts().length > 0);
    expect(h.texts()).toEqual(['permission: allow']);
  });

  it('questions and plan approval round-trip the same way', async () => {
    const h = harness();
    await h.send('start-session', { sessionId: 's1', agent: 'fake', cwd: '/w' });
    await h.send('prompt', { sessionId: 's1', text: 'question' });
    await h.until(() => h.out.some((f) => f.kind === 'ask-question'));
    await h.send('question-outcome', { outcome: 'answered', answers: [{ type: 'selected', labels: ['Blue'] }] }, h.out.find((f) => f.kind === 'ask-question')!.id);
    await h.until(() => h.texts().length === 1);

    await h.send('prompt', { sessionId: 's1', text: 'plan' });
    await h.until(() => h.out.some((f) => f.kind === 'request-plan-approval'));
    await h.send('plan-outcome', { outcome: 'selected', optionId: 'auto' }, h.out.find((f) => f.kind === 'request-plan-approval')!.id);
    await h.until(() => h.texts().length === 2);

    expect(h.texts()).toEqual(['answer: Blue', 'plan: auto']);
    expect(h.events()).toContainEqual({ type: 'info', mode: 'auto' });
  });

  it('ended forgets the session; end-session silences it', async () => {
    const h = harness();
    await h.send('start-session', { sessionId: 's1', agent: 'fake', cwd: '/w' });
    await h.send('prompt', { sessionId: 's1', text: 'crash' });
    await h.until(() => h.events().some((e) => e.type === 'ended'));
    expect(h.events().at(-1)).toEqual({ type: 'ended', error: 'fake crash' });
    await h.send('prompt', { sessionId: 's1', text: 'again' }, 'x');
    expect(h.reply('x')).toMatchObject({ kind: 'error' });

    await h.send('start-session', { sessionId: 's2', agent: 'fake', cwd: '/w' });
    await h.send('end-session', { sessionId: 's2' }, 'e');
    expect(h.reply('e')).toMatchObject({ kind: 'ack' });
    const before = h.events('s2').length;
    await h.send('prompt', { sessionId: 's2', text: 'hi' }, 'y');
    expect(h.reply('y')).toMatchObject({ kind: 'error' });
    expect(h.events('s2')).toHaveLength(before);
    // Ending an unknown session is not an error: the bridge may race an `ended`.
    await h.send('end-session', { sessionId: 'gone' }, 'z');
    expect(h.reply('z')).toMatchObject({ kind: 'ack' });
  });

  it('deleting a conversation waits for its session to finish ending', async () => {
    const log: string[] = [];
    let release!: () => void;
    const stopped = new Promise<void>((r) => (release = r));
    const driver: Driver = {
      info: () => ({ id: 'slow', displayName: 'Slow', modes: [], efforts: [], supports: {} as AgentInfo['supports'], credentials: [] }),
      startSession: () => ({
        prompt: () => {},
        interrupt: async () => {},
        setOption: async () => {},
        getUsage: async () => null,
        end: async () => {
          await stopped;
          log.push('ended');
        },
      }),
      listModels: async () => ({ models: [] }),
      deleteConversation: async (id, cwd) => {
        log.push(`deleted ${id} in ${cwd}`);
      },
    };
    const out: Frame[] = [];
    const host = new AgentHost(Agents.of([driver]), { write: (l) => out.push(JSON.parse(l) as Frame), log: () => {} }, '9.9.9');
    const send = (id: string, kind: string, payload: Record<string, unknown>) =>
      host.handleLine(JSON.stringify({ v: 1, id, kind, payload }));
    await send('st', 'start-session', { sessionId: 's1', agent: 'slow', cwd: '/w' });

    // A delete while the session runs is refused: the agent still writes.
    await send('d0', 'delete-conversation', { sessionId: 's1', agent: 'slow', cwd: '/w', conversationId: 'n1' });
    expect(out.find((f) => f.id === 'd0')).toMatchObject({ kind: 'error', payload: { message: 'session s1 is still running' } });

    // Handled concurrently, as main.ts does: the delete waits for the end.
    const ending = send('e', 'end-session', { sessionId: 's1' });
    const deleting = send('d1', 'delete-conversation', { sessionId: 's1', agent: 'slow', cwd: '/w', conversationId: 'n1' });
    await new Promise((r) => setTimeout(r, 10));
    expect(log).toEqual([]);
    release();
    await Promise.all([ending, deleting]);
    expect(log).toEqual(['ended', 'deleted n1 in /w']);
    expect(out.find((f) => f.id === 'd1')).toEqual({ v: 1, id: 'd1', kind: 'ack' });
  });

  it('deleting a conversation of an agent that keeps none is acknowledged', async () => {
    const h = harness();
    await h.send('delete-conversation', { sessionId: 's1', agent: 'fake', cwd: '/w', conversationId: 'n1' }, 'd');
    expect(h.reply('d')).toMatchObject({ kind: 'ack' });
  });

  it('a lost resume target ends the session at once, saying so', async () => {
    const h = harness();
    await h.send('start-session', { sessionId: 's1', agent: 'fake', cwd: '/w', resume: 'lost' });
    await h.until(() => h.events().length > 0);
    expect(h.events()).toEqual([{ type: 'ended', error: 'the conversation to resume is gone', resumeLost: true }]);
  });

  it('options, models, usage, commands and credential checks reply with their own kinds', async () => {
    const h = harness();
    await h.send('start-session', { sessionId: 's1', agent: 'fake', cwd: '/w' });
    await h.send('set-option', { sessionId: 's1', option: 'mode', value: 'plan' }, 'o1');
    await h.send('set-option', { sessionId: 's1', option: 'model', value: 'invalid' }, 'o2');
    await h.send('list-models', { agent: 'fake' }, 'm');
    await h.send('get-usage', { sessionId: 's1' }, 'u');
    await h.send('list-commands', { sessionId: 's1' }, 'l');
    await h.send('check-credential', { agent: 'fake', credential: 'fake_token', value: 'invalid' }, 'c1');
    await h.send('check-credential', { agent: 'fake', credential: 'fake_token', value: 'unknown' }, 'c2');
    expect(h.reply('o1')).toMatchObject({ kind: 'ack' });
    expect(h.reply('o2')).toMatchObject({ kind: 'error' });
    expect(h.reply('m')).toMatchObject({ kind: 'models', payload: { defaultModel: 'fake-model', models: [{ id: 'fake-model' }, { id: 'fake-large' }] } });
    expect(h.reply('u')).toMatchObject({ kind: 'usage', payload: { usage: { available: true } } });
    expect(h.reply('l')).toMatchObject({ kind: 'commands', payload: { commands: [{ name: 'permission', argumentHint: '<title>' }, { name: 'question' }, { name: 'plan' }] } });
    expect(h.reply('c1')).toEqual({ v: 1, id: 'c1', kind: 'credential-checked', payload: { valid: false } });
    expect(h.reply('c2')).toEqual({ v: 1, id: 'c2', kind: 'credential-checked', payload: {} });
  });

  it("plugins are listed and changed through the agent's driver", async () => {
    const h = harness();
    await h.send('list-plugins', { agent: 'fake', available: true }, 'p1');
    await h.send('plugin-action', { agent: 'fake', action: 'install', target: 'echo@fake' }, 'p2');
    await h.send('plugin-action', { agent: 'fake', action: 'install', target: 'nope@fake' }, 'p3');
    expect(h.reply('p1')).toMatchObject({ kind: 'plugins', payload: { installed: [], available: [{ id: 'echo@fake' }] } });
    expect(h.reply('p2')).toMatchObject({ kind: 'plugins', payload: { installed: [{ id: 'echo@fake', enabled: true }] } });
    expect(h.reply('p2')!.payload).not.toHaveProperty('available');
    expect(h.reply('p3')).toMatchObject({ kind: 'error', payload: { message: expect.stringMatching(/not found/) } });
  });

  it("MCP servers are managed through the agent's driver and switched in a session", async () => {
    const h = harness();
    await h.send('mcp-action', { agent: 'fake', action: 'add', servers: [
      { name: 'gh', setup: { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer secret' } } },
    ] }, 'm1');
    await h.send('list-mcp', { agent: 'fake' }, 'm2');
    expect(h.reply('m1')).toMatchObject({ kind: 'mcp-servers', payload: { servers: [{ name: 'gh', headerKeys: ['Authorization'] }] } });
    expect(JSON.stringify(h.reply('m2'))).not.toContain('secret');

    await h.send('start-session', { sessionId: 's1', agent: 'fake', cwd: '/w' });
    await h.send('session-mcp-toggle', { sessionId: 's1', name: 'gh', enabled: false }, 'm3');
    await h.send('session-mcp-toggle', { sessionId: 's1', name: 'nope', enabled: false }, 'm4');
    expect(h.reply('m3')).toMatchObject({ kind: 'session-mcp', payload: { servers: [{ name: 'gh', status: 'disabled' }] } });
    expect(h.reply('m4')).toMatchObject({ kind: 'error' });
  });

  it('shutdown cancels what the host is still waiting on', async () => {
    const h = harness();
    await h.send('start-session', { sessionId: 's1', agent: 'fake', cwd: '/w' });
    await h.send('prompt', { sessionId: 's1', text: 'permission' });
    await h.until(() => h.out.some((f) => f.kind === 'request-permission'));
    await h.host.shutdown();
    // The driver saw a cancellation, but the session was closed first, so
    // nothing more reaches the bridge.
    expect(h.texts()).toEqual([]);
  });

  it('removes and installs an agent, telling the bridge before its sessions end', async () => {
    let pinned = true;
    const module: DriverModule = {
      id: 'fake',
      label: 'Fake agent',
      create: () => new FakeDriver(),
      runtime: {
        find: () => null,
        installed: () => (pinned ? '/cache/fake' : null),
        install: async () => {
          pinned = true;
          return '/cache/fake';
        },
        remove: () => {
          pinned = false;
        },
      },
    };
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-agents-'));
    try {
      const agents = await Agents.load([module], { env: {}, lookupEnv: {}, cacheDir, registry: '', log: () => {} });
      const out: Frame[] = [];
      const host = new AgentHost(agents, { write: (l) => out.push(JSON.parse(l) as Frame), log: () => {} }, '9.9.9');
      const send = (id: string, kind: string, payload: Record<string, unknown>) =>
        host.handleLine(JSON.stringify({ v: 1, id, kind, payload }));
      await send('st', 'start-session', { sessionId: 's1', agent: 'fake', cwd: '/w' });

      await send('rm', 'remove-agent', { agent: 'fake' });
      const kinds = out.map((f) => (f.kind === 'session-event' ? `${f.kind}:${String(f.payload?.event?.type)}` : f.kind));
      expect(kinds.slice(kinds.indexOf('agent-changed'))).toEqual(['agent-changed', 'session-event:ended', 'ack']);
      expect(out.find((f) => f.kind === 'session-event' && f.payload?.event?.type === 'ended')?.payload?.event).toEqual({
        type: 'ended',
        error: 'Fake agent was removed from this machine.',
      });
      expect(pinned).toBe(false);

      await send('st2', 'start-session', { sessionId: 's2', agent: 'fake', cwd: '/w' });
      expect(out.find((f) => f.id === 'st2')).toMatchObject({ kind: 'error', payload: { message: 'Fake agent is not installed on this machine' } });

      out.length = 0;
      await send('in', 'install-agent', { agent: 'fake' });
      expect(out[0]).toMatchObject({ kind: 'agent-changed', payload: { agent: { id: 'fake', install: { state: 'installing' } } } });
      expect(out[1]).toEqual({ v: 1, id: 'in', kind: 'ack' });
      await new Promise((r) => setTimeout(r, 10));
      expect(out[2]).toMatchObject({ kind: 'agent-changed', payload: { agent: { displayName: 'Fake agent', install: { state: 'ready', removable: true } } } });
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('malformed frames, other versions and stray replies are logged and dropped', async () => {
    const h = harness();
    await h.host.handleLine('not json');
    await h.host.handleLine(JSON.stringify({ v: 2, id: 'x', kind: 'initialize', payload: {} }));
    await h.host.handleLine(JSON.stringify({ v: 1, id: 'x', kind: 'initialize' }));
    await h.send('permission-outcome', { outcome: 'selected', optionId: 'allow' }, 'h99');
    await h.host.handleLine(JSON.stringify({ v: 1, kind: 'initialize', payload: { bridgeVersion: '1' } }));
    expect(h.out).toEqual([]);
    expect(h.logs).toHaveLength(5);
    expect(parseBridgeFrame('[]')).toMatch(/not an object/);
  });
});
