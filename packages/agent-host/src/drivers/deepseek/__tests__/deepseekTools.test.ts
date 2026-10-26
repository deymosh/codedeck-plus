/**
 * The DeepSeek Harness's own tool table: the names its `acp` profile mounts,
 * what each one reads as, and — against the harness this host installs — the
 * names that package declares.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { shapeKindOf } from '../../../sdk/tools';
import { DEEPSEEK_TOOLS, deepseekTool } from '../tools';

describe('deepseekTool', () => {
  it('reads the shell tool of whichever host this is', () => {
    // `bash` everywhere but Windows, `pwsh` there.
    expect(deepseekTool('bash', { command: 'npm test' })).toEqual({ kind: 'execute', title: 'npm test' });
    // A run shows the command itself, whole: its other arguments (the working
    // directory, a timeout) are not what the row is about.
    const command = `node -e "${'x'.repeat(300)}"`;
    expect(deepseekTool('pwsh', { command, workdir: '/w' })).toEqual({
      kind: 'execute',
      title: `${command.slice(0, 200)}…`,
      input: command,
    });
  });

  it("reads the harness's editor by the operation it was given", () => {
    // One tool, several operations: the arguments say which one this call is,
    // and the table's title says which operation it runs.
    expect(deepseekTool('str_replace_editor', { command: 'view', path: '/a.ts' })).toEqual({
      kind: 'read',
      title: 'view /a.ts',
    });
    expect(deepseekTool('str_replace_editor', { command: 'str_replace', path: '/a.ts', old_str: 'a', new_str: 'b' })).toEqual({
      kind: 'edit',
      title: 'str_replace /a.ts',
    });
  });

  it('names a sub-agent by what it was asked to do', () => {
    // The sub-agent call's own name comes from the profile's configuration
    // (`toolName: subagent`), not from the plugin.
    expect(deepseekTool('subagent', { description: 'find things', prompt: 'look' })).toEqual({
      kind: 'agent',
      title: 'find things',
      input: 'look',
    });
    expect(deepseekTool('subagent_fork', { description: 'find things', prompt: 'look' }).kind).toBe('agent');
  });

  it('reads the working-directory tool as the cd or pwd it is', () => {
    expect(deepseekTool('working_directory', { cd: 'src' })).toEqual({ kind: 'execute', title: 'cd src' });
    expect(deepseekTool('working_directory', {})).toEqual({ kind: 'execute', title: 'pwd' });
  });

  it('gives a tool this profile mounts no longer its own name and arguments', () => {
    // `agent` and `list` were never dsh tools; the harness's own names are
    // `subagent` and the job tools.
    const reported: string[] = [];
    expect(deepseekTool('agent', {}, (name) => reported.push(name))).toEqual({ kind: 'other', title: 'agent' });
    expect(reported).toEqual(['agent']);
  });
});

/**
 * The tools the `acp` profile mounts, recorded from the bundle that mounts
 * them: `@deepseek-ai/dsh-base`'s `cordis.patch.yml` inserts one entry per
 * tool plugin. `ask_user_question` is CodeDeck's own addition
 * (profileTools.ts), and `exit_plan_mode` comes from the harness's plan mode.
 */
const MOUNTED = [
  // The profile mounts the shell tool of the host it runs on: `bash`
  // everywhere but Windows, `pwsh` there. Both are listed: which one arrives
  // is a property of the machine, not of the phone reading it.
  'bash', 'pwsh',
  'read', 'read_image', 'write', 'edit', 'str_replace_editor',
  'glob', 'grep',
  'job_output', 'job_list', 'job_kill',
  'web_search', 'web_fetch',
  'skill', 'todo_write',
  'list_subagent_models', 'send_message', 'interrupt_agent', 'list_agents',
  'get_goal', 'create_goal', 'update_goal',
  'cordis_inspect_list', 'cordis_inspect_query', 'load_workspace_dependencies',
  'working_directory',
  'exit_plan_mode', 'ask_user_question',
];

