/**
 * Helpers every driver uses to describe tool calls in the wire's
 * agent-neutral terms: a tool kind, a one-line title, the input a sheet
 * shows, the files touched, and the standard permission choices.
 *
 * What a tool's name means belongs to the agent that emits it, in
 * `drivers/<agent>/tools.ts`: the same name can mean different things to two
 * agents, and a rename then touches one driver's own file rather than a
 * shared table every driver reads. This module holds what is the same for
 * all of them — the kind vocabulary, the patterns a call's own arguments
 * declare, and the caps every entry travels under.
 *
 * A call's kind comes from its arguments first and its name second, and how
 * the call is shown the other way around: see `readToolCall`.
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

type Input = Record<string, unknown>;

/** Whether a call carries this argument as a non-empty string. */
function has(input: Input, key: string): boolean {
  const value = input[key];
  return typeof value === 'string' && value !== '';
}

/** Whether a call carries any of these arguments as a non-empty string. */
function hasAny(input: Input, keys: readonly string[]): boolean {
  return keys.some((key) => has(input, key));
}

/** The file a call names, under any of the spellings these agents use:
 *  Claude Code and the DeepSeek Harness say `file_path`, OpenCode v2 `path`,
 *  and a notebook has a path of its own. */
function callPath(input: Input): string {
  return str(input.file_path) || str(input.filePath) || str(input.path) || str(input.notebook_path);
}

/** The arguments that put new text in a file — the whole file (`content`,
 *  `file_text`, `new_source`), or the part being replaced. Every agent's
 *  editor spells some of them differently: `old_string` and `oldString` for
 *  Claude Code, OpenCode v2 and the harness's own editor, `old_str` for the
 *  editor tool the harness also ships. */
const EDIT_TEXT_KEYS = ['old_string', 'oldString', 'old_str', 'new_string', 'newString', 'new_str', 'content', 'file_text', 'new_source', 'edits'] as const;

/** A call's arguments, as the patterns they can declare. Each reads the whole
 *  call — the kind the phone groups by, the title, and the text a sheet shows
 *  under it — because all three come from the same values. */
interface CallPattern {
  kind: ToolKind;
  matches: (input: Input) => boolean;
  title: (input: Input) => string;
  detail?: (input: Input) => string;
}

/**
 * The patterns a tool call's arguments can declare, in the order they are
 * tried: the first one that matches reads the call.
 *
 * A rule that names a file is checked before one that does not, and the two
 * that only look at a single key (`command`, `code`, `url`) come last, since
 * those keys appear inside other calls too — the harness's editor carries a
 * `command` that is an operation (view, str_replace), not something to run.
 */
const CALL_PATTERNS: readonly CallPattern[] = [
  // A sub-agent hand-off: instructions, and the agent to run them, or at
  // least a description of the job.
  {
    kind: ToolKind.Agent,
    matches: (input) => has(input, 'prompt') && (hasAny(input, ['agent', 'subagent_type']) || has(input, 'description')),
    title: (input) => {
      const description = str(input.description);
      const agent = str(input.subagent_type) || str(input.agent);
      return agent ? `${description} (${agent})`.trim() : description || oneLine(str(input.prompt));
    },
    detail: (input) => str(input.prompt),
  },
  // A file change: a path, and the text that goes in it.
  {
    kind: ToolKind.Edit,
    matches: (input) => callPath(input) !== '' && hasAny(input, EDIT_TEXT_KEYS),
    title: callPath,
  },
  // Something to find: a pattern, and where to look for it.
  {
    kind: ToolKind.Search,
    matches: (input) => has(input, 'pattern'),
    title: (input) => str(input.pattern),
  },
  // A file to read, when nothing else is claimed about it.
  {
    kind: ToolKind.Read,
    matches: (input) => callPath(input) !== '',
    title: callPath,
  },
  // A command to run; only reached with no file named.
  {
    kind: ToolKind.Execute,
    matches: (input) => has(input, 'command'),
    title: (input) => str(input.command) || str(input.description),
    detail: (input) => str(input.command),
  },
  // A program a code-mode tool runs.
  {
    kind: ToolKind.Execute,
    matches: (input) => has(input, 'code'),
    title: (input) => str(input.code),
    detail: (input) => str(input.code),
  },
  // A page to fetch, or a query to search for.
  { kind: ToolKind.Fetch, matches: (input) => has(input, 'url'), title: (input) => str(input.url) },
  {
    kind: ToolKind.Fetch,
    matches: (input) => has(input, 'query') || (Array.isArray(input.queries) && input.queries.length > 0),
    title: (input) => str(input.query) || (Array.isArray(input.queries) ? str(input.queries[0]) : ''),
  },
  // A checklist the call writes.
  { kind: ToolKind.Think, matches: (input) => Array.isArray(input.todos), title: () => '' },
];

