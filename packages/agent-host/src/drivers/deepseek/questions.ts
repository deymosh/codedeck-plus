/**
 * The questions the harness's model asks, on their way to the phone and back.
 *
 * The harness has a `user-questions` service, and everything that needs the
 * user asks through it: the model's question tool, its timed form, and the
 * plan review `exit_plan_mode` presents. Its answerer is a UI panel in the
 * harness's own apps; in the automation profile there is none, so the ask
 * fails with "no user-questions answerer configured". Our plugin composes one
 * (plugin.ts), which pushes the ask to the host over stderr and waits for the
 * answer on its socket.
 *
 * This module is the host's half: what a pushed ask becomes on the phone
 * (`QuestionSpec` for a question, a plan and an approval for a plan review),
 * and what the phone's answer becomes for the harness. Both are the harness's
 * own shapes (its `AskUserQuestionItem` and `AskUserQuestionAnswer`), which is
 * what makes the round trip exact: option labels are what a selected answer
 * carries, and free text is what a typed one does.
 */
import type { QuestionSpec } from '../../sdk/types';

/** One question as the plugin pushes it. */
export interface PushedQuestion {
  id: string;
  question: string;
  header?: string;
  detail?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  /** What the ask is for, when the harness says. A plan review declares
   *  `{kind: 'plan-review', approve: <label>}`: the label that means the user
   *  approved, and the one answer the tool acts on. */
  intent?: { kind?: string; approve?: string };
}

/** One line the plugin pushed, once parsed. */
export interface PushedQuestionLine {
  sessionId?: string;
  callId: string;
  questions: PushedQuestion[];
}

/**
 * Parse one pushed line, or `undefined` when it is not one (the marker is how
 * a question is told apart from the harness's own stderr). The remainder after
 * the marker is JSON the plugin wrote.
 */
export function parseQuestionLine(line: string, marker: string): PushedQuestionLine | undefined {
  const at = line.indexOf(marker);
  if (at < 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(line.slice(at + marker.length).trim());
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { callId, sessionId, questions } = parsed as { callId?: unknown; sessionId?: unknown; questions?: unknown };
    if (typeof callId !== 'string' || !Array.isArray(questions)) return undefined;
    return {
      callId,
      ...(typeof sessionId === 'string' ? { sessionId } : {}),
      questions: questions.map(toPushed).filter((question): question is PushedQuestion => question !== undefined),
    };
  } catch {
    return undefined;
  }
}

function toPushed(raw: unknown): PushedQuestion | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== 'string' || typeof item.question !== 'string') return undefined;
  const options = Array.isArray(item.options)
    ? item.options
        .map((option) =>
          typeof option === 'object' && option !== null && typeof (option as { label?: unknown }).label === 'string'
            ? {
                label: (option as { label: string }).label,
                ...(typeof (option as { description?: unknown }).description === 'string'
                  ? { description: (option as { description: string }).description }
                  : {}),
              }
            : undefined,
        )
        .filter((option): option is { label: string; description?: string } => option !== undefined)
    : undefined;
  const intent = record(item.intent);
  return {
    id: item.id,
    question: item.question,
    ...(typeof item.header === 'string' && item.header !== '' ? { header: item.header } : {}),
    ...(typeof item.detail === 'string' && item.detail !== '' ? { detail: item.detail } : {}),
    ...(options && options.length > 0 ? { options } : {}),
    ...(item.multiSelect === true ? { multiSelect: true } : {}),
    ...(intent === undefined ? {} : { intent }),
  };
}

/** An `intent` as far as this side reads it: the kind and the approval label. */
function record(value: unknown): { kind?: string; approve?: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const kind = typeof raw.kind === 'string' ? raw.kind : undefined;
  const approve = typeof raw.approve === 'string' ? raw.approve : undefined;
  if (kind === undefined && approve === undefined) return undefined;
  return { ...(kind === undefined ? {} : { kind }), ...(approve === undefined ? {} : { approve }) };
}

/**
 * A plan review, which is the harness's `exit_plan_mode` asking through the
 * same service the question tool uses: the plan is one question's detail, and
 * its options are the verdicts the tool knows — approve, or keep planning.
 * `undefined` for a plain question, and for a plan review the plan itself
 * arrived without, which is then an ordinary question.
 */
export interface PlanReview {
  /** The question's own id, echoed back with the verdict. */
  id: string;
  plan: string;
  options: Array<{ id: string; label: string; description?: string }>;
  /** The option that keeps the model planning — anything but the approval
   *  the intent declares. The harness takes the user's feedback with it, as
   *  the answer's free text. */
  revise?: string;
}

export function planReviewOf(questions: PushedQuestion[]): PlanReview | undefined {
  const question = questions.find((item) => item.intent?.kind === 'plan-review');
  if (question === undefined || question.detail === undefined) return undefined;
  const options = (question.options ?? []).map((option) => ({
    // The label is the option id: the harness reads the verdict as the label
    // of the option that was chosen.
    id: option.label,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
  }));
  if (options.length === 0) return undefined;
  const approve = question.intent?.approve;
  const revise = approve === undefined ? undefined : options.find((option) => option.id !== approve)?.id;
  return { id: question.id, plan: question.detail, options, ...(revise === undefined ? {} : { revise }) };
}

/**
 * What the phone shows: the harness's questions in the wire's shape. The
 * question's own detail travels with the text, because a phone card shows one
 * body (the same way a plan's or a tool's detail does).
 */
export function toQuestionSpecs(questions: PushedQuestion[]): QuestionSpec[] {
  return questions.map((question) => ({
    question: question.detail ? `${question.question}\n\n${question.detail}` : question.question,
    ...(question.header ? { header: question.header } : {}),
    options: (question.options ?? []).map((option) => ({
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
    })),
    ...(question.multiSelect ? { multiSelect: true } : {}),
  }));
}

/**
 * The phone's answers as the harness takes them: one item per question, keyed
 * by the question's id. The phone answers with one string per question; a
 * multi-select arrives as its labels joined by ", ", and is split into them
 * only when every piece is one of the offered labels — anything else is what
 * the user typed, which the harness takes as custom text.
 */
export function toAnswerItems(
  questions: PushedQuestion[],
  answers: string[],
): Array<{ id: string; selected: string[]; custom?: string }> {
  return questions.map((question, index) => {
    const raw = answers[index] ?? '';
    if (raw === '') return { id: question.id, selected: [] };
    if (question.multiSelect) {
      const labels = new Set((question.options ?? []).map((option) => option.label));
      const pieces = raw.split(', ');
      if (pieces.length > 0 && pieces.every((piece) => labels.has(piece))) return { id: question.id, selected: pieces };
      return { id: question.id, selected: [], custom: raw };
    }
    const labels = new Set((question.options ?? []).map((option) => option.label));
    return labels.has(raw) ? { id: question.id, selected: [raw] } : { id: question.id, selected: [], custom: raw };
  });
}
