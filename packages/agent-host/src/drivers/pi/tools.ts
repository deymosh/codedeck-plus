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
  return ['ls', ...(has('rg') ? ['grep'] : []), ...(has('fd', 'fdfind') ? ['find'] : [])];
}

/** Read one of this agent's tool calls. `report` is told a name this table
 *  does not list (`unknownToolReporter`). */
export function piTool(toolName: string, input: Input, report?: (toolName: string) => void): ToolCallRead {
  return readToolCall(PI_TOOLS, toolName, input, report);
}
