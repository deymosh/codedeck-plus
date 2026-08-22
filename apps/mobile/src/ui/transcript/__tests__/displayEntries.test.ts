/**
 * buildDisplayEntries — row-renderer selection over the REAL bridge entry
 * vocabulary (sdkMessageToEntries output + the runner/broker out-of-band
 * entries), plus grouping, answered-state detection and the noise filter.
 */
import { describe, it, expect } from 'vitest';
import type { OutputEntry } from '@codedeck/protocol';
import {
  buildDisplayEntries,
  findPendingPermission,
  isHiddenSystemEntry,
  type SeqEntry,
} from '../displayEntries';

let seqCounter = 0;
const e = (
  entryType: OutputEntry['entryType'],
  content: string,
  metadata?: Record<string, unknown>,
): SeqEntry => ({
  seq: ++seqCounter,
  entry: {
    entryType,
    content,
    timestamp: '2026-08-05T00:00:00.000Z',
    ...(metadata ? { metadata } : {}),
  },
});

describe('buildDisplayEntries — kind selection', () => {
  it('maps each bridge entry kind to its display row', () => {
    seqCounter = 0;
    const display = buildDisplayEntries([
      e('text', 'hello from user', { role: 'user' }),
      e('text', 'assistant standalone answer', { role: 'assistant', display_hint: 'show' }),
      e('error', 'boom', { error_type: 'error_during_execution' }),
      e('system', 'some status line'),
      e('system', 'Session interrupted — restarting (attempt 1)...', { special: 'session_restart' }),
    ]);
    expect(display.map((d) => d.kind)).toEqual([
      'user_message',
      'assistant_message',
      'error',
      'system',
      'lifecycle',
    ]);
  });

  it('groups consecutive tool entries plus collapsed assistant text into one tool_group', () => {
    seqCounter = 0;
    const display = buildDisplayEntries([
      e('text', 'let me look', { role: 'assistant', display_hint: 'collapse' }),
      e('tool_use', 'Bash: ls', { tool_name: 'Bash', tool_use_id: 't1' }),
      e('tool_result', 'file.txt', { tool_use_id: 't1' }),
      e('progress', 'working…'),
      e('text', 'done — here is the answer', { role: 'assistant', display_hint: 'show' }),
    ]);
    expect(display.map((d) => d.kind)).toEqual(['tool_group', 'assistant_message']);
    const group = display[0]!;
    if (group.kind !== 'tool_group') throw new Error('expected tool_group');
    expect(group.entries).toHaveLength(4);
    expect(group.summary).toBe('3 actions'); // collapsed text does not count
  });

  it('renders plan text + plan approval as separate rows sharing the tool_use_id', () => {
    seqCounter = 0;
    const display = buildDisplayEntries([
      e('text', '# The plan\n1. do things', { role: 'assistant', special: 'plan', tool_use_id: 'p1' }),
      e('system', 'Plan approval needed', { special: 'plan_approval', tool_use_id: 'p1', has_plan: true }),
    ]);
    expect(display.map((d) => d.kind)).toEqual(['assistant_message', 'plan_approval']);
    const plan = display[0]!;
    if (plan.kind !== 'assistant_message') throw new Error('expected assistant_message');
    expect(plan.isPlan).toBe(true);
    const approval = display[1]!;
    if (approval.kind !== 'plan_approval') throw new Error('expected plan_approval');
    expect(approval.hasPlan).toBe(true);
    expect(approval.answered).toBeUndefined();
  });

  it('plan approval without a plan carries hasPlan false (exit-plan variant)', () => {
    seqCounter = 0;
    const display = buildDisplayEntries([
      e('system', 'Plan approval needed', { special: 'plan_approval', tool_use_id: 'p1', has_plan: false }),
    ]);
    const approval = display[0]!;
    if (approval.kind !== 'plan_approval') throw new Error('expected plan_approval');
    expect(approval.hasPlan).toBe(false);
  });

  it('a tool_result answering the plan tool_use_id marks the approval answered', () => {
    seqCounter = 0;
    const display = buildDisplayEntries([
      e('system', 'Plan approval needed', { special: 'plan_approval', tool_use_id: 'p1', has_plan: true }),
      e('tool_result', 'User approved the plan', { tool_use_id: 'p1' }),
    ]);
    const approval = display.find((d) => d.kind === 'plan_approval')!;
    if (approval.kind !== 'plan_approval') throw new Error('expected plan_approval');
    expect(approval.answered).toBe('Plan approved');
  });

  it('single ask_question → question card with options/multiSelect metadata', () => {
    seqCounter = 0;
    const display = buildDisplayEntries([
      e('system', 'Which color?', {
        special: 'ask_question',
        tool_use_id: 'q1',
        header: 'Color',
        options: [{ label: 'red' }, { label: 'blue', description: 'cool' }],
        multiSelect: false,
        question_index: 0,
        question_count: 1,
      }),
    ]);
    expect(display).toHaveLength(1);
    const q = display[0]!;
    if (q.kind !== 'question') throw new Error('expected question');
    expect(q.toolUseId).toBe('q1');
    expect(q.question.header).toBe('Color');
    expect(q.question.options).toHaveLength(2);
  });

  it('multi-question group: same tool_use_id buffers into question_group sorted by index', () => {
    seqCounter = 0;
    const display = buildDisplayEntries([
      e('system', 'Second?', {
        special: 'ask_question', tool_use_id: 'q1', header: 'B',
        question_index: 1, question_count: 2,
      }),
      e('system', 'First?', {
        special: 'ask_question', tool_use_id: 'q1', header: 'A',
        question_index: 0, question_count: 2,
      }),
    ]);
    expect(display).toHaveLength(1);
    const group = display[0]!;
    if (group.kind !== 'question_group') throw new Error('expected question_group');
    expect(group.toolUseId).toBe('q1');
    expect(group.questions.map((q) => q.header)).toEqual(['A', 'B']);
  });

  it('permission_request → card with tool/description/subagent fields; tool_result resolves it', () => {
    seqCounter = 0;
    const display = buildDisplayEntries([
      e('system', 'Permission needed: Bash', {
        special: 'permission_request',
        tool_name: 'Bash',
        tool_use_id: 'perm1',
        tool_input: { command: 'rm -rf build' },
        description: 'Run rm -rf build',
        subagent: true,
        agent_label: 'Plan',
      }),
    ]);
    const card = display[0]!;
    if (card.kind !== 'permission_request') throw new Error('expected permission_request');
    expect(card.toolName).toBe('Bash');
    expect(card.requestId).toBe('perm1');
    expect(card.description).toBe('Run rm -rf build');
    expect(card.isSubAgent).toBe(true);
    expect(card.agentLabel).toBe('Plan');
    expect(card.answered).toBeUndefined();

    const resolved = buildDisplayEntries([
      e('system', 'Permission needed: Bash', {
        special: 'permission_request', tool_name: 'Bash', tool_use_id: 'perm1',
      }),
      e('tool_result', 'User denied', { tool_use_id: 'perm1' }),
    ]);
    const resolvedCard = resolved.find((d) => d.kind === 'permission_request')!;
    if (resolvedCard.kind !== 'permission_request') throw new Error('expected permission_request');
    expect(resolvedCard.answered).toBe('User denied');
  });

  it('filters per-turn noise: stream_end, token counts, init banner, result summary', () => {
    seqCounter = 0;
    const display = buildDisplayEntries([
      e('system', '', { stream_end: true }),
      e('system', 'Tokens: 10 in / 20 out', { usage: {} }),
      e('system', 'Claude Code 2.0.1 (claude-opus-4)', { subtype: 'init' }),
      e('system', 'Session complete — 3 turns, $0.0421', { subtype: 'result' }),
      e('text', 'visible', { role: 'assistant' }),
    ]);
    expect(display.map((d) => d.kind)).toEqual(['assistant_message']);
  });

  it('isHiddenSystemEntry never hides special cards', () => {
    const entry: OutputEntry = {
      entryType: 'system',
      content: '',
      timestamp: 't',
      metadata: { special: 'permission_request', tool_use_id: 'x' },
    };
    expect(isHiddenSystemEntry(entry)).toBe(false);
  });
});

