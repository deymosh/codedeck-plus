/**
 * Claude Code's tool names, and what each one is.
 *
 * These are the names the CLI this host installs registers, plus the ones it
 * still answers to: the CLI carries a rename map of its own (`Task` to
 * `Agent`, `KillShell`/`KillBash` to `TaskStop`, `ListPeers` to `ListAgents`,
 * `ListMcpResources` to `ListMcpResourcesTool`, …), and a session resumed
 * from an older transcript still says the older name. Both spellings mean the
 * same thing, so both are listed.
 *
 * `sdk-tools.d.ts` in `@anthropic-ai/claude-agent-sdk` declares a typed input
 * per published tool: `__tests__/claudeTools.test.ts` reads it to check this
 * table against the SDK the lockfile pins, which is also why a name can be
 * here with no declared input of its own — an alias, or a tool of the CLI's
 * other surfaces.
 */
import { oneLine, readToolCall, str, ToolKind, type ToolCallRead, type ToolDialects } from '../../sdk/tools';

type Input = Record<string, unknown>;

/** The file a call names, under whichever key this agent uses for it. */
const fileOf = (input: Input): string =>
  str(input.file_path) || str(input.filePath) || str(input.notebook_path) || str(input.path);

/** A sub-agent is named by what it was asked to do, and by the agent it runs
 *  as when the call says. */
const subagentTitle = (input: Input): string => {
  const description = str(input.description);
  const agent = str(input.subagent_type) || str(input.agent);
  return agent ? `${description} (${agent})`.trim() : description;
};

/** A file change shows its diff, which carries the content itself. */
const diffShowsIt = (): undefined => undefined;

const runTitle = (input: Input): string => oneLine(str(input.command) || str(input.description));
const stopTitle = (input: Input): string => str(input.task_id) || str(input.shell_id);

/** The question tool's own row is hidden — its card comes from the questions
 *  it asks — so this only names the call if a client ever shows it. */
const questionTitle = (input: Input): string => {
  const first = Array.isArray(input.questions) ? input.questions[0] : undefined;
  return oneLine(first && typeof first === 'object' ? str((first as Input).question) : '');
};

/** Every name this agent answers to: the table the drift test reads, and
 *  what `claudeTool` falls back to when a call's arguments say nothing. */
