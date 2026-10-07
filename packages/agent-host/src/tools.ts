/**
 * Helpers every driver uses to describe tool calls in the wire's
 * agent-neutral terms: a tool kind, a one-line title, the files touched, and
 * the standard permission choices.
 */
import type { PermissionOption, TodoItem, ToolKind } from './types';

const TOOL_KINDS: Record<string, ToolKind> = {
  read: 'read',
  notebookread: 'read',
  list: 'read',
  ls: 'read',
  write: 'edit',
  edit: 'edit',
  multiedit: 'edit',
  notebookedit: 'edit',
  patch: 'edit',
  bash: 'execute',
  bashoutput: 'execute',
  killshell: 'execute',
  killbash: 'execute',
  glob: 'search',
  grep: 'search',
  codesearch: 'search',
  webfetch: 'fetch',
  websearch: 'fetch',
  todowrite: 'think',
  todoread: 'think',
  exitplanmode: 'switch_mode',
  enterplanmode: 'switch_mode',
  task: 'agent',
  agent: 'agent',
  // The DeepSeek Harness's own tools.
  pwsh: 'execute',
  str_replace_editor: 'edit',
  todo_write: 'think',
  web_fetch: 'fetch',
  web_search: 'fetch',
  read_image: 'read',
  skill: 'read',
  job_output: 'read',
  job_list: 'read',
  job_kill: 'execute',
};

/** Normalize an agent's tool name (Claude Code's `Bash`, OpenCode's `bash`)
 *  to the wire's tool kind. */
export function toolKindOf(toolName: string): ToolKind {
  return TOOL_KINDS[toolName.toLowerCase()] ?? 'other';
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** A title is one line: a multi-line command (a heredoc, a script) shows its
 *  first line, and the whole command travels as the call's `input`. */
const MAX_TITLE_CHARS = 200;

function oneLine(text: string): string {
  const first = text.split('\n', 1)[0]!.trimEnd();
  const cut = first.length > MAX_TITLE_CHARS ? first.slice(0, MAX_TITLE_CHARS) : first;
  return cut.length < text.trimEnd().length ? `${cut}…` : cut;
}

/** One-line human summary of a tool call, e.g. `npm test` or `src/main.rs`. */
export function toolTitle(toolName: string, input: Record<string, unknown>): string {
  switch (toolName.toLowerCase()) {
    case 'bash':
    case 'pwsh':
      return oneLine(str(input.command) || str(input.description));
    case 'read':
    case 'write':
    case 'edit':
    case 'multiedit':
    case 'read_image':
      return str(input.file_path) || str(input.filePath);
    case 'notebookedit':
      return str(input.notebook_path) || str(input.file_path);
    // The DeepSeek Harness's editor names its file `path`; its `command`
    // (view, create, str_replace, insert) says what the call does.
    case 'str_replace_editor':
      return `${str(input.command)} ${str(input.path)}`.trim();
    case 'glob':
    case 'grep':
      return str(input.pattern);
    case 'task':
    case 'agent': {
      const desc = str(input.description);
      const sub = str(input.subagent_type);
      return sub ? `${desc} (${sub})` : desc;
    }
    case 'websearch':
      return str(input.query);
    case 'web_search':
      return Array.isArray(input.queries) ? str(input.queries[0]) : '';
    case 'webfetch':
    case 'web_fetch':
      return str(input.url);
    case 'skill':
      return str(input.name);
    default:
      return JSON.stringify(input ?? {}).slice(0, MAX_TITLE_CHARS);
  }
}

/** A call's `input` is capped like a tool result: enough to read, well
 *  inside a relay event. */
export const MAX_TOOL_INPUT_CHARS = 4000;

/**
 * The call's whole input as a person reads it, when it says more than its
 * title: the full command, a sub-agent's instructions, any other tool's
 * arguments as indented JSON. `undefined` for a file change — its diff
 * entry already carries the content — and when the title says it all.
 */
export function toolInput(toolName: string, input: Record<string, unknown>): string | undefined {
  const title = toolTitle(toolName, input);
  let text: string;
  switch (toolName.toLowerCase()) {
    case 'bash':
      text = str(input.command);
      break;
    case 'task':
    case 'agent':
      text = str(input.prompt);
      break;
    case 'write':
    case 'edit':
    case 'multiedit':
    case 'notebookedit':
    case 'patch':
    case 'apply_patch':
    case 'todowrite':
    case 'todoread':
    case 'todo_write':
    case 'str_replace_editor':
      return undefined;
    default: {
      const keys = Object.keys(input ?? {});
      // A lone argument is the title already (a path, a pattern, a URL).
      if (keys.length <= 1) return undefined;
      text = JSON.stringify(input, null, 2);
    }
  }
  if (!text || text === title) return undefined;
  return text.length > MAX_TOOL_INPUT_CHARS ? text.slice(0, MAX_TOOL_INPUT_CHARS) + '…' : text;
}

const TODO_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed', 'cancelled']);

/**
 * The checklist a todo tool writes (Claude Code's `TodoWrite`, OpenCode's
 * `todowrite`: `todos: [{content, status, activeForm?}]`), or `null` when
 * the input holds none. An item with an unknown status counts as pending.
 */
export function todosOf(input: Record<string, unknown>): TodoItem[] | null {
  if (!Array.isArray(input.todos)) return null;
  const items: TodoItem[] = [];
  for (const raw of input.todos as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue;
    const todo = raw as Record<string, unknown>;
    const text = str(todo.content);
    if (!text) continue;
    const status = str(todo.status);
    const active = str(todo.activeForm);
    items.push({
      text,
      status: (TODO_STATUSES.has(status) ? status : 'pending') as TodoItem['status'],
      ...(active && active !== text ? { activeText: active } : {}),
    });
  }
  return items;
}

/** The files a tool call touches, when its input names them. */
export function toolLocations(input: Record<string, unknown>): string[] {
  const path = str(input.file_path) || str(input.filePath) || str(input.notebook_path);
  return path ? [path] : [];
}

export const PERMISSION_ALLOW: PermissionOption = { id: 'allow', label: 'Allow', kind: 'allow_once' };
export const PERMISSION_ALLOW_ALWAYS: PermissionOption = {
  id: 'allow_always',
  label: 'Always allow',
  kind: 'allow_always',
};
export const PERMISSION_DENY: PermissionOption = { id: 'deny', label: 'Deny', kind: 'reject_once' };

/** Current time as a transcript timestamp. */
export function now(): string {
  return new Date().toISOString();
}
