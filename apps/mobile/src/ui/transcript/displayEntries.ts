/**
 * displayEntries — pure transform from the flat transcript (seq + OutputEntry)
 * to grouped display items, one per rendered row.
 *
 * Ported from the old app's useDisplayEntries (the good part — grouping and
 * answered-state detection), rebuilt on the v10 @codedeck/protocol entry
 * vocabulary, which is what the bridge actually produces (sdkMessageToEntries
 * + the runner/broker out-of-band entries):
 *
 * - text  role=user                          → user message bubble
 * - text  role=assistant (display_hint)      → assistant markdown, or absorbed
 *                                              into a tool group on 'collapse'
 * - text  special='plan'                     → plan markdown (stays visible)
 * - tool_use / tool_result / progress
 *   / thinking                               → collapsed "N actions" group
 * - system special='plan_approval'           → plan approval card
 * - system special='ask_question'            → question card (grouped by
 *                                              tool_use_id for multi-question)
 * - system special='permission_request'      → permission card
 * - system special='session_restart'         → lifecycle marker
 * - error  (special session_died/session_failed/auth_error or generic)
 * - system (init banner, token counts, result summaries → filtered out;
 *           stream_end markers → filtered out; the rest are status lines)
 *
 * CDX-085: thinking used to get a collapsed row of its OWN, so a turn rendered
 * as an alternating stack — `Thinking`, `4 actions`, `Thinking`, `2 actions` —
 * four rows of chrome for one turn. Reasoning is part of what the turn did, so
 * it is absorbed into the group and counted with the rest. There is no longer a
 * `thinking` display kind; a lone thinking step reads as "1 action".
 *
 * - diff                                     → colored diff card (CDX-050:
 *                                              filename header + +/− lines;
 *                                              rendered standalone, never
 *                                              absorbed into a tool group —
 *                                              the point is to be visible)
 *
 * Answered-state detection: a tool_result whose tool_use_id matches a card's
 * id means the card was resolved — resolved cards render the outcome inline.
 */
import type { OutputEntry } from '@codedeck/protocol';

export interface SeqEntry {
  seq: number;
  entry: OutputEntry;
}

interface DisplayBase {
  /** Stable key: seq of the first entry making up this display item. */
  seq: number;
}

export interface UserMessageDisplay extends DisplayBase {
  kind: 'user_message';
  entry: OutputEntry;
}

export interface AssistantMessageDisplay extends DisplayBase {
  kind: 'assistant_message';
  entry: OutputEntry;
  /** True for special='plan' entries (plan markdown). */
  isPlan?: boolean;
}

export interface ToolGroupDisplay extends DisplayBase {
  kind: 'tool_group';
  entries: SeqEntry[];
  summary: string;
}

export interface DiffDisplay extends DisplayBase {
  kind: 'diff';
  entry: OutputEntry;
}

export interface ErrorDisplay extends DisplayBase {
  kind: 'error';
  entry: OutputEntry;
}

export interface SystemDisplay extends DisplayBase {
  kind: 'system';
  entry: OutputEntry;
}

export interface LifecycleDisplay extends DisplayBase {
  kind: 'lifecycle';
  entry: OutputEntry;
}

export interface PlanApprovalDisplay extends DisplayBase {
  kind: 'plan_approval';
  entry: OutputEntry;
  toolUseId?: string;
  hasPlan: boolean;
  /** Set when a matching tool_result proves the card was resolved. */
  answered?: string;
}