/**
 * Names a package registers from its configuration rather than from a
 * literal, so no source file declares them: the bundle's `tool-subagent` rows
 * say `toolName: subagent` and `toolName: subagent_fork`, and `tool-workflow`
 * registers under its own default name.
 */
const CONFIGURED_NAMES = ['subagent', 'subagent_fork', 'workflow'];

/**
 * Tools an installed package declares that this profile does not mount: the
 * agent-team experiment (nothing in the bundle inserts it), `present` (it
 * declares deliverable files for the harness's own web app, which nothing on
 * the phone shows), `ralph` (its row in the bundle is disabled), and the
 * worktree experiment and scheduled-task tools (the `acp` profile inserts
 * neither plugin), and the persistent-terminal and session-search tools (only
 * the opt-in `dsh-experimental-terminal-bundle` and
 * `dsh-experimental-session-search` overlays insert them).
 */
const NOT_MOUNTED = [
  'present', 'ralph',
  'spawn_teammate', 'wait_agent', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  'create_worktree',
  'schedule_create', 'schedule_list', 'schedule_delete', 'schedule_update',
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
  'session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read',
];

/** One tool as the package registering it declares it. */
interface DeclaredTool {
  name: string;
  /** The arguments a call of it must carry. */
  required: string[];
}

/**
 * Every `@deepseek-ai` package the harness depends on, directly or through
 * another of them, as the directory it is installed in. A tool can hang off
 * any of them — `dsh-tool-working-directory` is a dependency of `dsh-base`,
 * not of `@deepseek-ai/dsh` — so the walk follows each package's own
 * dependencies, which a package manager lays out beside it.
 */
function harnessPackages(): Map<string, string> {
  const require_ = createRequire(import.meta.url);
  // Symlinks are followed by hand: a runner that keeps them would otherwise
  // look for a package's dependencies beside the link, not beside the package.
  const root = path.dirname(realpathSync(require_.resolve('@deepseek-ai/dsh/package.json')));
  const found = new Map<string, string>([['@deepseek-ai/dsh', root]]);
  const pending = [root];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
    const names = ['dependencies', 'optionalDependencies', 'peerDependencies'].flatMap((field) =>
      Object.keys((manifest[field] as Record<string, string> | undefined) ?? {}),
    );
    for (const name of names) {
      if (!name.startsWith('@deepseek-ai/') || found.has(name)) continue;
      // `dir` is `…/node_modules/@deepseek-ai/<package>`: its dependencies
      // sit two levels up. An optional one may not be installed.
      const beside = path.join(dir, '..', '..', name);
      if (!existsSync(beside)) continue;
      const installed = realpathSync(beside);
      found.set(name, installed);
      pending.push(installed);
    }
  }
  return found;
}

/** The installed packages that register tools, by name. */
function toolPackages(): Map<string, string> {
  return new Map([...harnessPackages()].filter(([name]) => /^@deepseek-ai\/dsh-(experimental-)?tool-/.test(name)));
}

/** Every tool the installed tool packages declare. */
function declaredTools(): DeclaredTool[] {
  const found: DeclaredTool[] = [];
  for (const dir of toolPackages().values()) {
    for (const file of readdirSync(dir, { recursive: true }) as string[]) {
      if (!file.endsWith('.js')) continue;
      const source = readFileSync(path.join(dir, file), 'utf8');
      for (const call of definitionsIn(source)) {
        const declared = /name:\s*"([^"]+)"/.exec(call)?.[1];
        // The registry's own error class is not a tool.
        if (declared !== undefined && declared !== 'ToolCallError') {
          found.push({ name: declared, required: requiredOf(call) });
        }
      }
    }
  }
  return found;
}

