/**
 * Qwen Code's tool names, and what each one is.
 *
 * The names are the ones the CLI mounts, taken from its own tool registry
 * (`packages/core/src/tools/tool-names.ts`). ACP carries the call's display
 * title in `title` and the real name in `_meta.toolName` (the driver reads it
 * there — see adapter.ts), so these are the strings that arrive.
 *
 * Only the tools this host renders are listed; anything else — an MCP server's
 * own tools, a skill — falls back to the shared argument reader and shows as a
 * generic action, which is what a name no table can know should do.
 */
import { oneLine, readToolCall, str, ToolKind, type ToolCallRead, type ToolDialects } from '../../sdk/tools';

type Input = Record<string, unknown>;

/** The file a call names; Qwen Code spells it `file_path`, its notebook
 *  editor `notebook_path`. */
const fileOf = (input: Input): string => str(input.file_path) || str(input.notebook_path);

/** A file change shows its diff, which carries the content itself. */
const diffShowsIt = (): undefined => undefined;

/** A sub-agent is named by what it was asked to do. */
const agentTitle = (input: Input): string => str(input.description) || oneLine(str(input.prompt));

const questionTitle = (input: Input): string => {
  const first = Array.isArray(input.questions) ? input.questions[0] : undefined;
  return oneLine(first && typeof first === 'object' ? str((first as Input).question) : '');
};

/** Every name this agent answers to: the table the drift test reads, and what
 *  `qwenTool` falls back to when a call's arguments say nothing. */
export const QWEN_TOOLS: ToolDialects = {
  // --- running things ---
  run_shell_command: { kind: ToolKind.Execute, title: (input) => oneLine(str(input.command)), detail: (input) => str(input.command) },

  // --- files ---
  read_file: { kind: ToolKind.Read, title: fileOf },
  write_file: { kind: ToolKind.Edit, title: fileOf, detail: diffShowsIt },
  edit: { kind: ToolKind.Edit, title: fileOf, detail: diffShowsIt },
  notebook_edit: { kind: ToolKind.Edit, title: fileOf },

  // --- searching ---
  grep_search: { kind: ToolKind.Search, title: (input) => str(input.pattern) },
  glob: { kind: ToolKind.Search, title: (input) => str(input.pattern) },

  // --- the web ---
  web_fetch: { kind: ToolKind.Fetch, title: (input) => str(input.url) },
  web_search: { kind: ToolKind.Fetch, title: (input) => str(input.query) },

  // --- handing work to a sub-agent ---
  agent: { kind: ToolKind.Agent, title: agentTitle, detail: (input) => str(input.prompt) },
  list_agents: { kind: ToolKind.Read },

  // --- the session's own state ---
  todo_write: { kind: ToolKind.Think },
  exit_plan_mode: { kind: ToolKind.SwitchMode },
  ask_user_question: { kind: ToolKind.Think, title: questionTitle },
};

/** Read one of this agent's tool calls. `report` is told a name this table
 *  does not list (`unknownToolReporter`). */
export function qwenTool(toolName: string, input: Input, report?: (toolName: string) => void): ToolCallRead {
  return readToolCall(QWEN_TOOLS, toolName, input, report);
}
