/**
 * Helpers every driver uses to describe tool calls in the wire's
 * agent-neutral terms: a tool kind, a one-line title, the input a sheet
 * shows, the files touched, and the standard permission choices.
 *
 * What a tool's name means belongs to the agent that emits it, in
 * `drivers/<agent>/tools.ts`: the same name can mean different things to two
 * agents, and a rename then touches one driver's own file rather than a
 * shared table every driver reads. This module holds what is the same for
 * all of them — the kind vocabulary, the reading of a call's arguments, and
 * the caps every entry travels under.
 */
import type { PermissionOption, TodoItem, ToolKind as ToolKindName } from './types';

/**
 * The wire's tool kinds, as values, so a driver names one instead of spelling
 * the string: `ToolKind.Read` is checked against the protocol, a literal
 * `'raed'` is not.
 *
 * `satisfies` holds each value to a kind the wire actually has;
 * `__tests__/tools.test.ts` holds the other direction, reading the wire's own
 * union out of `generated/protocol.ts` and failing on a kind this object does
 * not name.
 */
export const ToolKind = {
  Read: 'read',
  Edit: 'edit',
  Delete: 'delete',
  Move: 'move',
  Search: 'search',
  Execute: 'execute',
  Think: 'think',
  Fetch: 'fetch',
  SwitchMode: 'switch_mode',
  Agent: 'agent',
  Other: 'other',
} as const satisfies Record<string, ToolKindName>;

/** The kind vocabulary, under the name it has on the wire. */
export type ToolKind = ToolKindName;

/** One agent's tool call: the kind the phone groups by, and how to read a
 *  call's own arguments. */
export interface ToolDialect {
  kind: ToolKind;
  /** The call's one-line title, from its arguments. A tool whose name is all
   *  there is to say leaves this out, and the name is shown. */
  title?: (input: Record<string, unknown>) => string;
  /** The arguments as the sheet shows them, when they say more than the
   *  title. `undefined` for a call whose entry is already the title, and for
   *  a file change, whose diff entry carries the content. Absent: the
   *  arguments as JSON, unless there is only one (the title already is it). */
  detail?: (input: Record<string, unknown>) => string | undefined;
}

/** One agent's tool names, which is what its reader answers from. */
export type ToolDialects = Record<string, ToolDialect>;

/** What a driver derives for one tool call: the kind, the title the phone
 *  shows, and — when it says more than the title — the call's whole input. */
export interface ToolCallRead {
  kind: ToolKind;
  title: string;
  input?: string;
}

/** Whether a tool belongs to an MCP server the user configured rather than
 *  to the agent itself. Its name comes from that server, so no table here can
 *  list it — and a name this host has never seen is normal for one. */
function isMcpTool(toolName: string): boolean {
  return toolName.toLowerCase().startsWith('mcp__');
}

/**
 * A reporter for tool names no agent's table knows, to be handed a driver's
 * log seam.
 *
 * A name that is missing here is either a tool an agent renamed (its calls
 * then reach the phone as generic actions, with the tool's raw arguments as
 * their text) or one this host has never seen at all. Either way it belongs
 * in the log of the session that used it, where the next reader can see it,
 * rather than only in what the phone renders. Each name is reported once per
 * session — and per name, not per call, since a tool is used many times.
 */
export function unknownToolReporter(log: (message: string) => void): (toolName: string) => void {
  const reported = new Set<string>();
  return (toolName) => {
    // An MCP name says its own server owns it; the agent's tables are not
    // expected to know it.
    if (isMcpTool(toolName)) return;
    const key = toolName.toLowerCase();
    if (reported.has(key)) return;
    reported.add(key);
    log(
      `unknown tool name '${toolName}': no agent's tool table lists it, so its calls show as generic actions`
        + ' (a tool an agent renamed, or one of an MCP server\'s own)',
    );
  };
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** A title is one line: a multi-line command (a heredoc, a script) shows its
 *  first line, and the whole command travels as the call's `input`. */
export const MAX_TITLE_CHARS = 200;

export function oneLine(text: string): string {
  const first = text.split('\n', 1)[0]!.trimEnd();
  const cut = first.length > MAX_TITLE_CHARS ? first.slice(0, MAX_TITLE_CHARS) : first;
  return cut.length < text.trimEnd().length ? `${cut}…` : cut;
}

/** A call's `input` is capped like a tool result: enough to read, well
 *  inside a relay event. */
export const MAX_TOOL_INPUT_CHARS = 4000;

function capped(text: string): string {
  return text.length > MAX_TOOL_INPUT_CHARS ? text.slice(0, MAX_TOOL_INPUT_CHARS) + '…' : text;
}

/** The arguments as a person reads them: indented JSON, or nothing when the
 *  one argument is the title already (a path, a pattern, a URL). */
function argumentsAsJson(input: Record<string, unknown>): string | undefined {
  return Object.keys(input ?? {}).length <= 1 ? undefined : JSON.stringify(input, null, 2);
}

/**
 * Read one tool call of one agent: its kind, the title the phone shows, and
 * the call's whole input when it says more than the title.
 *
 * A name the agent's own table does not list is read as `other`, keeping the
 * tool's own name and its arguments rather than guessing at either — the
 * kind is what the phone picks an icon and a verb from, so a wrong guess
 * would read as a confident lie about what the call did. `report` is told
 * such a name (`unknownToolReporter`), which is how a rename stops being
 * silent.
 */
export function readToolCall(
  dialects: ToolDialects,
  toolName: string,
  input: Record<string, unknown>,
  report?: (toolName: string) => void,
): ToolCallRead {
  const dialect = dialects[toolName.toLowerCase()];
  if (dialect === undefined) {
    report?.(toolName);
    const title = oneLine(toolName);
    const args = Object.keys(input ?? {}).length > 0 ? JSON.stringify(input, null, 2) : '';
    return { kind: ToolKind.Other, title, ...(args ? { input: capped(args) } : {}) };
  }
  const title = oneLine(dialect.title?.(input ?? {}) ?? '') || toolName;
  const detail = dialect.detail ? dialect.detail(input ?? {}) : argumentsAsJson(input ?? {});
  // The input is what the sheet shows *besides* the title, so a call that
  // says no more than its title carries none: no second copy of it travels.
  return {
    kind: dialect.kind,
    title,
    ...(detail && detail !== title ? { input: capped(detail) } : {}),
  };
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

/** The files a tool call touches, when its input names them: Claude Code and
 *  the DeepSeek Harness say `file_path`, OpenCode v2 `path`, and a notebook
 *  has a path of its own. */
export function toolLocations(input: Record<string, unknown>): string[] {
  const path = str(input.file_path) || str(input.filePath) || str(input.path) || str(input.notebook_path);
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
