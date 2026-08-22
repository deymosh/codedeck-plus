/**
 * SessionRunner: two-phase pending/ready creation, creation-failure path,
 * transcript append + seqHigh, resume-on-boot, and steering (input routing,
 * questions, keypresses, mode/effort/model, interrupt).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FakeSdkFacade, FakeSdkSession } from '@codedeck/testkit';
import type { OutputEntry, PermissionMode } from '@codedeck/protocol';
import { TranscriptStore } from '../session/transcript';
import { SessionRegistry, type SessionRecord } from '../session/registry';
import { PermissionBroker, type PermissionCard } from '../session/permissions';
import {
  SessionRunner,
  isSlashCommand,
  type SeqEntry,
  type SessionRunnerEvents,
  type SessionRunnerOptions,
} from '../session/runner';
import type { SdkMessage, SdkPermissionResult } from '../sdk/facade';

async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function initMsg(sessionId: string, opts: { permissionMode?: string; model?: string } = {}): SdkMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: opts.model ?? 'claude-test-1',
    permissionMode: opts.permissionMode ?? 'plan',
    claude_code_version: '2.0.0',
    apiKeySource: 'none',
    cwd: '/work',
    tools: [],
    mcp_servers: [],
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: 'u-init',
  } as unknown as SdkMessage;
}

function assistantMsg(sessionId: string, texts: string[]): SdkMessage {
  return {
    type: 'assistant',
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      model: 'claude-test-1',
      content: texts.map((text) => ({ type: 'text', text })),
    },
  } as unknown as SdkMessage;
}

interface Ctx {
  dir: string;
  facade: FakeSdkFacade;
  transcript: TranscriptStore;
  registry: SessionRegistry;
  broker: PermissionBroker;
  cards: PermissionCard[];
  planCards: string[];
  outputs: Array<{ sessionId: string; entries: SeqEntry[] }>;
  ready: string[];
  failed: Array<{ sessionId: string; reason: string }>;
  ended: string[];
  modeChanges: Array<{ sessionId: string; mode: PermissionMode }>;
  events: SessionRunnerEvents;
}

async function makeCtx(): Promise<Ctx> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codedeck-runner-'));
  const facade = new FakeSdkFacade();
  const transcript = await TranscriptStore.open(dir);
  const registry = new SessionRegistry(dir);
  const cards: PermissionCard[] = [];
  const planCards: string[] = [];
  const broker = new PermissionBroker({
    onPermissionCard: (card) => { cards.push(card); },
    onQuestionCard: () => {},
    onPlanCard: (_sessionId, toolUseId) => { planCards.push(toolUseId); },
    onAutoModeChange: () => {},
    log: () => {},
  });
  const outputs: Ctx['outputs'] = [];
  const ready: string[] = [];
  const failed: Ctx['failed'] = [];
  const ended: string[] = [];
  const modeChanges: Ctx['modeChanges'] = [];
  const events: SessionRunnerEvents = {
    onOutput: (sessionId, entries) => { outputs.push({ sessionId, entries }); },
    onReady: (sessionId) => { ready.push(sessionId); },
    onFailed: (sessionId, reason) => { failed.push({ sessionId, reason }); },
    onEnded: (sessionId) => { ended.push(sessionId); },
    onModeChanged: (sessionId, mode) => { modeChanges.push({ sessionId, mode }); },
    log: () => {},
  };
  return { dir, facade, transcript, registry, broker, cards, planCards, outputs, ready, failed, ended, modeChanges, events };
}

function makeRunner(ctx: Ctx, opts: Partial<SessionRunnerOptions> & { sessionId: string }): SessionRunner {
  return new SessionRunner({
    cwd: '/work/proj',
    facade: ctx.facade,
    transcript: ctx.transcript,
    registry: ctx.registry,
    broker: ctx.broker,
    events: ctx.events,
    ...opts,
  });
}

/** Drive a runner to ready and return the fake SDK session. */
async function startReady(ctx: Ctx, sessionId: string, opts: Partial<SessionRunnerOptions> = {}): Promise<{ runner: SessionRunner; session: FakeSdkSession }> {
  const runner = makeRunner(ctx, { sessionId, ...opts });
  runner.start();
  const session = ctx.facade.session(sessionId);
  session.emit(initMsg('sdk-' + sessionId));
  // CDX-060: the ready flip happens BEFORE the init message's transcript entry
  // is appended, so also wait for that entry (seq 1) — otherwise tests that
  // assert seq numbers race the append under load and see them one too low.
  await waitFor(() =>
    runner.phase === 'ready'
    && ctx.registry.get(sessionId) !== undefined
    && ctx.transcript.seqHigh(sessionId) >= 1);
  return { runner, session };
}

