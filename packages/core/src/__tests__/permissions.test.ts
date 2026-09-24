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
  questionCards: Array<{ sessionId: string; requestId: string; questions: QuestionSpec[] }>;
  planCards: Array<{ sessionId: string; requestId: string }>;
  resolved: Array<{ sessionId: string; requestId: string; summary: string }>;
  modeChanges: Array<{ sessionId: string; mode: string }>;
  pendingChanged: string[];
  logs: string[];
}

function makeBroker(opts?: { timeoutMs?: number }): { broker: PermissionBroker; rec: Recorded } {
  const rec: Recorded = {
    permissionCards: [],
    questionCards: [],
    planCards: [],
    resolved: [],
    modeChanges: [],
    pendingChanged: [],
    logs: [],
  };
  const broker = new PermissionBroker(
    {
      onPermissionCard: (card) => rec.permissionCards.push(card),
      onQuestionCard: (sessionId, requestId, questions) => rec.questionCards.push({ sessionId, requestId, questions }),
      onPlanCard: (sessionId, requestId) => rec.planCards.push({ sessionId, requestId }),
      onResolved: (sessionId, requestId, summary) => rec.resolved.push({ sessionId, requestId, summary }),
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
  agent: 'claude-code',
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

  it('(4) the auto-approve mode approves everything else, for any agent', async () => {
    const { broker, rec } = makeBroker();
    for (const agent of ['claude-code', 'opencode']) {
      const result = await broker.handleCanUseTool(
        ctx({ agent, permissionMode: 'default' }),
        'Bash',
        { command: 'rm -rf build' },
        { toolUseID: `tu3-${agent}` },
      );
      expect(result).toEqual({ behavior: 'allow', updatedInput: {} });
    }
    expect(rec.permissionCards).toHaveLength(0);
    expect(rec.resolved).toHaveLength(0);
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
    expect(rec.permissionCards[0]!.options.map((o) => o.id)).toEqual(['allow', 'allow_always', 'deny']);
    expect(broker.hasPendingPermissions('s1')).toBe(true);

    expect(broker.resolvePermission('tu5', 'allow')).toBe(true);
    await expect(p).resolves.toEqual({ behavior: 'allow', updatedInput: {} });
    expect(broker.hasPendingPermissions('s1')).toBe(false);
    expect(rec.resolved).toEqual([{ sessionId: 's1', requestId: 'tu5', summary: 'Allowed' }]);
  });

  it('any mode other than the auto-approve one asks (OpenCode\'s ask mode)', async () => {
    const { broker, rec } = makeBroker();
    void broker.handleCanUseTool(
      ctx({ agent: 'opencode', permissionMode: 'ask' }),
      'bash',
      { command: 'ls' },
      { toolUseID: 'tu-oc' },
    );
    expect(rec.permissionCards).toHaveLength(1);
    // OpenCode cannot persist an allow rule, so it offers no "Always allow".
    expect(rec.permissionCards[0]!.options.map((o) => o.id)).toEqual(['allow', 'deny']);
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
    broker.resolvePermission('tu6', 'deny');
    await expect(p).resolves.toMatchObject({ behavior: 'deny' });
  });
});

describe('PermissionBroker — resolvePermission options', () => {
  it('allow_always → allow with a persisted project-scoped addRules update', async () => {
    const { broker, rec } = makeBroker();
    const p = broker.handleCanUseTool(ctx(), 'Bash', { command: 'ls' }, { toolUseID: 'tu1' });
    broker.resolvePermission('tu1', 'allow_always');
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
    expect(rec.resolved[0]!.summary).toBe('Always allowed');
  });

  it('deny → "User denied"', async () => {
    const { broker, rec } = makeBroker();
    const p = broker.handleCanUseTool(ctx(), 'Bash', { command: 'ls' }, { toolUseID: 'tu1' });
    broker.resolvePermission('tu1', 'deny');
    await expect(p).resolves.toEqual({ behavior: 'deny', message: 'User denied' });
    expect(rec.resolved[0]!.summary).toBe('Denied');
  });

  it('an option the card does not offer is refused and keeps the request pending', () => {
    const { broker } = makeBroker();
    void broker.handleCanUseTool(ctx({ agent: 'opencode', permissionMode: 'ask' }), 'bash', {}, { toolUseID: 'tu1' });
    expect(broker.resolvePermission('tu1', 'allow_always')).toBe(false);
    expect(broker.hasPendingPermissions('s1')).toBe(true);
  });

  it('unknown requestId no-ops and returns false', () => {
    const { broker } = makeBroker();
    expect(broker.resolvePermission('nope', 'allow')).toBe(false);
  });
});

describe('PermissionBroker — ExitPlanMode', () => {
  it('suppresses the generic card and emits the plan approval card', async () => {
    const { broker, rec } = makeBroker();
    const p = broker.handleCanUseTool(
      ctx({ permissionMode: 'plan' }),
      'ExitPlanMode',
      { plan: '## The plan' },
      { toolUseID: 'tu-plan' },
    );
    expect(rec.permissionCards).toHaveLength(0);
    expect(rec.planCards).toEqual([{ sessionId: 's1', requestId: 'tu-plan' }]);
    expect(broker.hasPendingPermissions('s1')).toBe(true);

    // A plan approval is not answerable as a permission card.
    expect(broker.resolvePermission('tu-plan', 'allow')).toBe(false);
    expect(broker.resolvePlanApproval('tu-plan', true, 'Approve')).toBe(true);
    await expect(p).resolves.toMatchObject({ behavior: 'allow' });
    expect(rec.resolved).toEqual([{ sessionId: 's1', requestId: 'tu-plan', summary: 'Approve' }]);
  });

  it('keeping the plan denies ExitPlanMode so the agent stays planning', async () => {
    const { broker } = makeBroker();
    const p = broker.handleCanUseTool(ctx(), 'ExitPlanMode', { plan: 'x' }, { toolUseID: 'tu-plan' });
    expect(broker.resolvePlanApproval('tu-plan', false, 'Keep planning')).toBe(true);
    await expect(p).resolves.toMatchObject({ behavior: 'deny' });
    expect(broker.resolvePlanApproval('tu-plan', true, 'late')).toBe(false);
  });
});

describe('PermissionBroker — AskUserQuestion', () => {
  it('publishes a question card and resolves on a free-text answer keyed by full question text', async () => {
    const { broker, rec } = makeBroker();
    const input = {
      questions: [{ question: 'Which color?', header: 'Color', options: [{ label: 'red' }, { label: 'blue' }] }],
    };
    const p = broker.handleCanUseTool(ctx(), 'AskUserQuestion', input, { toolUseID: 'q1' });
    expect(rec.questionCards).toEqual([{ sessionId: 's1', requestId: 'q1', questions: input.questions }]);
    expect(broker.hasPendingQuestions('s1')).toBe(true);

    expect(broker.answerQuestion('s1', 'q1', 0, 'green actually')).toBe(true);
    await expect(p).resolves.toEqual({
      behavior: 'allow',
      // Echoes the original input and keys answers by FULL question text, not header.
      updatedInput: { ...input, answers: { 'Which color?': 'green actually' } },
    });
    expect(broker.hasPendingQuestions('s1')).toBe(false);
    expect(rec.resolved).toEqual([{ sessionId: 's1', requestId: 'q1', summary: 'green actually' }]);
  });

  it('optionLabels turns chosen option indices into the answer text', () => {
    const { broker } = makeBroker();
    const input = { questions: [{ question: 'Pick', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }] };
    void broker.handleCanUseTool(ctx(), 'AskUserQuestion', input, { toolUseID: 'q1' });
    expect(broker.optionLabels('q1', 0, [1])).toBe('B');
    expect(broker.optionLabels('q1', 0, [0, 2])).toBe('A, C');
    expect(broker.optionLabels('q1', 0, [5])).toBeNull();
    expect(broker.optionLabels('q1', 3, [0])).toBeNull();
    expect(broker.optionLabels('nope', 0, [0])).toBeNull();
  });

  it('answers questions by index, in any order, and resolves once all are answered', async () => {
    const { broker, rec } = makeBroker();
    const input = {
      questions: [
        { question: 'Q-first?', options: [{ label: 'f1' }, { label: 'f2' }] },
        { question: 'Q-second?', options: [{ label: 's1' }] },
        { question: 'Q-third?' },
      ],
    };
    const p = broker.handleCanUseTool(ctx(), 'AskUserQuestion', input, { toolUseID: 'q1' });

    expect(broker.answerQuestion('s1', 'q1', 2, 'free text')).toBe(true);
    expect(broker.hasPendingQuestions('s1')).toBe(true); // group not done yet
    expect(broker.answerQuestion('s1', 'q1', 0, 'f2')).toBe(true);
    expect(broker.answerQuestion('s1', 'q1', 1, 's1')).toBe(true);

    await expect(p).resolves.toEqual({
      behavior: 'allow',
      updatedInput: {
        ...input,
        answers: { 'Q-first?': 'f2', 'Q-second?': 's1', 'Q-third?': 'free text' },
      },
    });
    expect(rec.resolved[0]!.summary).toBe('f2 · s1 · free text');
  });

  it('plain input answers the active ask\'s first unanswered question', async () => {
    const { broker } = makeBroker();
    const input = { questions: [{ question: 'A?' }, { question: 'B?' }] };
    const p = broker.handleCanUseTool(ctx(), 'AskUserQuestion', input, { toolUseID: 'q1' });
    expect(broker.answerQuestion('s1', 'q1', 0, 'one')).toBe(true);
    expect(broker.answerActiveQuestion('s1', 'two')).toBe(true);
    await expect(p).resolves.toMatchObject({ updatedInput: { answers: { 'A?': 'one', 'B?': 'two' } } });
  });

  it('refuses an unknown ask, a wrong session or an out-of-range index', () => {
    const { broker } = makeBroker();
    void broker.handleCanUseTool(ctx(), 'AskUserQuestion', { questions: [{ question: 'Q?' }] }, { toolUseID: 'q1' });
    expect(broker.answerQuestion('s1', 'nope', 0, 'x')).toBe(false);
    expect(broker.answerQuestion('s2', 'q1', 0, 'x')).toBe(false);
    expect(broker.answerQuestion('s1', 'q1', 1, 'x')).toBe(false);
    expect(broker.hasPendingQuestions('s1')).toBe(true);
  });

  it('returns false when no question is pending (caller falls back to plain input)', () => {
    const { broker } = makeBroker();
    expect(broker.answerActiveQuestion('s1', 'hello')).toBe(false);
  });
});

describe('PermissionBroker — timeouts', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('denies a pending question after the (injectable) timeout', async () => {
    const { broker, rec } = makeBroker({ timeoutMs: 1000 });
    const p = broker.handleCanUseTool(
      ctx(),
      'AskUserQuestion',
      { questions: [{ question: 'Still there?' }] },
      { toolUseID: 'q1' },
    );
    vi.advanceTimersByTime(1001);
    await expect(p).resolves.toEqual({ behavior: 'deny', message: 'Question timed out' });
    expect(broker.hasPendingQuestions('s1')).toBe(false);
    expect(rec.resolved).toEqual([{ sessionId: 's1', requestId: 'q1', summary: 'Timed out' }]);
    // A late answer finds nothing to resolve.
    expect(broker.answerQuestion('s1', 'q1', 0, 'too late')).toBe(false);
  });

  it('denies a pending permission after the timeout', async () => {
    const { broker, rec } = makeBroker({ timeoutMs: 1000 });
    const p = broker.handleCanUseTool(ctx(), 'Bash', { command: 'ls' }, { toolUseID: 'tu1' });
    vi.advanceTimersByTime(1001);
    await expect(p).resolves.toEqual({ behavior: 'deny', message: 'Permission timed out' });
    expect(rec.resolved[0]!.summary).toBe('Timed out');
    expect(broker.resolvePermission('tu1', 'allow')).toBe(false);
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
    // Every drained card is closed with the reason.
    expect(rec.resolved).toEqual([
      { sessionId: 's1', requestId: 'tu1', summary: 'Interrupted by user' },
      { sessionId: 's1', requestId: 'q1', summary: 'Interrupted by user' },
    ]);

    // A late phone answer finds the entries gone and no-ops (cannot double-resolve).
    expect(broker.resolvePermission('tu1', 'allow')).toBe(false);

    broker.resolvePermission('tu2', 'allow');
    await expect(other).resolves.toMatchObject({ behavior: 'allow' });
    expect(rec.pendingChanged).toContain('s2');
  });
});