/**
 * The kind a call's own arguments give it, or `undefined` when they do not
 * say: an empty input, one that fits no pattern, or a tool whose arguments
 * mean nothing to anyone but itself. The name's own table answers then.
 */
export function shapeKindOf(input: Input): ToolKind | undefined {
  return patternOf(input ?? {})?.kind;
}

function patternOf(input: Input): CallPattern | undefined {
  return CALL_PATTERNS.find((pattern) => pattern.matches(input));
}

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
 * A name that is missing here is one an agent renamed, or one this host has
 * never seen at all (an MCP server's own, served under a name of its own).
 * Either way it belongs in the log of the session that used it, where the
 * next reader can see it, rather than only in how the phone happens to render
 * its calls. Each name is reported once per session — and per name, not per
 * call, since a tool is used many times.
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
      `unknown tool name '${toolName}': it is not in this agent's tool table, so its calls are read from`
        + ' their own arguments — and show as a generic action when those say nothing',
    );
  };
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** A title is one line: a multi-line command (a heredoc, a script) shows its
 *  first line, and the whole command travels as the call's `input`. */
const MAX_TITLE_CHARS = 200;

export function oneLine(text: string): string {
  const first = text.split('\n', 1)[0]!.trimEnd();
  const cut = first.length > MAX_TITLE_CHARS ? first.slice(0, MAX_TITLE_CHARS) : first;
  return cut.length < text.trimEnd().length ? `${cut}…` : cut;
}

/** A call's `input` is capped like a tool result: enough to read, well
 *  inside a relay event. */
const MAX_TOOL_INPUT_CHARS = 4000;

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
 * What the call *is* comes from its own arguments when they say, and from the
 * agent's table only when they do not: the arguments are what every agent
 * shares (`command`, a path, a pattern), so reading them is what survives a
 * rename — and the kind is what the phone groups and labels a call by.
 *
 * How the call is *shown* comes from the agent's table when it knows the
 * name, which it does better than a rule about arguments ever could (that a
 * `str_replace_editor` call shows its operation, say), and from the arguments
 * otherwise. That is the one path a renamed tool still reads well on.
 *
 * A name the table does not list and arguments that say nothing give the
 * tool's own name and its arguments, never a guess at either: a guessed kind
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
  const args = input ?? {};
  const pattern = patternOf(args);
  const dialect = dialects[toolName.toLowerCase()];
  // The name is what the report is about, whether or not the call's arguments
  // still read: a name this agent's table does not list means the table is
  // out of date, which is the reader's business to know.
  if (dialect === undefined) report?.(toolName);

  if (pattern !== undefined) return present(pattern.kind, dialect, pattern, args, toolName);
  if (dialect !== undefined) return present(dialect.kind, dialect, undefined, args, toolName);

  const json = Object.keys(args).length > 0 ? JSON.stringify(args, null, 2) : '';
  return { kind: ToolKind.Other, title: oneLine(toolName), ...(json ? { input: capped(json) } : {}) };
}

/** One call, shown the way its agent's own table says when that table knows
 *  the name, and the way its arguments read otherwise. */
function present(
  kind: ToolKind,
  dialect: ToolDialect | undefined,
  pattern: CallPattern | undefined,
  args: Input,
  toolName: string,
): ToolCallRead {
  const titled = (dialect?.title?.(args) ?? '') || (pattern?.title(args) ?? '');
  const title = oneLine(titled) || toolName;
  const detail = dialect
    ? (dialect.detail ? dialect.detail(args) : argumentsAsJson(args))
    : pattern?.detail?.(args);
  // The input is what the sheet shows *besides* the title, so a call that
  // says no more than its title carries none: no second copy of it travels.
  return { kind, title, ...(detail && detail !== title ? { input: capped(detail) } : {}) };
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
