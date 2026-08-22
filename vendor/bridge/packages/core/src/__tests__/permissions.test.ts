/**
 * PermissionBroker — the full arbitration order ported from the old bridge's
 * handlePermission(), now testable via injected callbacks and fake timers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PermissionBroker,
  DEFAULT_PERMISSION_TIMEOUT_MS,
  type PermissionCard,
  type PermissionContext,
  type QuestionSpec,
} from '../session/permissions';

interface Recorded {
  permissionCards: PermissionCard[];
  questionCards: Array<{ sessionId: string; toolUseId: string; questions: QuestionSpec[] }>;
  planCards: Array<{ sessionId: string; toolUseId: string }>;
  modeChanges: Array<{ sessionId: string; mode: string }>;
  pendingChanged: string[];
  logs: string[];
}

function makeBroker(opts?: { timeoutMs?: number }): { broker: PermissionBroker; rec: Recorded } {
  const rec: Recorded = {
    permissionCards: [],
    questionCards: [],
    planCards: [],
    modeChanges: [],
    pendingChanged: [],
    logs: [],
  };
  const broker = new PermissionBroker(
    {
      onPermissionCard: (card) => rec.permissionCards.push(card),
      onQuestionCard: (sessionId, toolUseId, questions) => rec.questionCards.push({ sessionId, toolUseId, questions }),
      onPlanCard: (sessionId, toolUseId) => rec.planCards.push({ sessionId, toolUseId }),
      onAutoModeChange: (sessionId, mode) => rec.modeChanges.push({ sessionId, mode }),
      onPendingChanged: (sessionId) => rec.pendingChanged.push(sessionId),
      log: (msg) => rec.logs.push(msg),
    },
    opts,
  );
  return { broker, rec };
}

const ctx = (patch: Partial<PermissionContext> = {}): PermissionContext => ({
  sessionId: 's1',
  permissionMode: 'plan',
  ...patch,
});

describe('PermissionBroker — arbitration order', () => {
  it('(1) test-session secret-path deny beats default-mode allow', async () => {
    const { broker, rec } = makeBroker();
    const result = await broker.handleCanUseTool(
      ctx({ permissionMode: 'default', testSession: true }),
      'Read',
      { file_path: 'kubo/android/key.properties' },
      { toolUseID: 'tu1' },
    );
    expect(result.behavior).toBe('deny');
    expect((result as { message: string }).message).toContain('hard security boundary');
    expect(rec.permissionCards).toHaveLength(0);
  });

  it('secret-path deny does NOT fire for non-test sessions', async () => {
    const { broker } = makeBroker();
    const result = await broker.handleCanUseTool(
      ctx({ permissionMode: 'default', testSession: false }),
      'Read',
      { file_path: 'kubo/android/key.properties' },
      { toolUseID: 'tu1' },
    );
    expect(result.behavior).toBe('allow');
  });

  it('(3) EnterPlanMode auto-allows and flips tracked mode via callback', async () => {
    const { broker, rec } = makeBroker();
    const result = await broker.handleCanUseTool(
      ctx({ permissionMode: 'default' }),
      'EnterPlanMode',
      {},
      { toolUseID: 'tu2' },
    );
    expect(result.behavior).toBe('allow');
    expect(rec.modeChanges).toEqual([{ sessionId: 's1', mode: 'plan' }]);
  });

  it('(4) default mode auto-approves everything else', async () => {
    const { broker, rec } = makeBroker();
    const result = await broker.handleCanUseTool(
      ctx({ permissionMode: 'default' }),
      'Bash',
      { command: 'rm -rf build' },
      { toolUseID: 'tu3' },
    );
    expect(result).toEqual({ behavior: 'allow', updatedInput: {} });
    expect(rec.permissionCards).toHaveLength(0);
  });

  it('(5) benign plans-dir write is auto-allowed in plan mode', async () => {
    const { broker, rec } = makeBroker();
    const result = await broker.handleCanUseTool(
      ctx({ permissionMode: 'plan' }),
      'Bash',
      { command: 'mkdir -p ~/.claude/plans' },
      { toolUseID: 'tu4' },
    );
    expect(result.behavior).toBe('allow');
    expect(rec.permissionCards).toHaveLength(0);
  });

  it('(7) plan mode forwards a generic tool to the permission card', async () => {
    const { broker, rec } = makeBroker();
    const p = broker.handleCanUseTool(
      ctx({ permissionMode: 'plan' }),
      'Bash',
      { command: 'npm test' },
      { toolUseID: 'tu5', title: 'Run npm test' },
    );
    expect(rec.permissionCards).toHaveLength(1);
    expect(rec.permissionCards[0]).toMatchObject({
      sessionId: 's1',
      toolName: 'Bash',
      toolUseId: 'tu5',
      title: 'Run npm test',
      isSubAgent: false,
    });
    expect(broker.hasPendingPermissions('s1')).toBe(true);

    broker.resolvePermission('tu5', true);
    await expect(p).resolves.toEqual({ behavior: 'allow', updatedInput: {} });
    expect(broker.hasPendingPermissions('s1')).toBe(false);
  });

  it('labels sub-agent cards with agentId and agentLabel', async () => {
    const { broker, rec } = makeBroker();
    const p = broker.handleCanUseTool(
      ctx({ permissionMode: 'acceptEdits', agentLabel: 'Plan' }),
      'Bash',
      { command: 'ls' },
      { toolUseID: 'tu6', agentID: 'agent-1' },
    );
    expect(rec.permissionCards[0]).toMatchObject({
      isSubAgent: true,
      agentId: 'agent-1',
      agentLabel: 'Plan',
    });
    broker.resolvePermission('tu6', false);
    await expect(p).resolves.toMatchObject({ behavior: 'deny' });
  });
});

describe('PermissionBroker — resolvePermission modifiers', () => {
  it('always → allow with a persisted project-scoped addRules update', async () => {
    const { broker } = makeBroker();
    const p = broker.handleCanUseTool(ctx(), 'Bash', { command: 'ls' }, { toolUseID: 'tu1' });
    broker.resolvePermission('tu1', true, 'always');
    await expect(p).resolves.toEqual({
      behavior: 'allow',
      updatedInput: {},
      updatedPermissions: [{
        type: 'addRules',
        rules: [{ toolName: 'Bash' }],
        behavior: 'allow',
        destination: 'projectSettings',
      }],
    });
  });

  it('never → deny with the never-ask-again message', async () => {
    const { broker } = makeBroker();
    const p = broker.handleCanUseTool(ctx(), 'Bash', { command: 'ls' }, { toolUseID: 'tu1' });
    broker.resolvePermission('tu1', false, 'never');
    await expect(p).resolves.toEqual({ behavior: 'deny', message: 'User denied (never ask again)' });
  });

  it('plain deny → "User denied"', async () => {
    const { broker } = makeBroker();
    const p = broker.handleCanUseTool(ctx(), 'Bash', { command: 'ls' }, { toolUseID: 'tu1' });
    broker.resolvePermission('tu1', false);
    await expect(p).resolves.toEqual({ behavior: 'deny', message: 'User denied' });
  });

  it('unknown requestId no-ops and returns false', () => {
    const { broker } = makeBroker();
    expect(broker.resolvePermission('nope', true)).toBe(false);
  });
});

describe('PermissionBroker — ExitPlanMode', () => {
  it('suppresses the generic card and emits the dedicated plan card', async () => {
    const { broker, rec } = makeBroker();
    const p = broker.handleCanUseTool(
      ctx({ permissionMode: 'plan' }),
      'ExitPlanMode',
      { plan: '## The plan' },
      { toolUseID: 'tu-plan' },
    );
    expect(rec.permissionCards).toHaveLength(0);
    expect(rec.planCards).toEqual([{ sessionId: 's1', toolUseId: 'tu-plan' }]);

    // The plan-approval tap finds the pending ExitPlanMode by tool name.
    const id = broker.findPendingPermission('s1', 'ExitPlanMode');
    expect(id).toBe('tu-plan');
    broker.resolvePermission(id!, true);
    await expect(p).resolves.toMatchObject({ behavior: 'allow' });
  });
});

describe('PermissionBroker — AskUserQuestion', () => {
  it('publishes a question card and resolves on a free-text answer keyed by full question text', async () => {
    const { broker, rec } = makeBroker();
    const input = {
      questions: [{ question: 'Which color?', header: 'Color', options: [{ label: 'red' }, { label: 'blue' }] }],
    };
    const p = broker.handleCanUseTool(ctx(), 'AskUserQuestion', input, { toolUseID: 'q1' });
    expect(rec.questionCards).toHaveLength(1);
    expect(rec.questionCards[0]!.questions[0]!.question).toBe('Which color?');
    expect(broker.hasPendingQuestions('s1')).toBe(true);

    expect(broker.answerQuestion('s1', { text: 'green actually' })).toBe(true);
    await expect(p).resolves.toEqual({
      behavior: 'allow',
      // Echoes the original input and keys answers by FULL question text, not header.
      updatedInput: { ...input, answers: { 'Which color?': 'green actually' } },
    });
    expect(broker.hasPendingQuestions('s1')).toBe(false);
  });

  it('resolves a keypress against that question\'s options (1-based)', async () => {
    const { broker } = makeBroker();
    const input = { questions: [{ question: 'Pick one', options: [{ label: 'Option A' }, { label: 'Option B' }] }] };
    const p = broker.handleCanUseTool(ctx(), 'AskUserQuestion', input, { toolUseID: 'q1' });

    expect(broker.answerQuestion('s1', { keypress: '2' })).toBe(true);
    await expect(p).resolves.toMatchObject({
      updatedInput: { answers: { 'Pick one': 'Option B' } },
    });
  });

  it('rejects an out-of-range keypress without consuming the question', async () => {
    const { broker } = makeBroker();
    const input = { questions: [{ question: 'Pick one', options: [{ label: 'A' }] }] };
    const p = broker.handleCanUseTool(ctx(), 'AskUserQuestion', input, { toolUseID: 'q1' });

    expect(broker.answerQuestion('s1', { keypress: '5' })).toBe(false);
    expect(broker.hasPendingQuestions('s1')).toBe(true);
    expect(broker.answerQuestion('s1', { keypress: '1' })).toBe(true);
    await expect(p).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('answers a multi-question group IN ORDER and resolves once all are answered', async () => {
    const { broker } = makeBroker();
    const input = {
      questions: [
        { question: 'Q-first?', options: [{ label: 'f1' }, { label: 'f2' }] },
        { question: 'Q-second?', options: [{ label: 's1' }] },
        { question: 'Q-third?' },
      ],
    };
    const p = broker.handleCanUseTool(ctx(), 'AskUserQuestion', input, { toolUseID: 'q1' });

    broker.answerQuestion('s1', { keypress: '2' });      // → Q-first: f2
    expect(broker.hasPendingQuestions('s1')).toBe(true); // group not done yet
    broker.answerQuestion('s1', { keypress: '1' });      // → Q-second: s1
    broker.answerQuestion('s1', { text: 'free text' });  // → Q-third

    await expect(p).resolves.toEqual({
      behavior: 'allow',
      updatedInput: {
        ...input,
        answers: { 'Q-first?': 'f2', 'Q-second?': 's1', 'Q-third?': 'free text' },
      },
    });
  });

  it('returns false when no question is pending (caller falls back to plain input)', () => {
    const { broker } = makeBroker();
    expect(broker.answerQuestion('s1', { text: 'hello' })).toBe(false);
  });
});

describe('PermissionBroker — timeouts', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('denies a pending question after the (injectable) timeout', async () => {
    const { broker } = makeBroker({ timeoutMs: 1000 });
    const p = broker.handleCanUseTool(
      ctx(),
      'AskUserQuestion',
      { questions: [{ question: 'Still there?' }] },
      { toolUseID: 'q1' },
    );
    vi.advanceTimersByTime(1001);
    await expect(p).resolves.toEqual({ behavior: 'deny', message: 'Question timed out' });
    expect(broker.hasPendingQuestions('s1')).toBe(false);
    // A late answer finds nothing to resolve.
    expect(broker.answerQuestion('s1', { text: 'too late' })).toBe(false);
  });

  it('denies a pending permission after the timeout', async () => {
    const { broker } = makeBroker({ timeoutMs: 1000 });
    const p = broker.handleCanUseTool(ctx(), 'Bash', { command: 'ls' }, { toolUseID: 'tu1' });
    vi.advanceTimersByTime(1001);
    await expect(p).resolves.toEqual({ behavior: 'deny', message: 'Permission timed out' });
    expect(broker.resolvePermission('tu1', true)).toBe(false);
  });

  it('defaults to 1 hour (deliberate change from the old 24h)', () => {
    expect(DEFAULT_PERMISSION_TIMEOUT_MS).toBe(60 * 60 * 1000);
  });
});

describe('PermissionBroker — denyAllPending', () => {
  it('denies every pending permission AND question for the session, once', async () => {
    const { broker, rec } = makeBroker();
    const perm = broker.handleCanUseTool(ctx(), 'Bash', { command: 'ls' }, { toolUseID: 'tu1' });
    const question = broker.handleCanUseTool(
      ctx(),
      'AskUserQuestion',
      { questions: [{ question: 'Q?' }] },
      { toolUseID: 'q1' },
    );
    // Another session's pending must survive.
    const other = broker.handleCanUseTool(
      ctx({ sessionId: 's2' }),
      'Bash',
      { command: 'pwd' },
      { toolUseID: 'tu2' },
    );

    broker.denyAllPending('s1', 'Interrupted by user');
    await expect(perm).resolves.toEqual({ behavior: 'deny', message: 'Interrupted by user' });
    await expect(question).resolves.toEqual({ behavior: 'deny', message: 'Interrupted by user' });
    expect(broker.hasPendingPermissions('s1')).toBe(false);
    expect(broker.hasPendingQuestions('s1')).toBe(false);
    expect(broker.hasPendingPermissions('s2')).toBe(true);

    // A late phone answer finds the entries gone and no-ops (cannot double-resolve).
    expect(broker.resolvePermission('tu1', true)).toBe(false);

    broker.resolvePermission('tu2', true);
    await expect(other).resolves.toMatchObject({ behavior: 'allow' });
    expect(rec.pendingChanged).toContain('s2');
  });
});
