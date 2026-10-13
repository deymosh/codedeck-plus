/**
 * Helpers every driver uses to describe tool calls in the wire's
 * agent-neutral terms: a tool kind, a one-line title, the files touched, and
 * the standard permission choices.
 */
import type { PermissionOption, TodoItem, ToolKind } from './types';

/**
 * Tool names, by the agent they come from.
 *
 * Every name here belongs to an agent this host runs — Claude Code, OpenCode
 * 2.x or the DeepSeek Harness. A name none of them emits (an older SDK's
 * tool, or one a rename left behind) does not belong: it could only label a
 * row that never appears. Names are matched lower-cased, since these agents
 * spell them differently (`Bash`, `bash`).
 *
 * A name more than one of them uses, meaning the same thing, lives in
 * COMMON_TOOLS; the rest sit with their agent's own tools. When an agent
 * renames a tool, its new name joins its list and the old one leaves — the
 * exceptions are the ones an agent still answers to, like Claude Code's
 * KillShell/KillBash aliases of TaskStop.
 */
const COMMON_TOOLS: Record<string, ToolKind> = {
  read: 'read',
  write: 'edit',
  edit: 'edit',
  glob: 'search',
  grep: 'search',
  webfetch: 'fetch',
  websearch: 'fetch',
  // Claude Code's and the DeepSeek Harness's sub-agent call.
  task: 'agent',
};

const CLAUDE_TOOLS: Record<string, ToolKind> = {
  bash: 'execute',
  bashoutput: 'execute',
  // Stopping a background task. The CLI's own rename map turns KillShell and
  // KillBash into TaskStop, so TaskStop is what arrives; the aliases are kept
  // for a session driven by a CLI that still says them.
  taskstop: 'execute',
  killshell: 'execute',
  killbash: 'execute',
  ls: 'read',
  notebookread: 'read',
  multiedit: 'edit',
  notebookedit: 'edit',
  todowrite: 'think',
  exitplanmode: 'switch_mode',
  enterplanmode: 'switch_mode',
};

const OPENCODE_TOOLS: Record<string, ToolKind> = {
  // 2.x's name for the shell tool; `bash` above is Claude Code's.
  shell: 'execute',
  // Code Mode: running a program, driving a browser, working trees.
  execute: 'execute',
  browser: 'fetch',
  worktree_create: 'execute',
  worktree_remove: 'execute',
  worktree_list: 'read',
  // 2.x's name for the sub-agent call; `task` above is the others'.
  subagent: 'agent',
  patch: 'edit',
  skill: 'read',
  question: 'think',
};

const DEEPSEEK_TOOLS: Record<string, ToolKind> = {
  agent: 'agent',
  pwsh: 'execute',
  job_kill: 'execute',
  str_replace_editor: 'edit',
  todo_write: 'think',
  web_fetch: 'fetch',
  web_search: 'fetch',
  read_image: 'read',
  job_output: 'read',
  job_list: 'read',
  list: 'read',
};

/** Every agent's tools together, which is what a lookup reads. */
const TOOL_KINDS: Record<string, ToolKind> = {
  ...COMMON_TOOLS,
  ...CLAUDE_TOOLS,
  ...OPENCODE_TOOLS,
  ...DEEPSEEK_TOOLS,
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
    case 'shell':
    case 'pwsh':
      return oneLine(str(input.command) || str(input.description));
    case 'read':
    case 'write':
    case 'edit':
    case 'multiedit':
    case 'read_image':
      // OpenCode v2 names a file `path`; v1 and Claude Code `filePath`.
      return str(input.file_path) || str(input.filePath) || str(input.path);
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
    case 'subagent':
    case 'agent': {
      const desc = str(input.description);
      // Claude Code and OpenCode v1 name the sub-agent `subagent_type`;
      // OpenCode v2 names it `agent`.
      const sub = str(input.subagent_type) || str(input.agent);
      return sub ? `${desc} (${sub})` : desc;
    }
    case 'taskstop':
    case 'killshell':
    case 'killbash':
      return str(input.task_id) || str(input.shell_id);
    case 'websearch':
      return str(input.query);
    case 'web_search':
      return Array.isArray(input.queries) ? str(input.queries[0]) : '';
    case 'webfetch':
    case 'web_fetch':
      return str(input.url);
    case 'skill':
      return str(input.name);
    // v2's own tools. A worktree is named by what it is for, and the browser
    // by the page it opens.
    case 'worktree_create':
    case 'worktree_remove':
      return str(input.name) || str(input.branch) || '';
    case 'worktree_list':
      return '';
    case 'browser':
      return str(input.url) || str(input.action) || '';
    case 'execute':
      return oneLine(str(input.code) || str(input.description));
    // The question tool's own row is hidden — its card comes from the form
    // it raises — so this only names the call if a server ever shows it.
    case 'question':
      return oneLine(str(input.title));
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
    // The command a session ran, whole: the title is one line cut to
    // MAX_TITLE_CHARS, so a long command must not have to fall back to it.
    case 'bash':
    case 'shell':
      text = str(input.command);
      break;
    // The instructions a sub-agent was given.
    case 'task':
    case 'subagent':
    case 'agent':
      text = str(input.prompt);
      break;
    // The program a Code Mode call runs.
    case 'execute':
      text = str(input.code);
      break;
    case 'write':
    case 'edit':
    case 'multiedit':
    case 'notebookedit':
    case 'patch':
    case 'todowrite':
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
