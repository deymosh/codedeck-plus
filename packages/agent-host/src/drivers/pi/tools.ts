/**
 * Pi's built-in tool names, and what each one is.
 *
 * The names are the ones the CLI registers in its own tool table
 * (`dist/core/tools/index.js`, `allToolNames`): `read`, `bash`, `powershell`,
 * `edit`, `write`, `grep`, `find` and `ls`. Which of them a session has is the
 * profile's `defaultTools` setting — `read`, `bash`, `edit` and `write` unless
 * it says otherwise — but the table covers all of them, since an operator's
 * settings may enable any. Extensions and MCP servers add names no table can
 * know; those read from their own arguments through the shared reader.
 *
 * Pi's argument spellings are its own: a file tool names `path` (not
 * `file_path`), an edit carries `edits: [{oldText, newText}]`, and the
 * search tools match a glob `pattern`.
 */
import * as path from 'node:path';
import { findInDirs, findOnPath } from '../../sdk/executable';
import { oneLine, readToolCall, str, ToolKind, type ToolCallRead, type ToolDialects } from '../../sdk/tools';
import { boundedDiff, patchLines, toDiffLines, type DiffPayload } from '../../sdk/transcript';
import { PI_TOOL } from './extension/protocol';

type Input = Record<string, unknown>;

/** The file a call names; Pi spells it `path` in every file tool. */
const fileOf = (input: Input): string => str(input.path);

/** A file change shows its diff, which carries the content itself, so the
 *  arguments are not repeated under the title. */
const diffShowsIt = (): undefined => undefined;

const runTitle = (input: Input): string => oneLine(str(input.command));

/** Every built-in name Pi answers to: the table the drift test reads, and what
 *  `piTool` falls back to when a call's arguments say nothing. */
export const PI_TOOLS: ToolDialects = {
  // --- running things ---
  // `bash` runs Git Bash on Windows; `powershell` is the other shell tool a
  // profile may enable instead of or beside it.
  bash: { kind: ToolKind.Execute, title: runTitle, detail: (input) => str(input.command) },
  powershell: { kind: ToolKind.Execute, title: runTitle, detail: (input) => str(input.command) },

  // --- files ---
  read: { kind: ToolKind.Read, title: fileOf },
  write: { kind: ToolKind.Edit, title: fileOf, detail: diffShowsIt },
  edit: { kind: ToolKind.Edit, title: fileOf, detail: diffShowsIt },

  // --- searching ---
  grep: { kind: ToolKind.Search, title: (input) => str(input.pattern) },
  find: { kind: ToolKind.Search, title: (input) => str(input.pattern) },

  // --- the directory ---
  ls: { kind: ToolKind.Read, title: (input) => fileOf(input) || '.' },
};

/**
 * The tools the CodeDeck Pi extension adds (extension/protocol.ts). Apart
 * from Pi's own table: the drift test holds that one to exactly the names the
 * installed Pi declares.
 */
export const CODEDECK_TOOLS: ToolDialects = {
  [PI_TOOL.todo]: { kind: ToolKind.Think, title: () => 'Checklist' },
  [PI_TOOL.ask]: { kind: ToolKind.Other, title: () => 'Question' },
  [PI_TOOL.exitPlan]: { kind: ToolKind.SwitchMode, title: () => 'Plan' },
  [PI_TOOL.task]: { kind: ToolKind.Agent, title: (input) => oneLine(str(input.description)), detail: (input) => str(input.prompt) },
  [PI_TOOL.bashBackground]: { kind: ToolKind.Execute, title: runTitle, detail: (input) => str(input.command) },
  [PI_TOOL.taskOutput]: { kind: ToolKind.Read, title: (input) => str(input.id) },
  [PI_TOOL.taskStop]: { kind: ToolKind.Execute, title: (input) => str(input.id) },
  [PI_TOOL.webFetch]: { kind: ToolKind.Fetch, title: (input) => str(input.url) },
  [PI_TOOL.memory]: { kind: ToolKind.Edit, title: (input) => `${str(input.action)} ${str(input.name)}`.trim() },
};

/**
 * The extension's tools that run without a card in every mode: they change
 * nothing in the project or outside the session (a checklist, a question,
 * the plan card, a sub-agent whose own calls each pass the gate, a
 * background task's output, the session's own notes), or they stop what the
 * session started. Starting a background command asks like any command, and
 * a fetch reaches the network, so neither is here.
 */
export const CODEDECK_SAFE_TOOLS: ReadonlySet<string> = new Set([
  PI_TOOL.todo,
  PI_TOOL.ask,
  PI_TOOL.exitPlan,
  PI_TOOL.task,
  PI_TOOL.taskOutput,
  PI_TOOL.taskStop,
  PI_TOOL.memory,
]);

