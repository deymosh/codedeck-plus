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

/** Read one of this agent's tool calls. `report` is told a name this table
 *  does not list (`unknownToolReporter`). */
export function piTool(toolName: string, input: Input, report?: (toolName: string) => void): ToolCallRead {
  return readToolCall(PI_TOOLS, toolName, input, report);
}
