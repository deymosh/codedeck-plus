/**
 * OpenCode 2.x's tool names, and what each one is.
 *
 * Only the tools a session can call by name are listed. v2 decides which
 * those are in `packages/core/src/tool.ts`: a tool registered with
 * `codemode: false` stays on the provider's own tool list and is called
 * directly, while every other tool (the default) is reachable only from
 * inside the `execute` tool's code mode — under its namespace, which core
 * flattens to `<namespace>_<tool>` (`opencode_worktree_create`,
 * `browser_navigate`). Those never arrive as a call of their own, so a name
 * like `worktree_create` is not a name this agent emits.
 *
 * A tool with a namespace that *were* called directly would arrive under the
 * flattened name, which is why none of them is listed here: a version that
 * starts emitting one is a new name, and the unknown-name log says so.
 *
 * The names are the ones the 2.0.28 sources register (`editor.add({name, …})`
 * in `packages/core/src/tool/plugin/*.ts`, and the `execute` tool out of
 * `packages/core/src/codemode`). `__tests__/opencodeTools.test.ts` holds this
 * table against the list recorded from them.
 */
import { oneLine, readToolCall, str, ToolKind, type ToolCallRead, type ToolDialects } from '../../sdk/tools';

type Input = Record<string, unknown>;

/** The file a call names: v2 spells it `path`. */
const fileOf = (input: Input): string => str(input.path) || str(input.file_path);

/** A file change shows its diff, which carries the content itself. */
const diffShowsIt = (): undefined => undefined;

/** A sub-agent is named by what it was asked to do, and by the agent it runs
 *  as (`agent` — v2's name for the old `subagent_type`). */
const subagentTitle = (input: Input): string => {
  const description = str(input.description);
  const agent = str(input.agent);
  return agent ? `${description} (${agent})`.trim() : description;
};

/** The question tool's own row is hidden — its card comes from the form it
 *  raises — so this only names the call if a server ever shows it. */
const questionTitle = (input: Input): string => {
  const first = Array.isArray(input.questions) ? input.questions[0] : undefined;
  return oneLine(first && typeof first === 'object' ? str((first as Input).question) : '');
};

/** Every name this agent answers to: the table the drift test reads, and
 *  what `opencodeTool` falls back to when a call's arguments say nothing. */
export const OPENCODE_TOOLS: ToolDialects = {
  // The shell tool; `bash` is Claude Code's spelling of the same thing.
  shell: { kind: ToolKind.Execute, title: (input) => oneLine(str(input.command)), detail: (input) => str(input.command) },
  // Code Mode: the program the model writes, which calls the other tools.
  execute: { kind: ToolKind.Execute, title: (input) => oneLine(str(input.code)), detail: (input) => str(input.code) },

  read: { kind: ToolKind.Read, title: fileOf },
  write: { kind: ToolKind.Edit, title: fileOf, detail: diffShowsIt },
  edit: { kind: ToolKind.Edit, title: fileOf, detail: diffShowsIt },
  // A patch is one diff's text; the files it touches come with its result,
  // as every file-changing call's do.
  patch: { kind: ToolKind.Edit, detail: diffShowsIt },

  glob: { kind: ToolKind.Search, title: (input) => str(input.pattern) },
  grep: { kind: ToolKind.Search, title: (input) => str(input.pattern) },

  webfetch: { kind: ToolKind.Fetch, title: (input) => str(input.url) },
  websearch: { kind: ToolKind.Fetch, title: (input) => str(input.query) },

  // v2's name for the sub-agent call; `task` is the others'.
  subagent: { kind: ToolKind.Agent, title: subagentTitle, detail: (input) => str(input.prompt) },
  skill: { kind: ToolKind.Read, title: (input) => str(input.id) || str(input.name) },
  question: { kind: ToolKind.Think, title: questionTitle },
};

/** Read one of this agent's tool calls. `report` is told a name this table
 *  does not list (`unknownToolReporter`). */
export function opencodeTool(toolName: string, input: Input, report?: (toolName: string) => void): ToolCallRead {
  return readToolCall(OPENCODE_TOOLS, toolName, input, report);
}