describe('SessionRunner', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await makeCtx();
  });

  afterEach(async () => {
    // Registry/transcript writes may still be in flight — drain the transcript
    // queues, then retry the teardown rm (CDX-060: a straggler recreating a
    // file mid-rm is ENOTEMPTY; rm's retries cover it).
    await ctx.transcript.idle();
    await fs.rm(ctx.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it('two-phase creation: pending until the SDK init confirms, then ready + registry record', async () => {
    const runner = makeRunner(ctx, { sessionId: 's1', model: 'claude-opus-4', effortLevel: 'high' });
    runner.start();

    // Pending: no registry record yet, SDK session spawned with our id.
    expect(runner.phase).toBe('pending');
    expect(ctx.registry.get('s1')).toBeUndefined();
    const session = ctx.facade.session('s1');
    expect(session.options.cwd).toBe('/work/proj');
    expect(session.options.model).toBe('claude-opus-4');
    expect(session.options.effortLevel).toBe('high');
    expect(session.options.resume).toBeUndefined();

    session.emit(initMsg('sdk-real-1', { model: 'claude-opus-4-8' }));
    await waitFor(() => ctx.ready.length === 1);

    expect(runner.phase).toBe('ready');
    const rec = ctx.registry.get('s1');
    expect(rec?.sdkSessionId).toBe('sdk-real-1');
    expect(rec?.permissionMode).toBe('plan');
    // CDX-087: the model the SDK RESOLVED wins over the one we asked for. The
    // request can be an alias (`opus[1m]`) or absent entirely ("Default model");
    // init.model is the only authoritative answer.
    expect(rec?.model).toBe('claude-opus-4-8');
    expect(rec?.project).toBe('proj');

    // The init system entry went through the transcript with seq 1.
    await waitFor(() => ctx.outputs.length === 1);
    expect(ctx.outputs[0]?.entries[0]?.seq).toBe(1);
    expect(ctx.outputs[0]?.entries[0]?.entry.entryType).toBe('system');
    expect(ctx.transcript.seqHigh('s1')).toBe(1);
  });

  it('idle creation: the control-channel probe flips ready WITHOUT any init (SDK 0.3.222 emits init only after the first input)', async () => {
    const runner = makeRunner(ctx, { sessionId: 's1' });
    runner.start();
    expect(runner.phase).toBe('pending');

    // No init emitted at all — the probe alone confirms the subprocess.
    ctx.facade.session('s1').confirmProbe();
    await waitFor(() => ctx.ready.length === 1);

    expect(runner.phase).toBe('ready');
    const rec = ctx.registry.get('s1');
    expect(rec).toBeDefined();
    expect(rec?.sdkSessionId).toBeNull(); // init owns the sdk id — not yet known

    // init arriving LATER (first turn) persists the authoritative sdk id
    // without a second onReady.
    ctx.facade.session('s1').emit(initMsg('sdk-late-1'));
    await waitFor(() => ctx.registry.get('s1')?.sdkSessionId === 'sdk-late-1');
    expect(ctx.ready).toEqual(['s1']);
  });

  // CDX-087: the founder's header badge had nothing to show on a session
  // started with "Default model", because the bridge only ever knew the model
  // the phone ASKED for. init.model is required on the SDK's init message and
  // was being discarded.
  it('a session created with NO model records the one the SDK resolved', async () => {
    const runner = makeRunner(ctx, { sessionId: 's1' });
    runner.start();
    ctx.facade.session('s1').confirmProbe();
    await waitFor(() => ctx.ready.length === 1);
    // Pre-fix state: ready, with no model to report to the phone.
    expect(ctx.registry.get('s1')?.model).toBeUndefined();

    ctx.facade.session('s1').emit(initMsg('sdk-1', { model: 'claude-opus-5' }));
    await waitFor(() => ctx.registry.get('s1')?.model === 'claude-opus-5');
  });

  it('a later init corrects the recorded model, and an unchanged one writes nothing', async () => {
    const runner = makeRunner(ctx, { sessionId: 's1', model: 'opus[1m]' });
    runner.start();
    ctx.facade.session('s1').emit(initMsg('sdk-1', { model: 'claude-opus-5[1m]' }));
    await waitFor(() => ctx.registry.get('s1')?.model === 'claude-opus-5[1m]');

    // Every turn emits an init. A repeat of the SAME model must not keep
    // rewriting the record — each registry update publishes a heartbeat.
    const before = ctx.registry.get('s1');
    ctx.facade.session('s1').emit(initMsg('sdk-1', { model: 'claude-opus-5[1m]' }));
    await waitFor(() => ctx.registry.get('s1')?.sdkSessionId === 'sdk-1');
    expect(ctx.registry.get('s1')?.model).toBe(before?.model);

    // A genuine change (a mid-session switch that took) is picked up.
    ctx.facade.session('s1').emit(initMsg('sdk-1', { model: 'claude-haiku-4-5-20251001' }));
    await waitFor(() => ctx.registry.get('s1')?.model === 'claude-haiku-4-5-20251001');
  });

  it('probe rejection while pending: session-failed with error entry (spawn failure)', async () => {
    const runner = makeRunner(ctx, { sessionId: 's1' });
    runner.start();
    ctx.facade.session('s1').failProbe(new Error('binary not found'));

    await waitFor(() => ctx.failed.length === 1);
    expect(runner.phase).toBe('failed');
    expect(ctx.failed[0]?.reason).toContain('did not respond');
    expect(ctx.registry.get('s1')).toBeUndefined();
    const entries = await ctx.transcript.readRange('s1', [1, 10]);
    expect(entries.some((e) => e.entry.entryType === 'error')).toBe(true);
  });

  it('probe resolving AFTER init already flipped ready is a no-op (no double onReady)', async () => {
    const runner = makeRunner(ctx, { sessionId: 's1' });
    runner.start();
    ctx.facade.session('s1').emit(initMsg('sdk-first'));
    await waitFor(() => ctx.ready.length === 1);

    ctx.facade.session('s1').confirmProbe();
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.ready).toEqual(['s1']);
    expect(runner.phase).toBe('ready');
    expect(ctx.registry.get('s1')?.sdkSessionId).toBe('sdk-first');
  });

  it('creation failure (stream closes before init): session-failed, error entry, no registry record', async () => {
    const runner = makeRunner(ctx, { sessionId: 's1' });
    runner.start();
    ctx.facade.session('s1').closeStream();

    await waitFor(() => ctx.failed.length === 1);
    expect(runner.phase).toBe('failed');
    expect(runner.alive).toBe(false);
    expect(ctx.failed[0]?.reason).toContain('closed before the session was confirmed');
    expect(ctx.registry.get('s1')).toBeUndefined();
    // The dead handle is ended so the facade prunes it (CDX-022).
    await waitFor(() => ctx.facade.session('s1').ended);

    // The failure is surfaced as an error entry in the output stream.
    const lines = await ctx.transcript.readRange('s1', [1, 10]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.entry.entryType).toBe('error');
    expect(lines[0]?.entry.content).toContain('Session creation failed');
  });

  it('creation failure (facade throws synchronously): session-failed', async () => {
    const runner = new SessionRunner({
      sessionId: 's1',
      cwd: '/work',
      facade: {
        createSession: () => { throw new Error('spawn boom'); },
        supportedModels: async () => [],
      },
      transcript: ctx.transcript,
      registry: ctx.registry,
      broker: ctx.broker,
      events: ctx.events,
    });
    runner.start();
    await waitFor(() => ctx.failed.length === 1);
    expect(ctx.failed[0]?.reason).toContain('spawn boom');
    expect(runner.phase).toBe('failed');
  });

  it('appends SDK output to the transcript with store-assigned seqs and emits them', async () => {
    const { runner, session } = await startReady(ctx, 's1');
    session.emit(assistantMsg('sdk-s1', ['hello', 'world']));

    // CDX-060: seqHigh bumps synchronously at append CALL time, but onOutput
    // fires only after the durable write — wait on the emissions we assert,
    // not on seqHigh, or this races the flush under load.
    await waitFor(() => ctx.outputs.flatMap((o) => o.entries).length === 3); // init entry + 2 texts
    expect(ctx.transcript.seqHigh('s1')).toBe(3);
    const emitted = ctx.outputs.flatMap((o) => o.entries);
    expect(emitted.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(emitted[1]?.entry.content).toBe('hello');
    expect(emitted[2]?.entry.content).toBe('world');

    // Registry reports the transcript's seqHigh (the phone's sync target).
    const info = ctx.registry.toRemoteSessionInfo(ctx.transcript).find((s) => s.id === 's1');
    expect(info?.seqHigh).toBe(3);
    expect(runner.alive).toBe(true);
  });

  it('resume-on-boot: resumes via the record sdkSessionId, updates it from init, seq continues', async () => {
    // A previous bridge run: registry record + 2 transcript entries.
    const record: SessionRecord = {
      sessionId: 's1',
      sdkSessionId: 'sdk-old',
      cwd: '/work/proj',
      model: 'claude-opus-4',
      permissionMode: 'acceptEdits',
      title: 'Old title',
      project: 'proj',
      createdAt: '2026-08-05T00:00:00Z',
      lastActivity: '2026-08-05T00:00:00Z',
      state: 'offline',
    };
    await ctx.registry.upsert(record);
    const entry: OutputEntry = { entryType: 'text', content: 'old', timestamp: 't' };
    await ctx.transcript.append('s1', entry);
    await ctx.transcript.append('s1', entry);

    const runner = makeRunner(ctx, { sessionId: 's1', cwd: '/work/proj', resume: true });
    expect(runner.phase).toBe('ready'); // no pending/ready dance on resume
    runner.start();

    const session = ctx.facade.session('s1');
    expect(session.options.resume).toBe('sdk-old');
    expect(session.options.model).toBe('claude-opus-4');
    await waitFor(() => ctx.registry.get('s1')?.state === 'idle');

    // The resumed SDK session reports a NEW sdk session id — persisted for the next resume.
    session.emit(initMsg('sdk-new', { permissionMode: 'acceptEdits' }));
    await waitFor(() => ctx.registry.get('s1')?.sdkSessionId === 'sdk-new');
    expect(ctx.ready).toHaveLength(0); // no session-ready on resume

    // Seq numbering continues from the persisted transcript — never renumbered.
    session.emit(assistantMsg('sdk-new', ['fresh']));
    // CDX-060: wait on the EMISSION (what we read below), not seqHigh — seq is
    // assigned at append call time, the onOutput lands after the write flushes.
    await waitFor(() => ctx.outputs.flatMap((o) => o.entries).at(-1)?.seq === 4); // 2 old + init + 1 text
    expect(ctx.transcript.seqHigh('s1')).toBe(4);
    const last = ctx.outputs.flatMap((o) => o.entries).at(-1);
    expect(last?.seq).toBe(4);
    expect(last?.entry.content).toBe('fresh');
  });

  it('sendInput pushes to the SDK, sets the title, and appends the session-meta request once', async () => {
    const { runner, session } = await startReady(ctx, 's1');

    expect(runner.sendInput('Fix the login bug')).toBe(true);
    expect(session.inputs).toHaveLength(1);
    expect(session.inputs[0]).toContain('Fix the login bug');
    expect(session.inputs[0]).toContain('emit-session-meta');
    await waitFor(() => ctx.registry.get('s1')?.title === 'Fix the login bug');

    // Second message: meta already requested — sent verbatim.
    runner.sendInput('and add tests');
    expect(session.inputs[1]).toBe('and add tests');
  });

  it('CDX-082: sendInput authors the user transcript entry, before the reply and without the meta request', async () => {
    const { runner, session } = await startReady(ctx, 's1');

    runner.sendInput('Fix the login bug');
    await waitFor(() => ctx.outputs.flatMap((o) => o.entries)
      .some(({ entry }) => entry.metadata?.role === 'user'));

    const userEntries = ctx.outputs.flatMap((o) => o.entries)
      .filter(({ entry }) => entry.entryType === 'text' && entry.metadata?.role === 'user');
    expect(userEntries).toHaveLength(1);
    // The typed text only — the emit-session-meta request the SDK receives is
    // bridge plumbing and must never reach the transcript, or the phone's
    // outbox row (which holds the typed text) could not be matched to it.
    expect(userEntries[0]!.entry.content).toBe('Fix the login bug');
    expect(userEntries[0]!.entry.content).not.toContain('emit-session-meta');
    expect(session.inputs[0]).toContain('emit-session-meta');

    // Ordering is the whole point: the reply must sort AFTER the user entry.
    const userSeq = userEntries[0]!.seq;
    session.emit(assistantMsg('s1', ['done']));
    await waitFor(() => ctx.outputs.flatMap((o) => o.entries)
      .some(({ entry }) => entry.content === 'done'));
    const replySeq = ctx.outputs.flatMap((o) => o.entries)
      .find(({ entry }) => entry.content === 'done')!.seq;
    expect(replySeq).toBeGreaterThan(userSeq);
  });

  it('CDX-082: an SDK that DOES echo a pushed user message does not produce a second entry', async () => {
    const { runner, session } = await startReady(ctx, 's1');

    runner.sendInput('hello there');
    await waitFor(() => ctx.outputs.flatMap((o) => o.entries)
      .some(({ entry }) => entry.metadata?.role === 'user'));

    session.emit({
      type: 'user',
      session_id: 's1',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'hello there' },
      uuid: 'u-echo',
    } as unknown as SdkMessage);
    session.emit(assistantMsg('s1', ['ack']));
    await waitFor(() => ctx.outputs.flatMap((o) => o.entries)
      .some(({ entry }) => entry.content === 'ack'));

    const userEntries = ctx.outputs.flatMap((o) => o.entries)
      .filter(({ entry }) => entry.entryType === 'text' && entry.metadata?.role === 'user');
    expect(userEntries).toHaveLength(1);
  });

  it('CDX-082: a session-meta tag repeated on a later turn is still stripped', async () => {
    const { runner, session } = await startReady(ctx, 's1');

    runner.sendInput('Fix the login bug');
    session.emit(assistantMsg('s1', ['first <!-- session-meta: {"topic": "Login fix", "project": "app"} -->']));
    await waitFor(() => ctx.registry.get('s1')?.title === 'Login fix');

    // Second turn: the model re-emits the tag unprompted, having seen the
    // pattern in its own context. The parse is done, but the strip must not be.
    session.emit(assistantMsg('s1', ['second <!-- session-meta: {"topic": "Other", "project": "app"} -->']));
    await waitFor(() => ctx.outputs.flatMap((o) => o.entries)
      .some(({ entry }) => entry.content.startsWith('second')));

    const texts = ctx.outputs.flatMap((o) => o.entries)
      .filter(({ entry }) => entry.entryType === 'text' && entry.metadata?.role === 'assistant')
      .map(({ entry }) => entry.content);
    expect(texts).toContain('first');
    expect(texts).toContain('second');
    expect(texts.join('\n')).not.toContain('session-meta');
    // The once-only parse still holds: the repeat did not retitle the session.
    expect(ctx.registry.get('s1')?.title).toBe('Login fix');
  });

  it('CDB-034: a slash command is never rewritten with the meta request', async () => {
    expect(isSlashCommand('/gsd-plan-phase 2')).toBe(true);
    expect(isSlashCommand('/home/user/file')).toBe(false);

    const { runner, session } = await startReady(ctx, 's1');
    runner.sendInput('/gsd-plan-phase 2');
    expect(session.inputs[0]).toBe('/gsd-plan-phase 2');
    // The owed meta request arrives with the next ordinary message.
    runner.sendInput('carry on');
    expect(session.inputs[1]).toContain('emit-session-meta');
  });

  it('input while an AskUserQuestion is pending routes to the broker, not the input channel', async () => {
    const { runner, session } = await startReady(ctx, 's1');

    const resultPromise = session.canUseTool(
      'AskUserQuestion',
      { questions: [{ question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }] },
      { toolUseID: 'q1', requestId: 'req-q1', signal: new AbortController().signal },
    ) as Promise<SdkPermissionResult>;

    await waitFor(() => ctx.broker.hasPendingQuestions('s1'));
    expect(runner.state()).toBe('waiting_question');

    expect(runner.sendInput('B')).toBe(true);
    const result = await resultPromise;
    expect(result.behavior).toBe('allow');
    expect((result as { updatedInput?: { answers?: Record<string, string> } }).updatedInput?.answers)
      .toEqual({ 'Pick one': 'B' });
    expect(session.inputs).toHaveLength(0); // never hit the input channel
  });

  it('plan-approval keypress resolves ExitPlanMode and switches mode', async () => {
    const { runner, session } = await startReady(ctx, 's1');

    const resultPromise = session.canUseTool(
      'ExitPlanMode',
      { plan: 'the plan' },
      { toolUseID: 'x1', requestId: 'req-x1', signal: new AbortController().signal },
    ) as Promise<SdkPermissionResult>;
    await waitFor(() => ctx.broker.hasPendingPermissions('s1'));
    expect(ctx.planCards).toEqual(['x1']); // dedicated plan card, generic card suppressed
    expect(ctx.cards).toHaveLength(0);
    expect(runner.state()).toBe('waiting_permission');

    await runner.handleKeypress('1', 'plan-approval');
    const result = await resultPromise;
    expect(result.behavior).toBe('allow');
    expect(session.modes).toEqual(['acceptEdits']);
    expect(ctx.modeChanges).toEqual([{ sessionId: 's1', mode: 'acceptEdits' }]);
    await waitFor(() => ctx.registry.get('s1')?.permissionMode === 'acceptEdits');
  });

  it('mode/effort/model changes hit the SDK handle and persist to the registry', async () => {
    const { runner, session } = await startReady(ctx, 's1');

    expect(await runner.setPermissionMode('acceptEdits')).toBe(true);
    expect(session.modes).toEqual(['acceptEdits']);

    expect(await runner.setEffort('max')).toEqual({ applied: true, confirmedLevel: 'max' });
    expect(session.efforts).toEqual(['max']);

    expect(await runner.setModel('claude-sonnet-4-6')).toEqual({
      applied: true,
      confirmedModel: 'claude-sonnet-4-6',
    });
    expect(session.models).toEqual(['claude-sonnet-4-6']);

    await waitFor(() => {
      const rec = ctx.registry.get('s1');
      return rec?.permissionMode === 'acceptEdits'
        && rec?.effortLevel === 'max'
        && rec?.model === 'claude-sonnet-4-6';
    });
  });

  it('interrupt hits the SDK and denies all pending permissions', async () => {
    const { runner, session } = await startReady(ctx, 's1');

    const resultPromise = session.canUseTool(
      'Bash',
      { command: 'rm -rf /' },
      { toolUseID: 'p1', requestId: 'req-p1', signal: new AbortController().signal },
    ) as Promise<SdkPermissionResult>;
    await waitFor(() => ctx.broker.hasPendingPermissions('s1'));
    expect(ctx.cards).toHaveLength(1);

    expect(runner.interrupt()).toBe(true);
    expect(session.interrupts).toBe(1);
    const result = await resultPromise;
    expect(result.behavior).toBe('deny');
    expect(runner.state()).not.toBe('waiting_permission'); // pending drained
  });

  it('stream error after ready: restarts with resume and ENDS the dead handle (CDX-022)', async () => {
    const { runner, session } = await startReady(ctx, 's1');
    const oldSession = session;

    // A generic subprocess crash — the conversation itself still exists.
    // (The "No conversation found" error is the CDX-056 case below, which
    // deliberately does NOT resume.)
    session.errorStream(new Error('Claude Code process exited unexpectedly'));
    await waitFor(() => ctx.facade.session('s1') !== oldSession);

    // The abandoned handle must be ended so RealSdkFacade prunes it — an
    // un-ended dead handle sits first in the facade's set forever and poisons
    // supportedModels() (the CDX-022 device bug).
    expect(oldSession.ended).toBe(true);
    // The replacement resumes the confirmed SDK session id.
    expect(ctx.facade.session('s1').options.resume).toBe('sdk-s1');
    expect(runner.alive).toBe(true);
  });

  it('CDX-056: resume-on-boot of a turn-less session (sdkSessionId null) spawns FRESH, not a doomed resume', async () => {
    // What the registry holds for a session that was created but never given a
    // turn: ready came from the control-channel probe, so sdkSessionId is null.
    await ctx.registry.upsert({
      sessionId: 's1',
      sdkSessionId: null,
      cwd: '/work/proj',
      permissionMode: 'plan',
      title: null,
      project: 'proj',
      createdAt: '2026-08-09T00:00:00Z',
      lastActivity: '2026-08-09T00:00:00Z',
      state: 'offline',
    });

    const logs: string[] = [];
    const runner = new SessionRunner({
      sessionId: 's1',
      cwd: '/work/proj',
      facade: ctx.facade,
      transcript: ctx.transcript,
      registry: ctx.registry,
      broker: ctx.broker,
      events: { ...ctx.events, log: (m) => logs.push(m) },
      resume: true,
    });
    runner.start();

    // Pre-fix: options.resume fell back to OUR session id — a conversation the
    // SDK never created — and the real SDK failed every attempt with
    // "No conversation found", ending the session after 2 restarts.
    const session = ctx.facade.session('s1');
    expect(session.options.resume).toBeUndefined();
    expect(session.options.sessionId).toBe('s1');
    expect(session.options.cwd).toBe('/work/proj');
    expect(logs.some((l) => /no SDK conversation yet \(never ran a turn\) — starting fresh/.test(l))).toBe(true);

    await waitFor(() => ctx.registry.get('s1')?.state === 'idle');
    expect(runner.alive).toBe(true);
    expect(ctx.ended).toHaveLength(0);
    expect(ctx.failed).toHaveLength(0);

    // The fresh spawn's init then persists a REAL resume target for next boot.
    session.emit(initMsg('sdk-fresh'));
    await waitFor(() => ctx.registry.get('s1')?.sdkSessionId === 'sdk-fresh');
  });

  it('CDX-073: a fresh session that never asked to resume keeps its conversation, whatever the error text says', async () => {
    // This test used to assert the OPPOSITE — it fed the literal phrase into a
    // LIVE fresh session and expected the runner to null its sdkSessionId. That
    // pinned the false positive as correct: this spawn passed no `resume` at
    // all, so there is no resume for the SDK to have failed, and the id being
    // cleared is the only pointer to the conversation on disk.
    const { runner, session } = await startReady(ctx, 's1');
    const oldSession = session;
    expect(oldSession.options.resume).toBeUndefined(); // fresh spawn — nothing resumed

    session.errorStream(new Error('Claude Code returned an error result: No conversation found with session ID: sdk-s1'));
    await waitFor(() => ctx.facade.session('s1') !== oldSession);

    // The conversation survives and the restart RESUMES it (CDX-022 behaviour).
    expect(ctx.facade.session('s1').options.resume).toBe('sdk-s1');
    expect(ctx.registry.get('s1')?.sdkSessionId).toBe('sdk-s1');
    expect(ctx.registry.get('s1')?.previousSdkSessionId).toBeUndefined();
    expect(runner.alive).toBe(true);

    // …and the user is told the truthful thing: a plain restart, not a memory wipe.
    const restartEntry = ctx.outputs.flatMap((o) => o.entries)
      .find((e) => e.entry.metadata?.special === 'session_restart');
    expect(restartEntry?.entry.content).toMatch(/Session interrupted — restarting/);
    expect(restartEntry?.entry.content).not.toMatch(/does not remember/);
  });

  it('CDX-056: a turn-less session hit by a mid-life stream error restarts fresh (no resume of a nonexistent conversation)', async () => {
    // Ready via the control-channel probe — no init yet, so no sdk id exists.
    const runner = makeRunner(ctx, { sessionId: 's1' });
    runner.start();
    const first = ctx.facade.session('s1');
    first.confirmProbe();
    await waitFor(() => runner.phase === 'ready');

    first.errorStream(new Error('Claude Code process exited unexpectedly'));
    await waitFor(() => ctx.facade.session('s1') !== first);

    // Pre-fix the restart passed `resume: this.sessionId` — same doomed resume.
    expect(ctx.facade.session('s1').options.resume).toBeUndefined();
    expect(ctx.facade.session('s1').options.sessionId).toBe('s1');
    expect(runner.alive).toBe(true);
  });

  it('a clean stream end after ready marks the session ended but keeps the record', async () => {
    const { runner, session } = await startReady(ctx, 's1');
    session.closeStream();

    await waitFor(() => ctx.ended.includes('s1'));
    expect(runner.alive).toBe(false);
    expect(runner.phase).toBe('ended');
    expect(ctx.registry.get('s1')).toBeDefined(); // resumable after a restart
    expect(ctx.registry.get('s1')?.state).toBe('idle');
  });

  it('appendEntry gives out-of-band entries unique store-assigned seqs (CDB-025)', async () => {
    const { runner } = await startReady(ctx, 's1');
    const card: OutputEntry = {
      entryType: 'system',
      content: 'Permission needed: Bash',
      timestamp: 't',
      metadata: { special: 'permission_request' },
    };
    const a = await runner.appendEntry(card);
    const b = await runner.appendEntry(card);
    expect(a.seq).toBe(2);
    expect(b.seq).toBe(3);
    expect(ctx.transcript.seqHigh('s1')).toBe(3);
  });
});