/**
 * Commands plan mode lets `bash` run, each with the options that would make
 * it write a file or run another program (`sort -o`, `rg --pre`, `fd -x`,
 * `find -delete`, `git log --output`). A command not listed is not
 * read-only; `uniq` is left out because its second operand is a file it
 * writes.
 */
const READ_ONLY_COMMANDS: ReadonlyMap<string, RegExp | null> = new Map([
  ['cat', null], ['head', null], ['tail', null], ['wc', null], ['cut', null], ['tr', null], ['pwd', null],
  ['echo', null], ['basename', null], ['dirname', null], ['realpath', null], ['which', null], ['file', null],
  ['stat', null], ['du', null], ['ls', null], ['diff', null],
  ['grep', null],
  ['rg', /^--pre(=|$)|^--hostname-bin(=|$)/],
  ['sort', /^-o|^--output(=|$)|^--compress-program(=|$)/],
  ['tree', /^-o$|^-o.|^--output/],
  ['find', /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/],
  ['fd', /^-x$|^-X$|^--exec(-batch)?(=|$)/],
  ['fdfind', /^-x$|^-X$|^--exec(-batch)?(=|$)/],
  // `-O` (alone or in a bundle such as `-nO`) is `git grep`'s
  // --open-files-in-pager: it runs the program it names on the matches.
  ['git', /^--output(=|$)|^--ext-diff$|^--textconv$|^-c$|^--exec-path(=|$)|^--open-files-in-pager|^-[A-Za-z]*O/],
]);
const READ_ONLY_GIT = new Set(['status', 'log', 'diff', 'show', 'blame', 'ls-files', 'grep', 'rev-parse', 'describe']);

/**
 * Whether a command could read a process's environment from the filesystem:
 * a `proc` path segment or the word `environ`, or a glob inside a path,
 * which could spell either (`/pr?c/self/env*`). Plan mode refuses these in
 * either shell; a glob without a path (`-name "*.ts"`) is still fine.
 */