describe('findPendingPermission', () => {
  it('returns the latest unanswered, un-responded permission; resolved/responded skipped', () => {
    seqCounter = 0;
    const entries = [
      e('system', 'perm A', { special: 'permission_request', tool_name: 'Bash', tool_use_id: 'a' }),
      e('tool_result', 'User denied', { tool_use_id: 'a' }),
      e('system', 'perm B', { special: 'permission_request', tool_name: 'Edit', tool_use_id: 'b' }),
    ];
    expect(findPendingPermission(entries, undefined)?.requestId).toBe('b');
    expect(findPendingPermission(entries, new Set(['b']))).toBeNull();
  });
});

describe('thinking entries (CDX-085 — folded into the action group)', () => {
  // The founder's report: a turn rendered as `Thinking`, `4 actions`,
  // `Thinking`, `2 actions` — four rows of chrome for one turn's work. These
  // tests are the inverse of the ones they replace, which asserted the split.

  it('thinking between tool calls IS absorbed into the tool group', () => {
    seqCounter = 0;
    const display = buildDisplayEntries([
      e('tool_use', 'Bash: ls', { tool_name: 'Bash', tool_use_id: 't1' }),
      e('thinking', 'hmm', { role: 'assistant' }),
      e('tool_use', 'Bash: pwd', { tool_name: 'Bash', tool_use_id: 't2' }),
    ]);
    // ONE row, not three. This is the whole point of the change.
    expect(display.map((d) => d.kind)).toEqual(['tool_group']);
    const group = display[0]!;
    if (group.kind !== 'tool_group') throw new Error('expected tool_group');
    expect(group.entries).toHaveLength(3);
    expect(group.summary).toBe('3 actions');
    // Transcript order is preserved, so reasoning renders where it happened.
    expect(group.entries.map((x) => x.entry.entryType)).toEqual([
      'tool_use',
      'thinking',
      'tool_use',
    ]);
  });

  it('thinking counts as an action', () => {
    seqCounter = 0;
    const display = buildDisplayEntries([
      e('thinking', 'first', { role: 'assistant' }),
      e('tool_use', 'Bash: ls', { tool_name: 'Bash', tool_use_id: 't1' }),
      e('thinking', 'second', { role: 'assistant' }),
    ]);
    const group = display[0]!;
    if (group.kind !== 'tool_group') throw new Error('expected tool_group');
    // 2 thinking + 1 tool_use. Counting only the tool call would say "1 action"
    // while the body listed three items.
    expect(group.summary).toBe('3 actions');
  });

  it('a lone thinking step reads as one action, and owns the group seq', () => {
    seqCounter = 0;
    const display = buildDisplayEntries([
      e('thinking', 'let me reason…', { role: 'assistant' }),
      e('text', 'the answer', { role: 'assistant', display_hint: 'show' }),
    ]);
    expect(display.map((d) => d.kind)).toEqual(['tool_group', 'assistant_message']);
    const group = display[0]!;
    if (group.kind !== 'tool_group') throw new Error('expected tool_group');
    expect(group.summary).toBe('1 action');
    expect(group.entries[0]!.entry.content).toBe('let me reason…');
    // Thinking can now OPEN a group, so it owns the seq that keys the
    // expanded-groups set in TranscriptView.
    expect(group.seq).toBe(group.entries[0]!.seq);
  });

  it('redacted thinking is carried into the group so the row can label it', () => {
    seqCounter = 0;
    const display = buildDisplayEntries([e('thinking', '', { role: 'assistant', redacted: true })]);
    expect(display).toHaveLength(1);
    const group = display[0]!;
    if (group.kind !== 'tool_group') throw new Error('expected tool_group');
    expect(group.summary).toBe('1 action');
    // content is '' — ToolGroupRow substitutes a placeholder off this flag,
    // otherwise it renders as a blank line in the body.
    expect(group.entries[0]!.entry.metadata?.redacted).toBe(true);
  });
});