// --- CDX-062: provider binding + per-spawn sessionEnv ctx ---

describe('SessionRunner — provider binding (CDX-062)', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await makeCtx();
  });

  afterEach(async () => {
    await ctx.transcript.idle(); // CDX-060 — see the first describe's teardown
    await fs.rm(ctx.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it('sessionEnv receives ctx.providerId at spawn; options carry fallbackModel:null and the env', async () => {
    const envCalls: Array<{ providerId?: string }> = [];
    const { runner } = await startReady(ctx, 's1', {
      providerId: 'kimi',
      sessionEnv: (c) => { envCalls.push(c); return { MARKER: 'yes' }; },
    });
    expect(envCalls).toEqual([{ providerId: 'kimi' }]);
    const opts = ctx.facade.session('s1').options;
    expect(opts.fallbackModel).toBeNull();
    expect(opts.env).toEqual({ MARKER: 'yes' });
    expect(runner.providerId).toBe('kimi');
    // The registry record persists the binding.
    expect(ctx.registry.get('s1')?.providerId).toBe('kimi');
    // …and it surfaces in RemoteSessionInfo (label is the orchestrator's job).
    expect(ctx.registry.toRemoteSessionInfo(ctx.transcript)[0]?.providerId).toBe('kimi');
  });

  it('an unbound session passes an empty ctx and keeps the default fallback behavior', async () => {
    const envCalls: Array<{ providerId?: string }> = [];
    const { runner } = await startReady(ctx, 's1', {
      sessionEnv: (c) => { envCalls.push(c); return undefined; },
    });
    expect(envCalls).toEqual([{}]);
    expect(ctx.facade.session('s1').options.fallbackModel).toBeUndefined();
    expect(runner.providerId).toBeUndefined();
    expect(ctx.registry.get('s1')?.providerId).toBeUndefined();
  });

  it('auto-restart re-evaluates sessionEnv with the SAME provider ctx (live profile per spawn)', async () => {
    const envCalls: Array<{ providerId?: string }> = [];
    const { session } = await startReady(ctx, 's1', {
      providerId: 'kimi',
      sessionEnv: (c) => { envCalls.push(c); return { SPAWN: String(envCalls.length) }; },
    });
    session.errorStream(new Error('stream died'));
    await waitFor(() => ctx.facade.session('s1') !== session);
    expect(envCalls).toEqual([{ providerId: 'kimi' }, { providerId: 'kimi' }]);
    // The restart spawn got the FRESH env (token rotation reaches restarts).
    expect(ctx.facade.session('s1').options.env).toEqual({ SPAWN: '2' });
    expect(ctx.facade.session('s1').options.fallbackModel).toBeNull();
  });

  it('resume rehydrates providerId from the registry record (no explicit option)', async () => {
    await ctx.registry.upsert({
      sessionId: 's1',
      sdkSessionId: 'sdk-old',
      cwd: '/work/proj',
      providerId: 'kimi',
      title: 'Old',
      project: 'proj',
      createdAt: '2026-08-09T00:00:00Z',
      lastActivity: '2026-08-09T00:00:00Z',
      state: 'offline',
    });
    const envCalls: Array<{ providerId?: string }> = [];
    const runner = makeRunner(ctx, {
      sessionId: 's1',
      resume: true,
      sessionEnv: (c) => { envCalls.push(c); return undefined; },
    });
    runner.start();
    expect(runner.providerId).toBe('kimi');
    expect(envCalls).toEqual([{ providerId: 'kimi' }]);
    expect(ctx.facade.session('s1').options.fallbackModel).toBeNull();
    await runner.close();
  });

  it('sessionEnv throw at CREATION → session-failed (never a silent fallback)', async () => {
    const runner = makeRunner(ctx, {
      sessionId: 's1',
      providerId: 'kimi',
      sessionEnv: () => { throw new Error("provider profile 'kimi' was deleted"); },
    });
    runner.start();
    await waitFor(() => ctx.failed.length === 1);
    expect(runner.phase).toBe('failed');
    expect(ctx.failed[0]?.reason).toContain("provider profile 'kimi' was deleted");
    expect(ctx.facade.sessions.size).toBe(0); // never spawned
  });

  it('sessionEnv throw at RESTART → error transcript entry + ended; the bridge never crashes', async () => {
    let spawns = 0;
    const { runner, session } = await startReady(ctx, 's1', {
      providerId: 'kimi',
      sessionEnv: () => {
        spawns++;
        if (spawns > 1) throw new Error("provider profile 'kimi' was deleted");
        return { OK: '1' };
      },
    });
    session.errorStream(new Error('stream died'));
    await waitFor(() => ctx.ended.includes('s1'));

    expect(runner.alive).toBe(false);
    const entries = await ctx.transcript.readRange('s1', [1, 20]);
    expect(entries.some((e) =>
      e.entry.entryType === 'error' && /provider profile 'kimi' was deleted/.test(e.entry.content))).toBe(true);
    // Exactly one live SDK spawn happened — the restart never spawned.
    expect(ctx.facade.sessions.size).toBe(1);
    expect(ctx.registry.get('s1')).toBeDefined(); // record kept (deliberate)
  });

  it('sessionEnv throw on RESUME start → error entry + ended (failCreation would no-op on a ready session)', async () => {
    await ctx.registry.upsert({
      sessionId: 's1',
      sdkSessionId: 'sdk-old',
      cwd: '/work/proj',
      providerId: 'kimi',
      title: 'Old',
      project: 'proj',
      createdAt: '2026-08-09T00:00:00Z',
      lastActivity: '2026-08-09T00:00:00Z',
      state: 'offline',
    });
    const runner = makeRunner(ctx, {
      sessionId: 's1',
      resume: true,
      sessionEnv: () => { throw new Error("provider profile 'kimi' was deleted"); },
    });
    runner.start();
    await waitFor(() => ctx.ended.includes('s1'));
    expect(runner.alive).toBe(false);
    expect(ctx.failed).toHaveLength(0); // not the pending-failure path
    const entries = await ctx.transcript.readRange('s1', [1, 10]);
    expect(entries.some((e) =>
      e.entry.entryType === 'error' && /could not be resumed/.test(e.entry.content)
      && /provider profile 'kimi' was deleted/.test(e.entry.content))).toBe(true);
  });
});

// --- CDX-073 / CDX-074: the unresumable discriminator, and terminal routing ---

/**
 * Resume-on-boot a session that already exists on disk: a registry record plus
 * `historyEntries` transcript lines (the state the phone can see). The record's
 * sdkSessionId is the resume target the SDK will be handed.
 */
async function startResumed(
  ctx: Ctx,
  sessionId: string,
  opts: { sdkSessionId: string | null; historyEntries?: number; previousSdkSessionId?: string; logs?: string[] },
): Promise<{ runner: SessionRunner; session: FakeSdkSession }> {
  await ctx.registry.upsert({
    sessionId,
    sdkSessionId: opts.sdkSessionId,
    ...(opts.previousSdkSessionId ? { previousSdkSessionId: opts.previousSdkSessionId } : {}),
    cwd: '/work/proj',
    permissionMode: 'plan',
    title: 'Long-running work',
    project: 'proj',
    createdAt: '2026-08-09T00:00:00Z',
    lastActivity: '2026-08-09T00:00:00Z',
    state: 'offline',
  });
  for (let i = 1; i <= (opts.historyEntries ?? 0); i++) {
    await ctx.transcript.append(sessionId, {
      entryType: 'text',
      content: `earlier turn ${i}`,
      timestamp: '2026-08-09T00:00:00Z',
      metadata: { role: 'assistant' },
    });
  }
  const runner = makeRunner(ctx, {
    sessionId,
    resume: true,
    ...(opts.logs ? { events: { ...ctx.events, log: (m: string) => opts.logs!.push(m) } } : {}),
  });
  runner.start();
  return { runner, session: ctx.facade.session(sessionId) };
}

function restartNotice(ctx: Ctx): OutputEntry | undefined {
  return ctx.outputs.flatMap((o) => o.entries)
    .find((e) => e.entry.metadata?.special === 'session_restart')?.entry;
}

describe('SessionRunner — the unresumable discriminator (CDX-073)', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await makeCtx();
  });

  afterEach(async () => {
    await ctx.transcript.idle();
    await fs.rm(ctx.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it('CDX-073: an SDK that refuses OUR resume target drops it, keeps it recoverable, and restarts fresh', async () => {
    const logs: string[] = [];
    const { runner, session } = await startResumed(ctx, 's1', {
      sdkSessionId: 'sdk-old', historyEntries: 3, logs,
    });
    expect(session.options.resume).toBe('sdk-old'); // we DID ask to resume

    // The true positive, structurally: a resume was in flight, the spawn
    // produced NOTHING (the conversation never came up), and the error names
    // that exact id.
    session.errorStream(new Error(
      'Claude Code process exited with code 1. stderr: Error: No conversation found with session ID: sdk-old',
    ));
    await waitFor(() => ctx.facade.session('s1') !== session);

    expect(ctx.facade.session('s1').options.resume).toBeUndefined(); // fresh, same cwd
    expect(ctx.facade.session('s1').options.cwd).toBe('/work/proj');
    expect(runner.alive).toBe(true);
    expect(ctx.ended).toHaveLength(0);

    await waitFor(() => ctx.registry.get('s1')?.sdkSessionId === null);
    // The pointer is dropped, NOT destroyed — a wrong drop stays recoverable.
    expect(ctx.registry.get('s1')?.previousSdkSessionId).toBe('sdk-old');
    expect(logs.some((l) => /kept as previousSdkSessionId/.test(l))).toBe(true);

    expect(restartNotice(ctx)?.content).toMatch(/fresh conversation in the same workspace/);
    expect(restartNotice(ctx)?.content).toMatch(/does not remember earlier turns/);
  });

  it('CDX-073: a resume that WORKED is not dropped because the crash tail happens to carry the phrase', async () => {
    const { session } = await startResumed(ctx, 's1', { sdkSessionId: 'sdk-old', historyEntries: 40 });
    expect(session.options.resume).toBe('sdk-old');

    // The resume succeeded — the SDK confirmed the conversation with an init.
    session.emit(initMsg('sdk-old'));
    await waitFor(() => ctx.outputs.length >= 1);

    // Minutes later the subprocess is OOM-killed. The SDK builds the stream
    // error as `…exited with code <n>. stderr: <last ~2KB>`, and CodeDeck feeds
    // that channel on purpose: settingSources ['user','project'] runs the
    // user's and the project's hooks, and everything the agent prints from Bash
    // lands there too. The phrase in the tail is about a DIFFERENT, older
    // resume the agent ran in a shell — not about ours.
    session.errorStream(new Error(
      'Claude Code process exited with code 137. stderr: [hook] $ claude --resume sdk-old\n'
      + 'Error: No conversation found with session ID: sdk-old\nKilled',
    ));
    await waitFor(() => ctx.facade.session('s1') !== session);

    // Pre-fix: sdkSessionId nulled and persisted — 40 turns of conversation
    // orphaned on disk with no pointer left, and the model amnesiac.
    expect(ctx.facade.session('s1').options.resume).toBe('sdk-old');
    expect(ctx.registry.get('s1')?.sdkSessionId).toBe('sdk-old');
    expect(ctx.registry.get('s1')?.previousSdkSessionId).toBeUndefined();
    expect(restartNotice(ctx)?.content).toMatch(/Session interrupted — restarting/);
  });

  it('CDX-073: "no conversation found" about SOME OTHER conversation never drops ours', async () => {
    // No messages at all on this spawn, so the "spawn produced output" half of
    // the discriminator cannot be what saves it — only the id disagrees.
    const { session } = await startResumed(ctx, 's1', { sdkSessionId: 'sdk-current', historyEntries: 5 });
    session.errorStream(new Error(
      'Claude Code process exited with code 1. stderr: $ claude --resume sdk-ancient\n'
      + 'Error: No conversation found with session ID: sdk-ancient\nsegmentation fault',
    ));
    await waitFor(() => ctx.facade.session('s1') !== session);

    expect(ctx.facade.session('s1').options.resume).toBe('sdk-current');
    expect(ctx.registry.get('s1')?.sdkSessionId).toBe('sdk-current');
    expect(ctx.registry.get('s1')?.previousSdkSessionId).toBeUndefined();
  });

  it('CDX-073: with both restarts burned, the drop and the memory-loss admission travel together', async () => {
    const { session } = await startResumed(ctx, 's1', { sdkSessionId: 'sdk-old', historyEntries: 7 });

    // Burn both restarts on unrelated crashes; the conversation is still live,
    // so each restart keeps resuming it.
    let current = session;
    for (let i = 0; i < 2; i++) {
      const dying = current;
      dying.errorStream(new Error('Claude Code process exited unexpectedly'));
      await waitFor(() => ctx.facade.session('s1') !== dying);
      current = ctx.facade.session('s1');
      expect(current.options.resume).toBe('sdk-old');
    }

    current.errorStream(new Error(
      'Claude Code process exited with code 1. stderr: Error: No conversation found with session ID: sdk-old',
    ));
    await waitFor(() => ctx.ended.includes('s1'));

    // Pre-fix the clear ran BEFORE the restart gate: the id was destroyed and
    // persisted while the entire restart block — including the entry that
    // admits the memory loss — was skipped, so the user was told only
    // "Session ended unexpectedly after multiple restart attempts."
    const died = ctx.outputs.flatMap((o) => o.entries)
      .find((e) => e.entry.metadata?.special === 'session_died')?.entry;
    expect(died?.content).toMatch(/its SDK conversation was missing/);
    expect(died?.content).toMatch(/will not remember earlier turns/);

    await waitFor(() => ctx.registry.get('s1')?.sdkSessionId === null);
    expect(ctx.registry.get('s1')?.previousSdkSessionId).toBe('sdk-old');
  });

  it('CDX-073: the next boot of a session that LOST its conversation never logs "never ran a turn"', async () => {
    const logs: string[] = [];
    const { runner } = await startResumed(ctx, 's1', {
      sdkSessionId: null, previousSdkSessionId: 'sdk-old', historyEntries: 7, logs,
    });

    // Pre-fix this printed the turn-less line for a session with 7 entries of
    // history — the exact misreading that log exists to prevent.
    expect(logs.some((l) => /never ran a turn/.test(l))).toBe(false);
    expect(logs.some((l) =>
      /has 7 transcript entries but no resumable SDK conversation \(dropped sdk-old\)/.test(l))).toBe(true);

    // …and it stays a LOG line. The user was already told when the drop
    // happened; re-telling them at boot would append another entry on every
    // bridge restart of an untouched session, and consume a seq (and so shift
    // the retention window) of a transcript this boot never wrote to.
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.outputs).toHaveLength(0);
    expect(ctx.transcript.seqHigh('s1')).toBe(7);
    await runner.close();
  });

  it('CDX-073: a genuinely turn-less session still starts fresh silently (negative control)', async () => {
    const logs: string[] = [];
    const { runner } = await startResumed(ctx, 's1', { sdkSessionId: null, historyEntries: 0, logs });

    expect(logs.some((l) => /never ran a turn/.test(l))).toBe(true);
    expect(logs.some((l) => /transcript entries but no resumable/.test(l))).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.outputs).toHaveLength(0);
    await runner.close();
  });
});