function readsEnvironment(command: string): boolean {
  if (/environ|(^|[\s/\\'"=])proc([/\\'"\s]|$)/i.test(command)) return true;
  return command.split(/\s+/).some((word) => /[*?[]/.test(word) && /[/\\]/.test(word));
}

/**
 * Whether a shell command only reads, for plan mode: every part of a pipeline
 * or a `&&`/`||`/`;` chain is a listed reading command without its writing
 * options, and nothing redirects, substitutes another command or runs one in
 * the background. git may run only its reading subcommands. Nothing may
 * read the environment — `env`/`printenv` are not listed, and no `$`
 * expansion or a process's `environ` file passes — since it would put
 * secrets into the transcript. Plan mode is a guardrail against a model
 * changing things too early, not a sandbox: anything not recognised is
 * refused.
 */
export function isReadOnlyCommand(command: string): boolean {
  if (command.trim() === '' || /[\n\r`<>$]/.test(command) || readsEnvironment(command)) return false;
  return command.split(/\|\||&&|[|;]/).every((part) => {
    if (part.includes('&')) return false;
    const words = part.trim().split(/\s+/);
    const name = words[0] ?? '';
    if (!READ_ONLY_COMMANDS.has(name)) return false;
    const writes = READ_ONLY_COMMANDS.get(name);
    if (writes && words.slice(1).some((word) => writes.test(word))) return false;
    if (name === 'git') return READ_ONLY_GIT.has(words.find((word, i) => i > 0 && !word.startsWith('-')) ?? '');
    return true;
  });
}

/**
 * PowerShell's reading commands, by name and alias (compared without case),
 * for plan mode. Not `Where-Object`/`ForEach-Object` (their script blocks run
 * anything), nor `Out-File`, `Set-Content`, `Tee-Object` or anything else
 * that writes; `git` and `rg` keep the bash table's rules.
 */
const READ_ONLY_POWERSHELL = new Set([
  'get-childitem', 'gci', 'ls', 'dir', 'get-content', 'gc', 'cat', 'type', 'select-string', 'sls', 'get-location',
  'gl', 'pwd', 'test-path', 'get-item', 'gi', 'resolve-path', 'rvpa', 'split-path', 'join-path', 'measure-object',
  'measure', 'sort-object', 'sort', 'select-object', 'select', 'get-command', 'gcm', 'format-list', 'fl',
  'format-table', 'ft', 'out-string', 'get-filehash', 'findstr', 'git', 'rg',
]);

/**
 * Whether a PowerShell command only reads, for plan mode — the same idea as
 * isReadOnlyCommand for PowerShell's syntax: every part of a pipeline or a
 * `;`/`&&`/`||` chain is a listed reading command, and nothing redirects,
 * runs a script block (`{…}`), a subexpression (`$(…)`, `@(…)`) or the call
 * operator (`&`), or escapes with a backtick. No variable (`$`) and no
 * `env:` drive either: the environment holds secrets.
 */
export function isReadOnlyPowerShell(command: string): boolean {
  if (command.trim() === '' || /[\n\r`<>{}$]|@\(|\benv:/i.test(command) || readsEnvironment(command)) return false;
  return command.split(/\|\||&&|[|;]/).every((part) => {
    if (part.includes('&')) return false;
    const words = part.trim().split(/\s+/);
    const name = (words[0] ?? '').toLowerCase();
    if (!READ_ONLY_POWERSHELL.has(name)) return false;
    const writes = READ_ONLY_COMMANDS.get(name);
    if (writes && words.slice(1).some((word) => writes.test(word))) return false;
    if (name === 'git') return READ_ONLY_GIT.has(words.find((word, i) => i > 0 && !word.startsWith('-')) ?? '');
    return true;
  });
}

/** Whether a call to one of Pi's shells only reads, by the shell's syntax. */
export function isReadOnlyShellCall(toolName: string, input: Record<string, unknown>): boolean {
  const command = typeof input.command === 'string' ? input.command : '';
  if (toolName === 'bash') return isReadOnlyCommand(command);
  if (toolName === 'powershell') return isReadOnlyPowerShell(command);
  return false;
}

/**
 * The tools this driver's `ask` mode runs without a card: Pi's own read-only
 * set, the same four `--tools read,grep,find,ls` selects. A call to any other
 * tool — including one an operator's extension registered — asks.
 */
export const PI_READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['read', 'grep', 'find', 'ls']);

/**
 * The tools this driver's `auto-edit` mode also runs without a card: Pi's
 * own file writers. Only Pi's built-ins, by name — an extension's or an MCP
 * server's tool that looks like an edit may do anything else as well, so it
 * still asks, and so does every shell.
 */
export const PI_EDIT_TOOLS: ReadonlySet<string> = new Set(['edit', 'write']);

/**
 * The diff card of a finished file change, or `null` when there is none to
 * show. Taken from the result, not the call: only then has the change been
 * applied. `edit` returns the unified patch Pi computed against the file
 * (`details.patch`), with real context lines; `write` returns no details, so
 * its card is the content it wrote, every line an addition.
 */
export function fileChangeDiff(toolName: string, input: Record<string, unknown>, details: unknown): DiffPayload | null {
  const file = str(input.path);
  if (!file) return null;
  if (toolName === 'edit') {
    const patch = typeof details === 'object' && details !== null ? (details as { patch?: unknown }).patch : undefined;
    return typeof patch === 'string' ? boundedDiff(file, patchLines(patch)) : null;
  }
  if (toolName === 'write') {
    const content = str(input.content);
    return content ? boundedDiff(file, toDiffLines(content, 'add')) : null;
  }
  return null;
}

/**
 * The built-in tools a session turns on beyond Pi's default four, as
 * `--tools` `+name` entries (which keep whatever else the profile's
 * `defaultTools` selects). `ls` is plain Node. `grep` and `find` run ripgrep
 * and fd, which Pi takes from its own `bin` directory or `PATH` — and,
 * running `--offline`, never downloads — so each is on only where its binary
 * is: a tool that can only fail would cost the model a call every time it
 * tried it.
 */
export function piExtraTools(home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  const has = (...names: string[]): boolean =>
    names.some((name) => findInDirs([path.join(home, 'bin')], name, platform) !== null || findOnPath(name, env, platform) !== null);
  const entries = ['+ls', ...(has('rg') ? ['+grep'] : []), ...(has('fd', 'fdfind') ? ['+find'] : [])];
  // Windows always has a PowerShell (Pi prefers PowerShell 7, else the
  // Windows PowerShell every Windows ships), so its tool is on beside bash.
  // Whether Pi finds a bash there (Git Bash, a bash on PATH, its own
  // shellPath setting) only Pi can say; the extension asks it as the session
  // starts and turns bash off where it would only fail (extension/shells.ts).
  if (platform === 'win32') entries.push('+powershell');
  return entries;
}

const PI_ALL_TOOLS: ToolDialects = { ...PI_TOOLS, ...CODEDECK_TOOLS };

/** Read one of this agent's tool calls. `report` is told a name this table
 *  does not list (`unknownToolReporter`). */
export function piTool(toolName: string, input: Input, report?: (toolName: string) => void): ToolCallRead {
  return readToolCall(PI_ALL_TOOLS, toolName, input, report);
}
