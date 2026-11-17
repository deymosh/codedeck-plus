/**
 * `todo`: the model's checklist for the work at hand, written whole each
 * time it changes (the shape Claude Code's TodoWrite taught models). The
 * driver shows it as the phone's checklist rather than as a tool call; the
 * list lives in the conversation itself, in the call's arguments, so a
 * resumed or branched session has the list that was current at that point.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { PI_TOOL } from './protocol';

export const TODO_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

/** The items of a call's arguments that say something; anything else is
 *  dropped rather than shown as a blank row. */
export function todoItems(input: unknown): TodoItem[] {
  const todos = typeof input === 'object' && input !== null ? (input as { todos?: unknown }).todos : undefined;
  if (!Array.isArray(todos)) return [];
  return todos.flatMap((raw): TodoItem[] => {
    const item = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const content = typeof item.content === 'string' ? item.content.trim() : '';
    if (content === '') return [];
    const status = TODO_STATUSES.includes(item.status as TodoStatus) ? (item.status as TodoStatus) : 'pending';
    const activeForm = typeof item.activeForm === 'string' && item.activeForm.trim() !== '' ? item.activeForm.trim() : undefined;
    return [{ content, status, ...(activeForm ? { activeForm } : {}) }];
  });
}

export function registerTodo(pi: Pick<ExtensionAPI, 'registerTool'>): void {
  pi.registerTool({
    name: PI_TOOL.todo,
    label: 'Todo',
    description:
      'Write the checklist for the current task, whole: every item with its status. ' +
      'Use it for work of three steps or more; keep exactly one item in_progress while working, ' +
      'and mark an item completed as soon as it is done.',
    promptSnippet: 'todo: keep a checklist of the current multi-step task',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The whole list, in order.',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'The step, as an instruction ("Run the tests").' },
              status: { type: 'string', enum: [...TODO_STATUSES] },
              activeForm: { type: 'string', description: 'The step while it runs ("Running the tests").' },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    } as never,
    async execute(_toolCallId, params) {
      const items = todoItems(params);
      const count = (status: TodoStatus): number => items.filter((item) => item.status === status).length;
      const text =
        items.length === 0
          ? 'The checklist is empty.'
          : `Checklist updated: ${count('completed')} done, ${count('in_progress')} in progress, ${count('pending')} pending.`;
      return { content: [{ type: 'text', text }], details: { todos: items } };
    },
  });
}