describe('SessionRunner — no silent zombies (CDX-074)', () => {
  let ctx: Ctx;
  let logs: string[];

  beforeEach(async () => {
    ctx = await makeCtx();
    logs = [];
    ctx.events.log = (m) => { logs.push(m); };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await ctx.transcript.idle();
    await fs.rm(ctx.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** Registry I/O that fails the way the real one does: the returned promise
   *  carries its own handler, so `void`ed call sites stay safe and only AWAITED
   *  ones propagate — which is exactly the case that used to be swallowed. */
  function breakRegistryUpdate(ctx: Ctx): void {
    vi.spyOn(ctx.registry, 'update').mockImplementation(() => {
      const p = Promise.reject(new Error('EIO: state dir gone'));
      p.catch(() => undefined);
      return p as Promise<SessionRecord | undefined>;
    });
  }

  it('CDX-074: a stream consumer that rejects ends the session instead of leaving a zombie', async () => {
    const { runner, session } = await startReady(ctx, 's1');
    breakRegistryUpdate(ctx);

    session.errorStream(new Error('Claude Code process exited unexpectedly'));
    await waitFor(() => ctx.ended.includes('s1'));

    // Pre-fix bg() logged the rejection and returned: the respawn never ran AND
    // endSession() never ran, so the runner stayed alive/'ready', sendInput
    // pushed into a closed channel and returned true ("delivered" forever), and
    // onEnded never fired so the phone never removed the session.
    expect(runner.alive).toBe(false);
    expect(runner.phase).toBe('ended');
    expect(runner.sendInput('are you still there?')).toBe(false);
    expect(session.inputs).toHaveLength(0);
    expect(logs.some((l) => /stream consumer failed for s1/.test(l))).toBe(true);
  });

  it('CDX-074: onEnded still fires when the end-state registry write fails', async () => {
    const { session } = await startReady(ctx, 's1');
    breakRegistryUpdate(ctx);

    session.closeStream(); // clean subprocess exit → endSession()
    await waitFor(() => ctx.ended.includes('s1'));
    expect(logs.some((l) => /end-state registry update failed/.test(l))).toBe(true);
  });

  it('CDX-074: a broken transcript costs the restart notice, not the restart', async () => {
    const { runner, session } = await startReady(ctx, 's1');
    vi.spyOn(ctx.transcript, 'append').mockRejectedValue(new Error('ENOENT: transcript dir gone'));

    session.errorStream(new Error('Claude Code process exited unexpectedly'));
    await waitFor(() => ctx.facade.session('s1') !== session);

    expect(runner.alive).toBe(true);
    expect(ctx.ended).toHaveLength(0);
    expect(logs.some((l) => /notice append failed for s1/.test(l))).toBe(true);
  });

  it('CDX-074: a creation-path spawn failure survives a broken transcript AND a throwing onFailed', async () => {
    ctx.events.onFailed = () => { throw new Error('orchestrator publish blew up'); };
    vi.spyOn(ctx.transcript, 'append').mockRejectedValue(new Error('ENOENT: transcript dir gone'));
    vi.spyOn(ctx.facade, 'createSession').mockImplementation(() => { throw new Error('spawn ENOENT'); });

    const runner = makeRunner(ctx, { sessionId: 's1' });
    runner.start();

    // Pre-fix this path was `void this.failCreation(…)` over an awaited
    // transcript append, and at the time nothing in the repo installed a
    // process-level unhandledRejection guard, so the rejection took the bridge
    // down instead of being logged. CDX-074(c) has since added one
    // (`installProcessGuards()`, src/process/guards.ts, installed in both
    // hosts), but it only logs-and-continues — it would leave this session a
    // zombie, so the call-site catch below is still the actual fix. Vitest
    // fails this test if a rejection escapes now.
    await waitFor(() => logs.some((l) => /creation failure failed for s1/.test(l)));
    expect(logs.some((l) => /notice append failed for s1/.test(l))).toBe(true);
    expect(runner.phase).toBe('failed');
    expect(runner.alive).toBe(false);
  });

  it('CDX-074: a resume-path spawn failure survives a broken transcript AND a throwing onEnded', async () => {
    ctx.events.onEnded = () => { throw new Error('orchestrator publish blew up'); };
    await ctx.registry.upsert({
      sessionId: 's1',
      sdkSessionId: 'sdk-old',
      cwd: '/work/proj',
      title: 'Old',
      project: 'proj',
      createdAt: '2026-08-09T00:00:00Z',
      lastActivity: '2026-08-09T00:00:00Z',
      state: 'offline',
    });
    vi.spyOn(ctx.transcript, 'append').mockRejectedValue(new Error('ENOENT: transcript dir gone'));
    vi.spyOn(ctx.facade, 'createSession').mockImplementation(() => { throw new Error('spawn ENOENT'); });

    const runner = makeRunner(ctx, { sessionId: 's1', resume: true });
    runner.start();

    await waitFor(() => logs.some((l) => /resumed-spawn failure failed for s1/.test(l)));
    expect(runner.alive).toBe(false);
  });
});

// --- CDX-005 remainder: usage, context usage, git-commit detection ---

function resultMsg(over: Record<string, unknown> = {}): SdkMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 10,
    num_turns: 1,
    total_cost_usd: 0.01,
    usage: {},
    ...over,
  } as unknown as SdkMessage;
}

function bashToolUseMsg(command: string): SdkMessage {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      model: 'claude-test-1',
      content: [{ type: 'tool_use', id: 'tu-bash-1', name: 'Bash', input: { command } }],
    },
  } as unknown as SdkMessage;
}