/** Every `defineTool({ … })` argument in a source, by brace matching. */
function definitionsIn(source: string): string[] {
  const found: string[] = [];
  let at = 0;
  while ((at = source.indexOf('defineTool({', at)) !== -1) {
    const start = source.indexOf('{', at);
    const end = blockEnd(source, start);
    found.push(source.slice(start, end + 1));
    at = end;
  }
  return found;
}

/** The keys of a definition's `parameters` object that a call must carry. */
function requiredOf(call: string): string[] {
  const parameters = /parameters:\s*\{/.exec(call);
  if (parameters === null) return [];
  const body = call.slice(parameters.index + parameters[0].length);
  const required: string[] = [];
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const character = body[i]!;
    if (character === '{') depth++;
    else if (character === '}') {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && /[A-Za-z_$]/.test(character) && (i === 0 || !/[A-Za-z0-9_$]/.test(body[i - 1]!))) {
      const property = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/.exec(body.slice(i, i + 60));
      if (property === null) continue;
      i += property[0].length - 1;
      // Only the parameter's own block counts: a nested object's `required`
      // is about its properties, not about this one.
      if (/required:\s*true/.test(body.slice(i + 1, blockEnd(body, i + 1)))) required.push(property[1]!);
    }
  }
  return required;
}

/** Where the block starting at `at` ends. */
function blockEnd(source: string, at: number): number {
  let depth = 0;
  for (let i = at; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth <= 0) return i;
    }
  }
  return source.length;
}

/** The arguments a tool's calls carry at least: one value per required key. */
function requiredArguments(keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, 'x']));
}

/** What this agent's table says a name is, asked with no arguments at all: no
 *  pattern reads an empty call, so the name is what answers. */
const kindByTable = (name: string): string => deepseekTool(name, {}).kind;

describe('the tools the installed harness declares', () => {
  const declared = declaredTools();

  it('finds the tool packages, and tools in them', () => {
    // A silent zero would make every check below pass for the wrong reason.
    expect(toolPackages().size).toBeGreaterThan(10);
    // One that only a dependency of a dependency brings in.
    expect(toolPackages().has('@deepseek-ai/dsh-tool-working-directory')).toBe(true);
    expect(declared.length).toBeGreaterThan(20);
  });

  it('has a table entry for every tool this profile mounts, and no other', () => {
    const mounted = new Set([...MOUNTED, ...CONFIGURED_NAMES]);
    expect(Object.keys(DEEPSEEK_TOOLS).filter((name) => !mounted.has(name))).toEqual([]);
    for (const name of mounted) expect(DEEPSEEK_TOOLS[name], `${name} is in the table`).toBeDefined();
  });

  it('accounts for every tool the installed packages declare', () => {
    // A tool the harness gains is a name this table must decide about: either
    // it is mounted and classified, or it is one this profile leaves out on
    // purpose.
    const known = new Set([...MOUNTED, ...CONFIGURED_NAMES, ...NOT_MOUNTED]);
    const unaccounted = [...new Set(declared.map((tool) => tool.name))].filter((name) => !known.has(name));
    expect(unaccounted).toEqual([]);
  });

  it('reads a declared tool by its arguments the same way the table reads it by name', () => {
    // The classifier reads the arguments first, so where the two disagree the
    // arguments win at run time: this is where such a disagreement shows up.
    const expected = {
      // One tool, several operations: the arguments tell a `view` (a read)
      // from a `str_replace` (an edit), and a call always carries a `command`
      // and a `path` — so the required arguments alone read as a read.
      str_replace_editor: 'read',
    };
    const disagreements: Record<string, string> = {};
    for (const tool of declared) {
      if (!MOUNTED.includes(tool.name)) continue;
      const byArguments = shapeKindOf(requiredArguments(tool.required));
      if (byArguments !== undefined && byArguments !== kindByTable(tool.name)) {
        disagreements[tool.name] = byArguments;
      }
    }
    expect(disagreements).toEqual(expected);
  });
});