describe('diff entries (CDX-050 — colored diff cards)', () => {
  const diffEntry = (): SeqEntry => ({
    seq: ++seqCounter,
    entry: {
      entryType: 'diff',
      content: '-const a = 1;\n+const a = 2;',
      timestamp: '2026-08-08T00:00:00.000Z',
      metadata: { role: 'assistant', tool_name: 'Edit', tool_use_id: 'toolu_d1' },
      diff: {
        path: 'src/app.ts',
        lines: [
          { type: 'del', text: 'const a = 1;' },
          { type: 'add', text: 'const a = 2;' },
        ],
      },
    },
  });

  it('routes entryType "diff" to its own diff display item', () => {
    seqCounter = 0;
    const display = buildDisplayEntries([diffEntry()]);
    expect(display.map((d) => d.kind)).toEqual(['diff']);
    const diff = display[0]!;
    if (diff.kind !== 'diff') throw new Error('expected diff');
    expect(diff.entry.diff?.path).toBe('src/app.ts');
  });

  it('renders standalone — never absorbed into the surrounding tool group', () => {
    seqCounter = 0;
    const display = buildDisplayEntries([
      e('tool_use', 'Edit: src/app.ts', { tool_name: 'Edit', tool_use_id: 'toolu_d1' }),
      diffEntry(),
      e('tool_result', 'ok', { tool_use_id: 'toolu_d1' }),
    ]);
    // The diff splits the tool entries into two groups around a visible card.
    expect(display.map((d) => d.kind)).toEqual(['tool_group', 'diff', 'tool_group']);
  });
});