export const CLAUDE_TOOLS: ToolDialects = {
  // --- running things ---
  bash: { kind: ToolKind.Execute, title: runTitle, detail: (input) => str(input.command) },
  powershell: { kind: ToolKind.Execute, title: runTitle, detail: (input) => str(input.command) },
  // Stopping a background task, which the CLI renames to `TaskStop` and
  // still accepts as `KillShell`/`KillBash`.
  taskstop: { kind: ToolKind.Execute, title: stopTitle },
  killshell: { kind: ToolKind.Execute, title: stopTitle },
  killbash: { kind: ToolKind.Execute, title: stopTitle },
  monitor: { kind: ToolKind.Execute, title: (input) => oneLine(str(input.description)), detail: (input) => str(input.command) },

  // --- files ---
  read: { kind: ToolKind.Read, title: fileOf },
  notebookread: { kind: ToolKind.Read, title: fileOf },
  edit: { kind: ToolKind.Edit, title: fileOf, detail: diffShowsIt },
  write: { kind: ToolKind.Edit, title: fileOf, detail: diffShowsIt },
  multiedit: { kind: ToolKind.Edit, title: fileOf, detail: diffShowsIt },
  notebookedit: { kind: ToolKind.Edit, title: fileOf, detail: diffShowsIt },
  enterworktree: { kind: ToolKind.Other, title: (input) => str(input.name) || str(input.path) },
  exitworktree: { kind: ToolKind.Other },

  // --- searching ---
  glob: { kind: ToolKind.Search, title: (input) => str(input.pattern) },
  grep: { kind: ToolKind.Search, title: (input) => str(input.pattern) },

  // --- the web ---
  webfetch: { kind: ToolKind.Fetch, title: (input) => str(input.url) },
  websearch: { kind: ToolKind.Fetch, title: (input) => str(input.query) },

  // --- handing work to a sub-agent ---
  agent: { kind: ToolKind.Agent, title: subagentTitle, detail: (input) => str(input.prompt) },
  // The CLI's older spelling of `Agent`, which it still answers to.
  task: { kind: ToolKind.Agent, title: subagentTitle, detail: (input) => str(input.prompt) },
  workflow: { kind: ToolKind.Agent, title: (input) => str(input.name) || str(input.title) },

  // --- the session's own state ---
  todowrite: { kind: ToolKind.Think },
  taskcreate: { kind: ToolKind.Think, title: (input) => str(input.subject) },
  taskupdate: { kind: ToolKind.Think, title: (input) => str(input.subject) || str(input.taskId) },
  taskget: { kind: ToolKind.Think, title: (input) => str(input.taskId) },
  tasklist: { kind: ToolKind.Think },
  exitplanmode: { kind: ToolKind.SwitchMode },
  enterplanmode: { kind: ToolKind.SwitchMode },
  croncreate: { kind: ToolKind.Other, title: (input) => oneLine(str(input.cron)), detail: (input) => str(input.prompt) },
  crondelete: { kind: ToolKind.Other },
  cronlist: { kind: ToolKind.Read },
  schedulewakeup: { kind: ToolKind.Other, title: (input) => oneLine(str(input.reason)) },
  skill: { kind: ToolKind.Read, title: (input) => str(input.skill) || str(input.name) },

  // --- the user, and the session's agents ---
  askuserquestion: { kind: ToolKind.Think, title: questionTitle },
  pushnotification: { kind: ToolKind.Other, title: (input) => oneLine(str(input.message)) },
  reportfindings: { kind: ToolKind.Other },
  sendmessage: { kind: ToolKind.Other, title: (input) => str(input.to) || str(input.name) },
  listagents: { kind: ToolKind.Read },
  // The CLI's older spellings of `ListAgents` and `SendUserMessage`.
  listpeers: { kind: ToolKind.Read },
  brief: { kind: ToolKind.Other, title: (input) => str(input.to) },
  sendfeedback: { kind: ToolKind.Other, title: (input) => oneLine(str(input.title) || str(input.type)) },

  // --- MCP servers' own tools, under the names the CLI knows them by ---
  listmcpresources: { kind: ToolKind.Read },
  listmcpresourcestool: { kind: ToolKind.Read },
  readmcpresource: { kind: ToolKind.Read },
  readmcpresourcetool: { kind: ToolKind.Read },
  readmcpresourcedir: { kind: ToolKind.Read },
  readmcpresourcedirtool: { kind: ToolKind.Read },
  refreshmcptools: { kind: ToolKind.Other },
  mcp: { kind: ToolKind.Other },

  // --- tools of the CLI's other surfaces. The SDK types them and a session
  //     this host runs does not call them; they are here so that one which
  //     does still arrives with its own name rather than as a stray. ---
  artifact: { kind: ToolKind.Other, title: (input) => oneLine(str(input.title) || str(input.action)) },
  claudedesign: { kind: ToolKind.Other, title: (input) => str(input.operation) },
  projects: { kind: ToolKind.Other, title: (input) => str(input.method) },
  remotetrigger: { kind: ToolKind.Other, title: (input) => str(input.action) },
  showonboardingrolepicker: { kind: ToolKind.Other },
  readnotifications: { kind: ToolKind.Other },
  proposeskills: { kind: ToolKind.Other },
  proposegoal: { kind: ToolKind.Other, title: (input) => oneLine(str(input.condition)) },
  designsync: { kind: ToolKind.Other },
};

/** Read one of this agent's tool calls. `report` is told a name this table
 *  does not list (`unknownToolReporter`). */
export function claudeTool(toolName: string, input: Input, report?: (toolName: string) => void): ToolCallRead {
  return readToolCall(CLAUDE_TOOLS, toolName, input, report);
}