describe('SessionRunner — usage / context usage / git detection (CDX-005 remainder)', () => {
  let ctx: Ctx;
  let stateChanges: string[];

  beforeEach(async () => {
    ctx = await makeCtx();
    stateChanges = [];
    ctx.events.onStateChanged = (sessionId) => { stateChanges.push(sessionId); };
  });

  afterEach(async () => {
    // CDX-060: this describe's teardown was the one WITHOUT retries — the
    // `ENOTEMPTY rmdir` false red under load ('getUsage normalizes …').
    await ctx.transcript.idle();
    await fs.rm(ctx.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it('getUsage normalizes the scripted experimental snapshot', async () => {
    const { runner, session } = await startReady(ctx, 's1');
    session.usageSnapshot = {
      rate_limits_available: true,
      subscription_type: 'max',
      rate_limits: { five_hour: { utilization: 30, resets_at: '2026-08-05T15:00:00Z' } },
    };
    const usage = await runner.getUsage();
    expect(usage).not.toBeNull();
    expect(usage!.available).toBe(true);
    expect(usage!.subscriptionType).toBe('max');
    expect(usage!.fiveHour).toEqual({ utilization: 30, resetsAt: '2026-08-05T15:00:00Z' });
  });

  it('getUsage returns null for unsupported SDKs and dead sessions', async () => {
    const { runner, session } = await startReady(ctx, 's1');
    session.usageSnapshot = null; // feature-detect miss
    expect(await runner.getUsage()).toBeNull();
    session.usageSnapshot = { totally: 'unexpected' }; // shape drift
    expect(await runner.getUsage()).toBeNull();
    await runner.close();
    session.usageSnapshot = { rate_limits_available: true };
    expect(await runner.getUsage()).toBeNull();
  });

  it('a result message captures contextWindow (modelUsage) and the context % into the registry', async () => {
    const { runner, session } = await startReady(ctx, 's1', { model: 'claude-test-1' });
    session.contextUsage = { percentage: 37.4, contextWindow: 1_000_000 };
    session.emit(resultMsg({
      modelUsage: { 'claude-test-1': { contextWindow: 200_000 } },
    }));
    await waitFor(() => ctx.registry.get('s1')?.contextPercentage !== undefined);
    const rec = ctx.registry.get('s1')!;
    // modelUsage landed first; the getContextUsage refresh then reports the
    // honest (1M-beta) window and the rounded percentage.
    expect(rec.contextPercentage).toBe(37);
    expect(rec.contextWindow).toBe(1_000_000);
    expect(stateChanges).toContain('s1');
    // Registry → RemoteSessionInfo carries both.
    const info = ctx.registry.toRemoteSessionInfo(ctx.transcript).find((s) => s.id === 's1')!;
    expect(info.contextPercentage).toBe(37);
    expect(info.contextWindow).toBe(1_000_000);
    void runner;
  });

  it('detectCommit flips committed once HEAD advances past the start hash (poll path)', async () => {
    let head = 'aaa111';
    const gitHead = async () => head;
    const { runner } = await startReady(ctx, 's1', { gitHead });
    await waitFor(() => stateChanges.length >= 0); // let start()'s baseHead capture settle
    await new Promise((r) => setTimeout(r, 10));

    expect(await runner.detectCommit()).toBe(false); // HEAD unchanged
    head = 'bbb222';
    expect(await runner.detectCommit()).toBe(true);
    expect(ctx.registry.get('s1')?.committed).toBe(true);
    expect(ctx.registry.toRemoteSessionInfo(ctx.transcript)[0]?.committed).toBe(true);
    expect(await runner.detectCommit()).toBe(false); // already committed — no rework
  });

  it('a Bash `git commit` tool_use triggers immediate detection (fast path)', async () => {
    let head = 'base00';
    const gitHead = async () => head;
    const { session } = await startReady(ctx, 's1', { gitHead });
    await new Promise((r) => setTimeout(r, 10)); // baseHead captured

    head = 'newhead';
    session.emit(bashToolUseMsg('git commit -m "feat: done"'));
    await waitFor(() => ctx.registry.get('s1')?.committed === true);
  });

  it('a resumed session keeps its committed badge from the registry record', async () => {
    const { runner } = await startReady(ctx, 's1', { gitHead: async () => 'h1' });
    await new Promise((r) => setTimeout(r, 10));
    await ctx.registry.update('s1', { committed: true, state: 'offline' });
    await runner.close();

    const resumed = makeRunner(ctx, { sessionId: 's1', resume: true, gitHead: async () => 'h2' });
    resumed.start();
    await waitFor(() => ctx.facade.sessions.size >= 1);
    // Already committed → resume must not clear the badge or re-detect.
    expect(await resumed.detectCommit()).toBe(false);
    expect(ctx.registry.get('s1')?.committed).toBe(true);
    await resumed.close();
  });
});
