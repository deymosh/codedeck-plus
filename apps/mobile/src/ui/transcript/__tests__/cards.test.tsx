// @vitest-environment jsdom
/**
 * Interaction-card component tests — the assertion that matters is the EXACT
 * typed protocol message each tap produces (a fake CardActions records what
 * would go to bridgeApi.send), plus resolved/optimistic rendering states.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PhoneToBridgeMessage } from '@codedeck/protocol';
import type {
  PermissionRequestDisplay,
  PlanApprovalDisplay,
  QuestionDisplay,
  QuestionGroupDisplay,
} from '../displayEntries';
import type { CardActions } from '../rows/types';
import { PermissionCard, summarizeToolInput } from '../rows/PermissionCard';
import { PlanApprovalCard } from '../rows/PlanApprovalCard';
import { QuestionCard, QuestionGroupCard, isFreeTextOption } from '../rows/QuestionCard';

afterEach(cleanup);

function recorder() {
  const sent: PhoneToBridgeMessage[] = [];
  const responded: string[] = [];
  const planChoices: Array<[string, string]> = [];
  const actions: CardActions = {
    sendCommand: (msg) => sent.push(msg),
    markResponded: (cardId) => responded.push(cardId),
    setPlanChoice: (cardId, key) => planChoices.push([cardId, key]),
  };
  return { sent, responded, planChoices, actions };
}

const SESSION = 'sess-1';

const permissionItem = (over: Partial<PermissionRequestDisplay> = {}): PermissionRequestDisplay => ({
  kind: 'permission_request',
  seq: 5,
  entry: {
    entryType: 'system',
    content: 'Permission needed: Bash',
    timestamp: 't',
    metadata: { special: 'permission_request', tool_input: { command: 'npm test' } },
  },
  toolName: 'Bash',
  description: 'Run npm test',
  requestId: 'toolu_123',
  isSubAgent: false,
  ...over,
});

describe('PermissionCard', () => {
  it('Allow sends the exact permission-res message and marks responded', () => {
    const r = recorder();
    render(
      <PermissionCard item={permissionItem()} sessionId={SESSION} responded={false} actions={r.actions} />,
    );
    fireEvent.click(screen.getByText('Allow'));
    expect(r.sent).toEqual([
      { type: 'permission-res', sessionId: SESSION, requestId: 'toolu_123', allow: true },
    ]);
    expect(r.responded).toEqual(['toolu_123']);
  });

  it('Always allow sends modifier always; web tools get the domain label', () => {
    const r = recorder();
    render(
      <PermissionCard item={permissionItem()} sessionId={SESSION} responded={false} actions={r.actions} />,
    );
    fireEvent.click(screen.getByText('Always allow'));
    expect(r.sent).toEqual([
      {
        type: 'permission-res',
        sessionId: SESSION,
        requestId: 'toolu_123',
        allow: true,
        modifier: 'always',
      },
    ]);
    cleanup();
    const r2 = recorder();
    render(
      <PermissionCard
        item={permissionItem({ toolName: 'WebFetch' })}
        sessionId={SESSION}
        responded={false}
        actions={r2.actions}
      />,
    );
    expect(screen.getByText('Allow domain')).toBeTruthy();
  });

  it('Deny sends allow:false', () => {
    const r = recorder();
    render(
      <PermissionCard item={permissionItem()} sessionId={SESSION} responded={false} actions={r.actions} />,
    );
    fireEvent.click(screen.getByText('Deny'));
    expect(r.sent).toEqual([
      { type: 'permission-res', sessionId: SESSION, requestId: 'toolu_123', allow: false },
    ]);
  });

  it('optimistically responded card shows "Response sent…" with no buttons', () => {
    const r = recorder();
    render(
      <PermissionCard item={permissionItem()} sessionId={SESSION} responded={true} actions={r.actions} />,
    );
    expect(screen.getByText('Response sent…')).toBeTruthy();
    expect(screen.queryByText('Allow')).toBeNull();
  });

  it('resolved card (answered tool_result) shows the outcome inline', () => {
    const r = recorder();
    render(
      <PermissionCard
        item={permissionItem({ answered: 'User denied' })}
        sessionId={SESSION}
        responded={false}
        actions={r.actions}
      />,
    );
    expect(screen.getByText('Denied')).toBeTruthy();
    expect(screen.queryByText('Deny')).toBeNull();
  });

  it('sub-agent origin is labelled', () => {
    const r = recorder();
    render(
      <PermissionCard
        item={permissionItem({ isSubAgent: true, agentLabel: 'Plan' })}
        sessionId={SESSION}
        responded={false}
        actions={r.actions}
      />,
    );
    expect(screen.getByText('Plan agent wants to run this')).toBeTruthy();
  });

  it('summarizeToolInput prefers the meaningful field and truncates', () => {
    expect(summarizeToolInput('Bash', { command: 'ls -la' })).toBe('ls -la');
    expect(summarizeToolInput('Read', { file_path: '/tmp/x' })).toBe('/tmp/x');
    expect(summarizeToolInput('X', { a: 1 })).toBe('{"a":1}');
    expect(summarizeToolInput('Bash', { command: 'x'.repeat(300) })).toHaveLength(201);
  });
});

const planItem = (over: Partial<PlanApprovalDisplay> = {}): PlanApprovalDisplay => ({
  kind: 'plan_approval',
  seq: 9,
  entry: {
    entryType: 'system',
    content: 'Plan approval needed',
    timestamp: 't',
    metadata: { special: 'plan_approval', tool_use_id: 'plan_1', has_plan: true },
  },
  toolUseId: 'plan_1',
  hasPlan: true,
  ...over,
});

describe('PlanApprovalCard', () => {
  it.each([
    ['Approve — mode EDITS', '1'],
    ['Approve — mode YOLO', '2'],
    ['Revise plan', '3'],
  ] as const)('%s sends keypress %s with context plan-approval', (label, key) => {
    const r = recorder();
    render(
      <PlanApprovalCard
        item={planItem()}
        sessionId={SESSION}
        responded={false}
        choice={undefined}
        actions={r.actions}
      />,
    );
    fireEvent.click(screen.getByText(label));
    expect(r.sent).toEqual([
      { type: 'keypress', sessionId: SESSION, key, context: 'plan-approval' },
    ]);
    expect(r.responded).toEqual(['plan_1']);
    expect(r.planChoices).toEqual([['plan_1', key]]);
  });

  it('responded card shows the remembered choice label', () => {
    const r = recorder();
    render(
      <PlanApprovalCard
        item={planItem()}
        sessionId={SESSION}
        responded={true}
        choice={'1'}
        actions={r.actions}
      />,
    );
    expect(screen.getByText('Plan approved — Accept Edits')).toBeTruthy();
  });

  it('hasPlan false renders the exit-plan variant title', () => {
    const r = recorder();
    render(
      <PlanApprovalCard
        item={planItem({ hasPlan: false })}
        sessionId={SESSION}
        responded={false}
        choice={undefined}
        actions={r.actions}
      />,
    );
    expect(screen.getByText('Exit plan mode?')).toBeTruthy();
  });
});

const questionItem = (over: Partial<QuestionDisplay['question']> = {}): QuestionDisplay => ({
  kind: 'question',
  seq: 3,
  toolUseId: 'q_1',
  question: {
    entry: {
      entryType: 'system',
      content: 'Which color?',
      timestamp: 't',
      metadata: { special: 'ask_question', tool_use_id: 'q_1' },
    },
    header: 'Color',
    options: [{ label: 'red' }, { label: 'blue' }],
    ...over,
  },
});

describe('QuestionCard', () => {
  it('option tap sends 1-based keypress with context question', () => {
    const r = recorder();
    render(
      <QuestionCard item={questionItem()} sessionId={SESSION} responded={false} actions={r.actions} />,
    );
    fireEvent.click(screen.getByText('blue'));
    expect(r.sent).toEqual([
      { type: 'keypress', sessionId: SESSION, key: '2', context: 'question' },
    ]);
    expect(r.responded).toEqual(['q_1']);
  });

  it('free-text answer goes through question-input with the optionCount', () => {
    const r = recorder();
    render(
      <QuestionCard item={questionItem()} sessionId={SESSION} responded={false} actions={r.actions} />,
    );
    fireEvent.click(screen.getByText('Type your own answer…'));
    fireEvent.change(screen.getByPlaceholderText('Type your answer…'), {
      target: { value: 'chartreuse' },
    });
    fireEvent.click(screen.getByText('Send'));
    expect(r.sent).toEqual([
      { type: 'question-input', sessionId: SESSION, text: 'chartreuse', optionCount: 2 },
    ]);
  });

  it('multi-select sends ONE comma-joined question-input', () => {
    const r = recorder();
    render(
      <QuestionCard
        item={questionItem({
          multiSelect: true,
          options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }],
        })}
        sessionId={SESSION}
        responded={false}
        actions={r.actions}
      />,
    );
    fireEvent.click(screen.getByText('c'));
    fireEvent.click(screen.getByText('a'));
    fireEvent.click(screen.getByText('Send (2)'));
    expect(r.sent).toEqual([
      { type: 'question-input', sessionId: SESSION, text: 'a, c', optionCount: 3 },
    ]);
  });

  it('no options → free-text input directly', () => {
    const r = recorder();
    render(
      <QuestionCard
        item={questionItem({ options: [] })}
        sessionId={SESSION}
        responded={false}
        actions={r.actions}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('Type your answer…'), {
      target: { value: 'free answer' },
    });
    fireEvent.click(screen.getByText('Send'));
    expect(r.sent).toEqual([
      { type: 'question-input', sessionId: SESSION, text: 'free answer', optionCount: 0 },
    ]);
  });

  it('answered card renders the answer content', () => {
    const r = recorder();
    render(
      <QuestionCard
        item={{ ...questionItem(), answered: 'blue' }}
        sessionId={SESSION}
        responded={false}
        actions={r.actions}
      />,
    );
    expect(screen.getByText('blue')).toBeTruthy();
    expect(screen.queryByText('red')).toBeNull();
  });

  it('isFreeTextOption heuristic (ported cases)', () => {
    expect(isFreeTextOption('Something else', 0, 3)).toBe(true);
    expect(isFreeTextOption('Other', 2, 3)).toBe(true);
    expect(isFreeTextOption('Other', 0, 3)).toBe(false);
    expect(isFreeTextOption('red', 0, 2)).toBe(false);
  });
});

describe('QuestionGroupCard', () => {
  const groupItem = (): QuestionGroupDisplay => ({
    kind: 'question_group',
    seq: 4,
    toolUseId: 'grp_1',
    questions: [
      {
        entry: {
          entryType: 'system', content: 'First?', timestamp: 't',
          metadata: { special: 'ask_question', tool_use_id: 'grp_1', question_index: 0, question_count: 2 },
        },
        header: 'One',
        options: [{ label: 'yes' }, { label: 'no' }],
      },
      {
        entry: {
          entryType: 'system', content: 'Second?', timestamp: 't',
          metadata: { special: 'ask_question', tool_use_id: 'grp_1', question_index: 1, question_count: 2 },
        },
        header: 'Two',
        options: [{ label: 'up' }, { label: 'down' }],
      },
    ],
  });

  it('answers the FIRST unanswered question; composite responded ids advance the tab', () => {
    const r = recorder();
    const { rerender } = render(
      <QuestionGroupCard
        item={groupItem()}
        sessionId={SESSION}
        respondedCards={undefined}
        actions={r.actions}
      />,
    );
    expect(screen.getByText('First?')).toBeTruthy();
    fireEvent.click(screen.getByText('no'));
    expect(r.sent).toEqual([
      { type: 'keypress', sessionId: SESSION, key: '2', context: 'question' },
    ]);
    expect(r.responded).toEqual(['grp_1:q0']);

    // Simulate uiStore reactivity: q0 responded → active card is question two.
    rerender(
      <QuestionGroupCard
        item={groupItem()}
        sessionId={SESSION}
        respondedCards={new Set(['grp_1:q0'])}
        actions={r.actions}
      />,
    );
    expect(screen.getByText('Second?')).toBeTruthy();
    fireEvent.click(screen.getByText('up'));
    expect(r.sent[1]).toEqual({ type: 'keypress', sessionId: SESSION, key: '1', context: 'question' });
    expect(r.responded[1]).toBe('grp_1:q1');
  });

  it('all answered locally → completed card', () => {
    const r = recorder();
    render(
      <QuestionGroupCard
        item={groupItem()}
        sessionId={SESSION}
        respondedCards={new Set(['grp_1:q0', 'grp_1:q1'])}
        actions={r.actions}
      />,
    );
    expect(screen.getByText('All responses sent')).toBeTruthy();
  });
});