export interface QuestionSpecView {
  entry: OutputEntry;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export interface QuestionDisplay extends DisplayBase {
  kind: 'question';
  toolUseId?: string;
  question: QuestionSpecView;
  answered?: string;
}

export interface QuestionGroupDisplay extends DisplayBase {
  kind: 'question_group';
  toolUseId: string;
  questions: QuestionSpecView[];
  answered?: string;
}

export interface PermissionRequestDisplay extends DisplayBase {
  kind: 'permission_request';
  entry: OutputEntry;
  toolName: string;
  description: string;
  requestId: string;
  isSubAgent: boolean;
  agentLabel?: string;
  /** Set when a matching tool_result proves the request was resolved. */
  answered?: string;
}

export type DisplayEntry =
  | UserMessageDisplay
  | AssistantMessageDisplay
  | ToolGroupDisplay
  | DiffDisplay
  | ErrorDisplay
  | SystemDisplay
  | LifecycleDisplay
  | PlanApprovalDisplay
  | QuestionDisplay
  | QuestionGroupDisplay
  | PermissionRequestDisplay;

/**
 * CDX-085: `thinking` is one of these. A turn used to render as an alternating
 * stack — `Thinking`, `4 actions`, `Thinking`, `2 actions` — four rows of
 * chrome for one turn's work, which is what the founder was looking at. Model
 * reasoning IS part of what the turn did, so it groups and it counts.
 *
 * `diff` deliberately stays OUT (it flushes the group and renders standalone —
 * the point of a diff card is to be seen). Do not generalise this set.
 */
const ACTION_ENTRY_TYPES = new Set<OutputEntry['entryType']>([
  'tool_use',
  'tool_result',
  'progress',
  'thinking',
]);

function isActionEntry(entry: OutputEntry): boolean {
  return ACTION_ENTRY_TYPES.has(entry.entryType);
}

/** Assistant text accompanying tool calls collapses into the tool group. */
function shouldCollapseText(entry: OutputEntry): boolean {
  if (entry.metadata?.special) return false;
  if (entry.entryType !== 'text') return false;
  if (entry.metadata?.role === 'user') return false;
  return entry.metadata?.display_hint === 'collapse';
}

/** Per-turn metadata noise the transcript hides (ported filter). */
export function isHiddenSystemEntry(entry: OutputEntry): boolean {
  if (entry.entryType !== 'system') return false;
  if (entry.metadata?.special) return false;
  if (entry.metadata?.stream_end) return true;
  const t = entry.content;
  return t === ''
    || t.startsWith('Claude Code')
    || t.startsWith('Session complete')
    || t.startsWith('Tokens:');
}

/**
 * The count is of ACTIONS, not of absorbed entries — a `display_hint:'collapse'`
 * assistant text rides along in `entries` without being an action of its own.
 * CDX-085 added thinking steps to what counts; the rest of the tally is
 * deliberately unchanged from what the founder was already reading.
 */
function buildToolSummary(entries: SeqEntry[]): string {
  const count = entries.filter((e) => isActionEntry(e.entry)).length;
  return `${count} action${count !== 1 ? 's' : ''}`;
}

/** tool_use_id → answering tool_result content (resolved-card detection). */
export function collectAnsweredToolUseIds(entries: SeqEntry[]): Map<string, string> {
  const answered = new Map<string, string>();
  for (const { entry } of entries) {
    if (entry.entryType !== 'tool_result') continue;
    const id = entry.metadata?.tool_use_id as string | undefined;
    if (id) answered.set(id, entry.content);
  }
  return answered;
}

export function buildDisplayEntries(source: SeqEntry[]): DisplayEntry[] {
  const entries = source.filter((e) => !isHiddenSystemEntry(e.entry));
  const display: DisplayEntry[] = [];
  const answeredMap = collectAnsweredToolUseIds(source);

  let toolGroup: SeqEntry[] = [];
  let toolGroupSeq = 0;

  let questions: QuestionSpecView[] = [];
  let questionToolUseId: string | null = null;
  let questionSeq = 0;

  const flushToolGroup = (): void => {
    if (toolGroup.length === 0) return;
    display.push({
      kind: 'tool_group',
      entries: toolGroup,
      summary: buildToolSummary(toolGroup),
      seq: toolGroupSeq,
    });
    toolGroup = [];
  };

  const flushQuestionGroup = (): void => {
    if (questions.length === 0) return;
    const toolUseId = questionToolUseId ?? undefined;
    const answered = toolUseId ? answeredMap.get(toolUseId) : undefined;
    const expected = questions[0]!.entry.metadata?.question_count as number | undefined;
    const isMulti = expected != null ? expected > 1 : questions.length > 1;
    if (!isMulti) {
      display.push({
        kind: 'question',
        ...(toolUseId !== undefined ? { toolUseId } : {}),
        question: questions[0]!,
        seq: questionSeq,
        ...(answered !== undefined ? { answered } : {}),
      });
    } else {
      // Robust against out-of-order delivery: sort by question_index.
      const sorted = [...questions].sort((a, b) => {
        const ai = (a.entry.metadata?.question_index as number) ?? 0;
        const bi = (b.entry.metadata?.question_index as number) ?? 0;
        return ai - bi;
      });
      display.push({
        kind: 'question_group',
        toolUseId: toolUseId ?? String(questionSeq),
        questions: sorted,
        seq: questionSeq,
        ...(answered !== undefined ? { answered } : {}),
      });
    }
    questions = [];
    questionToolUseId = null;
  };

  for (const item of entries) {
    const { seq, entry } = item;

    if (isActionEntry(entry)) {
      flushQuestionGroup();
      if (toolGroup.length === 0) toolGroupSeq = seq;
      toolGroup.push(item);
      continue;
    }
    if (shouldCollapseText(entry)) {
      if (toolGroup.length === 0) toolGroupSeq = seq;
      toolGroup.push(item);
      continue;
    }
    flushToolGroup();

    const special = entry.metadata?.special as string | undefined;
    const toolUseId = entry.metadata?.tool_use_id as string | undefined;

    if (special === 'ask_question') {
      if (questionToolUseId !== null && toolUseId !== questionToolUseId) flushQuestionGroup();
      if (questions.length === 0) {
        questionSeq = seq;
        questionToolUseId = toolUseId ?? null;
      }
      questions.push({
        entry,
        header: entry.metadata?.header as string | undefined,
        options: entry.metadata?.options as QuestionSpecView['options'],
        multiSelect: entry.metadata?.multiSelect as boolean | undefined,
      });
      continue;
    }
    flushQuestionGroup();

    if (special === 'plan') {
      display.push({ kind: 'assistant_message', entry, seq, isPlan: true });
      continue;
    }
    if (special === 'plan_approval') {
      const answered = toolUseId ? answeredMap.get(toolUseId) : undefined;
      display.push({
        kind: 'plan_approval',
        entry,
        seq,
        ...(toolUseId !== undefined ? { toolUseId } : {}),
        hasPlan: entry.metadata?.has_plan !== false,
        ...(answered !== undefined ? { answered: 'Plan approved' } : {}),
      });
      continue;
    }
    if (special === 'permission_request') {
      const answered = toolUseId ? answeredMap.get(toolUseId) : undefined;
      display.push({
        kind: 'permission_request',
        entry,
        seq,
        toolName: (entry.metadata?.tool_name as string) ?? '',
        description: (entry.metadata?.description as string) || entry.content,
        requestId: toolUseId ?? '',
        isSubAgent: !!entry.metadata?.subagent,
        ...(entry.metadata?.agent_label !== undefined
          ? { agentLabel: entry.metadata.agent_label as string }
          : {}),
        ...(answered !== undefined ? { answered } : {}),
      });
      continue;
    }
    if (special === 'session_restart') {
      display.push({ kind: 'lifecycle', entry, seq });
      continue;
    }

    switch (entry.entryType) {
      case 'text':
        display.push(
          entry.metadata?.role === 'user'
            ? { kind: 'user_message', entry, seq }
            : { kind: 'assistant_message', entry, seq },
        );
        break;
      // 'thinking' never reaches here — isActionEntry absorbs it into the
      // group above (CDX-085). A lone thinking step therefore reads as
      // "1 action", which is the one rule rather than two.
      case 'diff':
        display.push({ kind: 'diff', entry, seq });
        break;
      case 'error':
        display.push({ kind: 'error', entry, seq });
        break;
      case 'system':
        display.push({ kind: 'system', entry, seq });
        break;
      default:
        display.push({ kind: 'assistant_message', entry, seq });
    }
  }

  flushQuestionGroup();
  flushToolGroup();
  return display;
}

export interface PendingPermissionSummary {
  requestId: string;
  toolName: string;
  description: string;
  isSubAgent: boolean;
  agentLabel?: string;
}

/**
 * Latest still-pending permission request (no answering tool_result, not
 * optimistically responded). Drives the always-visible bar above the input —
 * an inline card buried under a collapsed sub-agent group is exactly how a
 * permission prompt goes unseen and deadlocks the session (ported).
 */
export function findPendingPermission(
  source: SeqEntry[],
  respondedCards: ReadonlySet<string> | undefined,
): PendingPermissionSummary | null {
  if (source.length === 0) return null;
  const answered = collectAnsweredToolUseIds(source);
  for (let i = source.length - 1; i >= 0; i--) {
    const entry = source[i]!.entry;
    if (entry.metadata?.special !== 'permission_request') continue;
    const toolUseId = entry.metadata?.tool_use_id as string | undefined;
    if (!toolUseId) continue;
    if (answered.has(toolUseId) || respondedCards?.has(toolUseId)) continue;
    return {
      requestId: toolUseId,
      toolName: (entry.metadata?.tool_name as string) ?? '',
      description: (entry.metadata?.description as string) || entry.content,
      isSubAgent: !!entry.metadata?.subagent,
      ...(entry.metadata?.agent_label !== undefined
        ? { agentLabel: entry.metadata.agent_label as string }
        : {}),
    };
  }
  return null;
}
