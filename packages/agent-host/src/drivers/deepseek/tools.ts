/**
 * DeepSeek Harness (dsh) tool names, and what each one is.
 *
 * The names are the ones the profile this host runs mounts: the harness's
 * `dsh-base` bundle inserts each tool plugin, and a few tools take their name
 * from that configuration rather than from the plugin — the sub-agent call is
 * `subagent` (and its fork `subagent_fork`) because the bundle's `tool-subagent`
 * rows say `toolName: subagent`. ACP carries the tool's own name as the call's
 * title, so these are the strings that arrive.
 *
 * Two tools of the harness are deliberately not here, because this profile
 * does not mount them: `ralph` (disabled in `dsh-base`, restored only by an
 * overlay that asks for it) and `present` (it declares deliverable files for
 * the harness's own web app, which nothing on the phone shows).
 */
import { oneLine, readToolCall, str, ToolKind, type ToolCallRead, type ToolDialects } from '../../sdk/tools';

type Input = Record<string, unknown>;

/** The file a call names; the harness spells it `file_path`, and its editor
 *  `path`. */
const fileOf = (input: Input): string => str(input.file_path) || str(input.path);

/** A file change shows its diff, which carries the content itself. */
const diffShowsIt = (): undefined => undefined;

const runTitle = (input: Input): string => oneLine(str(input.command) || str(input.description));
/** A sub-agent is named by what it was asked to do; the harness's call has
 *  no separate agent name. */
const subagentTitle = (input: Input): string => str(input.description);
const killTitle = (input: Input): string => str(input.job_id) || str(input.agent_id) || str(input.target);

const askTitle = (input: Input): string => {
  const first = Array.isArray(input.questions) ? input.questions[0] : undefined;
  return oneLine(first && typeof first === 'object' ? str((first as Input).question) : '');
};

const DEEPSEEK_TOOLS: ToolDialects = {
  // --- running things ---
  // Which of these two is mounted depends on the host OS: bash everywhere
  // but Windows, pwsh on Windows.
  bash: { kind: ToolKind.Execute, title: runTitle, detail: (input) => str(input.command) },
  pwsh: { kind: ToolKind.Execute, title: runTitle, detail: (input) => str(input.command) },
  job_kill: { kind: ToolKind.Execute, title: (input) => str(input.job_id) },
  interrupt_agent: { kind: ToolKind.Execute, title: killTitle },

  // --- files ---
  read: { kind: ToolKind.Read, title: fileOf },
  read_image: { kind: ToolKind.Read, title: fileOf },
  write: { kind: ToolKind.Edit, title: fileOf, detail: diffShowsIt },
  edit: { kind: ToolKind.Edit, title: fileOf, detail: diffShowsIt },
  // An editor whose `command` (view, create, str_replace, insert) says what
  // the call does; a view changes nothing, so it shows a path like a read.
  str_replace_editor: {
    kind: ToolKind.Edit,
    title: (input) => `${str(input.command)} ${str(input.path)}`.trim(),
    detail: diffShowsIt,
  },

  // --- searching ---
  glob: { kind: ToolKind.Search, title: (input) => str(input.pattern) },
  grep: { kind: ToolKind.Search, title: (input) => str(input.pattern) },

  // --- the web ---
  web_search: { kind: ToolKind.Fetch, title: (input) => (Array.isArray(input.queries) ? str(input.queries[0]) : '') },
  web_fetch: { kind: ToolKind.Fetch, title: (input) => str(input.url) },

  // --- handing work to a sub-agent ---
  subagent: { kind: ToolKind.Agent, title: subagentTitle, detail: (input) => str(input.prompt) },
  subagent_fork: { kind: ToolKind.Agent, title: subagentTitle, detail: (input) => str(input.prompt) },
  send_message: { kind: ToolKind.Other, title: (input) => str(input.agent_id) || str(input.target) },
  list_agents: { kind: ToolKind.Read },
  list_subagent_models: { kind: ToolKind.Read, title: (input) => str(input.provider) },
  workflow: { kind: ToolKind.Agent, title: (input) => str(input.name) },

  // --- the session's own state ---
  todo_write: { kind: ToolKind.Think },
  get_goal: { kind: ToolKind.Think },
  create_goal: { kind: ToolKind.Think, title: (input) => oneLine(str(input.objective)) },
  update_goal: { kind: ToolKind.Think, title: (input) => oneLine(str(input.objective)) || str(input.goal_id) },
  exit_plan_mode: { kind: ToolKind.SwitchMode },
  skill: { kind: ToolKind.Read, title: (input) => str(input.name) },
  ask_user_question: { kind: ToolKind.Think, title: askTitle },

  // --- reading jobs back ---
  job_output: { kind: ToolKind.Read, title: (input) => str(input.job_id) },
  job_list: { kind: ToolKind.Read },

  // --- the harness's own inspection tools ---
  cordis_inspect_list: { kind: ToolKind.Read },
  cordis_inspect_query: { kind: ToolKind.Read, title: (input) => str(input.method) || str(input.provider) },
  load_workspace_dependencies: { kind: ToolKind.Read },
};

/** Read one of this agent's tool calls. `report` is told a name this table
 *  does not list (`unknownToolReporter`). */
export function deepseekTool(toolName: string, input: Input, report?: (toolName: string) => void): ToolCallRead {
  return readToolCall(DEEPSEEK_TOOLS, toolName, input, report);
}
