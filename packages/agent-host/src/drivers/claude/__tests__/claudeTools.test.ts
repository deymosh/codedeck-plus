/**
 * Claude Code's own tool table: the names it emits, what each one reads as,
 * and — against the SDK this host installs — the names it must have.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { shapeKindOf } from '../../../sdk/tools';
import { CLAUDE_TOOLS, claudeTool } from '../tools';

describe('claudeTool', () => {
  it('reads a file tool by the path it names', () => {
    expect(claudeTool('Read', { file_path: '/a.ts' })).toEqual({ kind: 'read', title: '/a.ts' });
  });

  it('names a sub-agent by its job and its kind, under either spelling', () => {
    // `Task` is the CLI's older name for `Agent`; both arrive.
    expect(claudeTool('Task', { description: 'find things', subagent_type: 'explore', prompt: 'look' })).toEqual({
      kind: 'agent',
      title: 'find things (explore)',
      input: 'look',
    });
    expect(claudeTool('Agent', { description: 'find things', prompt: 'look' }).title).toBe('find things');
  });

  it("reads Claude Code's current name for stopping a task, and its aliases", () => {
    // The CLI's rename map turns KillShell/KillBash into TaskStop and still
    // accepts the old spellings.
    for (const name of ['TaskStop', 'KillShell', 'KillBash']) {
      expect(claudeTool(name, { task_id: 'task-7' })).toEqual({ kind: 'execute', title: 'task-7' });
    }
  });

  it('gives a tool it does not know its own name and arguments', () => {
    const reported: string[] = [];
    expect(claudeTool('SomethingNew', { a: 1 }, (name) => reported.push(name))).toEqual({
      kind: 'other',
      title: 'SomethingNew',
      input: '{\n  "a": 1\n}',
    });
    expect(reported).toEqual(['SomethingNew']);
  });
});

/**
 * The tools the CLI registers, recorded from the version the lockfile pins
 * (2.1.283) by asking it for its own list — the `system/init` message of a
 * session carries `tools`:
 *
 *   cd "$(mktemp -d)" && ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://127.0.0.1:9 \
 *     claude --print --output-format stream-json --verbose hi | head -1
 *
 * `Glob` and `Grep` join that list when a session is allowed them, and
 * `CLAUDE_CODE_USE_POWERSHELL_TOOL` / `CLAUDE_CODE_ENABLE_TODO_TOOLS` add
 * `PowerShell` and the `TaskCreate` family.
 */
const CLI_TOOLS = [
  'Task', 'Bash', 'CronCreate', 'CronDelete', 'CronList', 'DesignSync', 'Edit', 'EnterWorktree',
  'ExitWorktree', 'ListAgents', 'Monitor', 'NotebookEdit', 'PushNotification', 'Read',
  'ReportFindings', 'ScheduleWakeup', 'SendMessage', 'Skill', 'TaskStop', 'WebFetch', 'WebSearch',
  'Workflow', 'Write',
  'Glob', 'Grep', 'PowerShell', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate',
].map((name) => name.toLowerCase());

/**
 * Names the CLI answers to that the SDK declares no input type for: the
 * tools the CLI keeps to itself (`PowerShell`, `Skill`, `SendMessage`,
 * `ListAgents`, `DesignSync`), and the older spellings its rename map and
 * its permission-rule tables still name (`ListPeers`, `Brief`, `NotebookRead`,
 * `MultiEdit`).
 */
const NO_DECLARED_INPUT = [
  'PowerShell', 'Skill', 'SendMessage', 'ListAgents', 'DesignSync',
  'Brief', 'ListPeers', 'NotebookRead', 'MultiEdit',
].map((name) => name.toLowerCase());

/**
 * The tool each of the SDK's declared input types belongs to, under every
 * name it arrives as: `Task` is the CLI's older spelling of `Agent`,
 * `KillShell`/`KillBash` of `TaskStop`, and the MCP-resource tools take a
 * `Tool` suffix the CLI's rename map supplies.
 */
const TOOL_OF_INPUT: Record<string, string[]> = {
  AgentInput: ['agent', 'task'],
  BashInput: ['bash'],
  ExitPlanModeInput: ['exitplanmode'],
  FileEditInput: ['edit'],
  FileReadInput: ['read'],
  FileWriteInput: ['write'],
  GlobInput: ['glob'],
  GrepInput: ['grep'],
  TaskStopInput: ['taskstop', 'killshell', 'killbash'],
  ListMcpResourcesInput: ['listmcpresources', 'listmcpresourcestool'],
  RefreshMcpToolsInput: ['refreshmcptools'],
  McpInput: ['mcp'],
  NotebookEditInput: ['notebookedit'],
  ReadMcpResourceDirInput: ['readmcpresourcedir', 'readmcpresourcedirtool'],
  ReadMcpResourceInput: ['readmcpresource', 'readmcpresourcetool'],
  ReportFindingsInput: ['reportfindings'],
  TodoWriteInput: ['todowrite'],
  WebFetchInput: ['webfetch'],
  WebSearchInput: ['websearch'],
  AskUserQuestionInput: ['askuserquestion'],
  SendFeedbackInput: ['sendfeedback'],
  ClaudeDesignInput: ['claudedesign'],
  ProjectsInput: ['projects'],
  EnterPlanModeInput: ['enterplanmode'],
  TaskCreateInput: ['taskcreate'],
  TaskGetInput: ['taskget'],
  TaskUpdateInput: ['taskupdate'],
  TaskListInput: ['tasklist'],
  WorkflowInput: ['workflow'],
  CronCreateInput: ['croncreate'],
  CronDeleteInput: ['crondelete'],
  CronListInput: ['cronlist'],
  ScheduleWakeupInput: ['schedulewakeup'],
  RemoteTriggerInput: ['remotetrigger'],
  ShowOnboardingRolePickerInput: ['showonboardingrolepicker'],
  ReadNotificationsInput: ['readnotifications'],
  MonitorInput: ['monitor'],
  ProposeSkillsInput: ['proposeskills'],
  ProposeGoalInput: ['proposegoal'],
  ArtifactInput: ['artifact'],
  PushNotificationInput: ['pushnotification'],
  EnterWorktreeInput: ['enterworktree'],
  ExitWorktreeInput: ['exitworktree'],
};

