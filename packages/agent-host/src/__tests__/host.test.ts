/**
 * AgentHost routing, in-process, with the fake driver: request/reply
 * pairing, the ack-before-events ordering, requests the host sends to the
 * bridge, and session lifetimes.
 */
import { describe, it, expect } from 'vitest';
import { FakeDriver } from '../drivers/fake';
import { AgentHost, parseBridgeFrame } from '../host';

interface Frame {
  v: number;
  id?: string;
  kind: string;
  payload?: Record<string, unknown> & { event?: Record<string, unknown> };
}

function harness() {
  const out: Frame[] = [];
  const logs: string[] = [];
  const host = new AgentHost([new FakeDriver()], { write: (l) => out.push(JSON.parse(l) as Frame), log: (m) => logs.push(m) }, '9.9.9');
  let next = 0;
  const send = (kind: string, payload: Record<string, unknown>, id: string | undefined = `b${++next}`) =>
    host.handleLine(JSON.stringify({ v: 1, ...(id ? { id } : {}), kind, payload }));
  const reply = (id: string) => out.find((f) => f.id === id && !['request-permission', 'ask-question', 'request-plan-approval', 'call-host-tool'].includes(f.kind));
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

  it('questions, plan approval and host tools round-trip the same way', async () => {
    const h = harness();
    await h.send('start-session', { sessionId: 's1', agent: 'fake', cwd: '/w' });
    await h.send('prompt', { sessionId: 's1', text: 'question' });
    await h.until(() => h.out.some((f) => f.kind === 'ask-question'));
    await h.send('question-outcome', { outcome: 'answered', answers: ['Blue'] }, h.out.find((f) => f.kind === 'ask-question')!.id);
    await h.until(() => h.texts().length === 1);

    await h.send('prompt', { sessionId: 's1', text: 'plan' });
    await h.until(() => h.out.some((f) => f.kind === 'request-plan-approval'));
    await h.send('plan-outcome', { outcome: 'selected', optionId: 'auto' }, h.out.find((f) => f.kind === 'request-plan-approval')!.id);
    await h.until(() => h.texts().length === 2);

    await h.send('prompt', { sessionId: 's1', text: 'tool list {"serial":"x"}' });
    await h.until(() => h.out.some((f) => f.kind === 'call-host-tool'));
    const call = h.out.find((f) => f.kind === 'call-host-tool')!;
    expect(call.payload).toEqual({ sessionId: 's1', tool: 'list', args: { serial: 'x' } });
    await h.send('host-tool-result', { text: 'no devices', isError: true }, call.id);
    await h.until(() => h.texts().length === 3);

    expect(h.texts()).toEqual(['answer: Blue', 'plan: auto', 'tool list: error: no devices']);
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

  it('a lost resume target ends the session at once, saying so', async () => {
    const h = harness();
    await h.send('start-session', { sessionId: 's1', agent: 'fake', cwd: '/w', resume: 'lost' });
    await h.until(() => h.events().length > 0);
    expect(h.events()).toEqual([{ type: 'ended', error: 'the conversation to resume is gone', resumeLost: true }]);
  });

  it('options, models, usage and credential checks reply with their own kinds', async () => {
    const h = harness();
    await h.send('start-session', { sessionId: 's1', agent: 'fake', cwd: '/w' });
    await h.send('set-option', { sessionId: 's1', option: 'mode', value: 'plan' }, 'o1');
    await h.send('set-option', { sessionId: 's1', option: 'model', value: 'invalid' }, 'o2');
    await h.send('list-models', { agent: 'fake' }, 'm');
    await h.send('get-usage', { sessionId: 's1' }, 'u');
    await h.send('check-credential', { agent: 'fake', credential: 'fake_token', value: 'invalid' }, 'c1');
    await h.send('check-credential', { agent: 'fake', credential: 'fake_token', value: 'unknown' }, 'c2');
    expect(h.reply('o1')).toMatchObject({ kind: 'ack' });
    expect(h.reply('o2')).toMatchObject({ kind: 'error' });
    expect(h.reply('m')).toMatchObject({ kind: 'models', payload: { defaultModel: 'fake-model', models: [{ id: 'fake-model' }, { id: 'fake-large' }] } });
    expect(h.reply('u')).toMatchObject({ kind: 'usage', payload: { usage: { available: true } } });
    expect(h.reply('c1')).toEqual({ v: 1, id: 'c1', kind: 'credential-checked', payload: { valid: false } });
    expect(h.reply('c2')).toEqual({ v: 1, id: 'c2', kind: 'credential-checked', payload: {} });
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
