/**
 * `ask`: structured questions to the user — up to four, each with options to
 * choose from or free text — shown on the phone as a question card. A
 * question with choices is answered in a tap, which is what makes asking
 * worth it from a phone rather than guessing.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { request } from './channel';
import { PI_TOOL, type PiAnswer, type PiAskReply, type PiQuestion } from './protocol';

const MAX_QUESTIONS = 4;

/** The questions of a call's arguments that ask something. */
export function askQuestions(input: unknown): PiQuestion[] {
  const questions = typeof input === 'object' && input !== null ? (input as { questions?: unknown }).questions : undefined;
  if (!Array.isArray(questions)) return [];
  return questions.slice(0, MAX_QUESTIONS).flatMap((raw): PiQuestion[] => {
    const q = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const question = typeof q.question === 'string' ? q.question.trim() : '';
    if (question === '') return [];
    const options = (Array.isArray(q.options) ? q.options : []).flatMap((rawOption) => {
      const option = typeof rawOption === 'object' && rawOption !== null ? (rawOption as Record<string, unknown>) : {};
      const label = typeof option.label === 'string' ? option.label.trim() : '';
      if (label === '') return [];
      const description = typeof option.description === 'string' && option.description.trim() !== '' ? option.description.trim() : undefined;
      return [{ label, ...(description ? { description } : {}) }];
    });
    const header = typeof q.header === 'string' && q.header.trim() !== '' ? q.header.trim() : undefined;
    return [
      {
        question,
        ...(header ? { header } : {}),
        ...(options.length > 0 ? { options } : {}),
        ...(q.multiSelect === true && options.length > 0 ? { multiSelect: true } : {}),
      },
    ];
  });
}

function answerText(answer: PiAnswer | undefined): string {
  if (answer === undefined || 'skipped' in answer) return '(no answer)';
  if ('selected' in answer) return answer.selected.join(', ');
  return answer.text;
}

export function registerAsk(pi: Pick<ExtensionAPI, 'registerTool'>): void {
  pi.registerTool({
    name: PI_TOOL.ask,
    label: 'Ask',
    description:
      'Ask the user up to four questions and wait for the answers. Offer options when the answer is a choice ' +
      '(the user can still type their own); use it when a decision is theirs, not to confirm what you can check yourself.',
    promptSnippet: 'ask: ask the user questions with options to choose from',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_QUESTIONS,
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              header: { type: 'string', description: 'A short label for the question (a few words).' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { label: { type: 'string' }, description: { type: 'string' } },
                  required: ['label'],
                },
              },
              multiSelect: { type: 'boolean', description: 'Whether several options may be chosen.' },
            },
            required: ['question'],
          },
        },
      },
      required: ['questions'],
    } as never,
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const questions = askQuestions(params);
      if (questions.length === 0) throw new Error('ask needs at least one question');
      const reply = await request<PiAskReply>(ctx.ui, { op: 'ask', callId: toolCallId, questions });
      if (!reply || !Array.isArray(reply.answers)) throw new Error('The user did not answer.');
      // One line per question, the answer first after its question.
      const text = questions.map((q, i) => `The user answered "${q.question}": ${answerText(reply.answers[i])}`).join('\n');
      return { content: [{ type: 'text', text }], details: { answers: reply.answers } };
    },
  });
}