/**
 * The SDK's own typings, which declare one input shape per published tool.
 * The package publishes them as its `sdk-tools` export (types only, so the
 * file is reached through the package root its `main` resolves to).
 */
function sdkToolsFile(): string {
  const entry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
  return path.join(path.dirname(entry), 'sdk-tools.d.ts');
}

/** The input types the SDK's `ToolInputSchemas` union declares. */
function declaredInputTypes(source: string): string[] {
  const at = source.indexOf('export type ToolInputSchemas =');
  expect(at).toBeGreaterThan(-1);
  const union = source.slice(at, source.indexOf(';', at));
  return [...union.matchAll(/\| ([A-Za-z]+Input)\b/g)].map((match) => match[1]!);
}

/** A value of the declared type, for the properties a call must carry. */
function valueFor(type: string): unknown {
  const declared = type.trim();
  if (declared.startsWith('{')) return {};
  if (declared.includes('[]') || declared.startsWith('Array<')) return [];
  if (declared.startsWith('number')) return 1;
  if (declared.startsWith('boolean')) return true;
  return 'x';
}

/**
 * The call a tool must at least be able to carry: one argument per property
 * the SDK declares as required. A real call can carry more, but an optional
 * property says what a call *may* have, not what it is.
 */
function requiredArguments(source: string, type: string): Record<string, unknown> {
  const head = `export interface ${type} {`;
  const at = source.indexOf(head);
  expect(at, `${type} is declared`).toBeGreaterThan(-1);
  if (source.slice(at + head.length, at + head.length + 1) === '}') return {};
  const body = source.slice(at + head.length, source.indexOf('\n}', at));
  const args: Record<string, unknown> = {};
  let depth = 0;
  for (const line of body.split('\n')) {
    const property = /^  ([A-Za-z_][A-Za-z0-9_]*): (.+);$/.exec(line);
    if (property && depth === 0) args[property[1]!] = valueFor(property[2]!);
    for (const character of line) {
      if (character === '{') depth++;
      else if (character === '}') depth--;
    }
  }
  return args;
}

/** What this agent's table says a name is, asked with no arguments at all:
 *  no pattern reads an empty call, so the name is what answers. */
const kindByTable = (name: string): string => claudeTool(name, {}).kind;

describe("the SDK's published tools", () => {
  const source = readFileSync(sdkToolsFile(), 'utf8');

  it('declares an input type for every published tool, and this table knows each', () => {
    const declared = declaredInputTypes(source);
    expect(declared.length).toBeGreaterThan(30);
    expect([...declared].sort()).toEqual(Object.keys(TOOL_OF_INPUT).sort());
    for (const type of declared) {
      for (const name of TOOL_OF_INPUT[type]!) {
        expect(CLAUDE_TOOLS[name], `${name} (${type}) is in the table`).toBeDefined();
      }
    }
  });

  it('lists no name the CLI registers neither by declaration nor by its own tools', () => {
    const declared = declaredInputTypes(source).flatMap((type) => TOOL_OF_INPUT[type]!);
    const known = new Set([...declared, ...CLI_TOOLS, ...NO_DECLARED_INPUT]);
    const stale = Object.keys(CLAUDE_TOOLS).filter((name) => !known.has(name));
    expect(stale, 'a name here that the CLI does not register can only label a row that never appears').toEqual([]);
  });

  it('names every registered tool, so none arrives unknown', () => {
    for (const name of CLI_TOOLS) {
      const reported: string[] = [];
      claudeTool(name, {}, (unknown) => reported.push(unknown));
      expect(reported, `${name} is missing from the table`).toEqual([]);
    }
  });

  it('reads a published tool by its arguments the same way the table reads it by name', () => {
    // The classifier reads the arguments first, so where the two disagree the
    // arguments win at run time: this is where such a disagreement shows up.
    const disagreements: string[] = [];
    for (const type of declaredInputTypes(source)) {
      const input = requiredArguments(source, type);
      const byArguments = shapeKindOf(input);
      if (byArguments === undefined) continue;
      for (const name of TOOL_OF_INPUT[type]!) {
        if (kindByTable(name) !== byArguments) {
          disagreements.push(`${type}: ${name} is ${kindByTable(name)} by name, ${byArguments} by its arguments`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });
});
