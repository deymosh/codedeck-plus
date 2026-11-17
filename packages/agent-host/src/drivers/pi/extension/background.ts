/**
 * Background shells: a command that keeps running after its tool call
 * returns — a dev server, a watcher, a long test run — whose output the model
 * reads later and which it, or the user from the phone, can stop. Pi's
 * `bash` blocks the turn until the command ends, which a server never does.
 *
 * - `bash_background` starts one in the session's directory, in the
 *   session's own shell as Pi resolves it: bash (Git Bash on Windows), or
 *   PowerShell where that is the session's shell — or whichever the model
 *   names. It asks like any command.
 * - `task_output` reads what it printed (the newest part, at most 1 MB is
 *   kept), optionally waiting for it to end.
 * - `task_stop` stops it with everything it started.
 *
 * The phone sees each one as a background task: its start and its end
 * travel as the extension's out-of-turn events (`pi.appendEntry`, protocol.ts),
 * since a task ends whenever it ends — often after the turn. The phone's stop
 * button reaches the process directly: the driver kills it by the pid the
 * start event names (killTree), on the same machine. Everything still running
 * when Pi exits is stopped with it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { PI_TOOL } from './protocol';

/** The output kept per task: its newest megabyte. */
const MAX_OUTPUT_CHARS = 1_000_000;
/** What `task_output` returns when the model does not say. */
const DEFAULT_TAIL_CHARS = 20_000;
/** The longest `task_output` waits for a task to end. */
const MAX_WAIT_SECONDS = 600;

/** How Pi runs a shell command (its `getShellConfig`). */
export interface ShellConfig {
  shell: string;
  args: string[];
  commandTransport?: 'argv' | 'stdin';
}

/** One background task's start or end, as the driver reads it. */
export interface TaskEvent {
  kind: 'task';
  taskId: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  title: string;
  pid?: number;
  callId?: string;
  summary?: string;
}

interface Task {
  id: string;
  title: string;
  child: ChildProcess;
  output: string;
  status: TaskEvent['status'];
  exitCode: number | null;
  stopping: boolean;
  ended: Promise<void>;
}

/**
 * Kill a process and everything it started. On Windows, `taskkill /T` from
 * System32 (not whatever `taskkill` PATH finds); elsewhere the process
 * group, which a background task leads (it is spawned detached).
 */
export function killTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', () => {});
    } catch {
      // Already gone.
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
}

export const BACKGROUND_SHELLS = ['bash', 'powershell'] as const;
export type BackgroundShell = (typeof BACKGROUND_SHELLS)[number];

/**
 * The shell a task runs in: the one asked for, else the session's own shell
 * tool — bash when the session has it, PowerShell when that is its only
 * shell (a Windows machine without Git Bash) — so the command is written in
 * the syntax the model already uses.
 */
export function backgroundShell(asked: unknown, active: readonly string[]): BackgroundShell {
  if (asked === 'bash' || asked === 'powershell') return asked;
  return !active.includes('bash') && active.includes('powershell') ? 'powershell' : 'bash';
}

export interface BackgroundDeps {
  /** How Pi runs each shell (its `getShellConfig`, `getPowerShellConfig`);
   *  each throws where that shell is not on the machine. */
  shells: Record<BackgroundShell, () => ShellConfig>;
  /** The session's active tools, to pick its own shell. */
  active(): string[];
  /** The out-of-turn event channel (`pi.appendEntry`). */
  report(event: TaskEvent): void;
  env?: NodeJS.ProcessEnv;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function registerBackground(pi: Pick<ExtensionAPI, 'registerTool'>, deps: BackgroundDeps): void {
  const tasks = new Map<string, Task>();
  const prefix = `bg-${Date.now().toString(36)}`;
  let next = 0;

  // A task must not outlive the Pi that started it: nobody could read or
  // stop it any more.
  process.once('exit', () => {
    for (const task of tasks.values()) {
      if (task.status === 'running' && task.child.pid !== undefined) killTree(task.child.pid);
    }
  });

  const start = (command: string, title: string, cwd: string, callId: string, which: BackgroundShell): Task => {
    let shell: ShellConfig;
    try {
      shell = deps.shells[which]();
    } catch (error) {
      const other = which === 'bash' ? 'powershell' : 'bash';
      throw new Error(
        `${which} is not available here (${error instanceof Error ? error.message : String(error)}); try shell: "${other}"`,
      );
    }
    const viaStdin = shell.commandTransport === 'stdin';
    const child = spawn(shell.shell, viaStdin ? shell.args : [...shell.args, command], {
      cwd,
      env: deps.env ?? process.env,
      // Its own process group, so stopping it reaches what it started.
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: [viaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    if (viaStdin) child.stdin?.end(command);
    const id = `${prefix}-${++next}`;
    let settle!: () => void;
    const task: Task = {
      id,
      title,
      child,
      output: '',
      status: 'running',
      exitCode: null,
      stopping: false,
      ended: new Promise<void>((resolve) => (settle = resolve)),
    };
    const append = (chunk: Buffer): void => {
      task.output = (task.output + chunk.toString('utf8')).slice(-MAX_OUTPUT_CHARS);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const end = (code: number | null, failure?: string): void => {
      if (task.status !== 'running') return;
      task.exitCode = code;
      task.status = task.stopping ? 'stopped' : code === 0 ? 'completed' : 'failed';
      const summary = failure ?? (task.status === 'stopped' ? 'Stopped' : `Exited with code ${code ?? 'unknown'}`);
      deps.report({ kind: 'task', taskId: id, status: task.status, title, summary });
      settle();
    };
    child.on('error', (error) => end(null, `Could not start: ${error.message}`));
    child.on('close', (code) => end(code));
    tasks.set(id, task);
    deps.report({ kind: 'task', taskId: id, status: 'running', title, callId, ...(child.pid !== undefined ? { pid: child.pid } : {}) });
    return task;
  };

  const find = (id: unknown): Task => {
    const task = tasks.get(str(id));
    if (!task) throw new Error(`there is no background task '${str(id)}' in this session`);
    return task;
  };

  const describe = (task: Task): string =>
    task.status === 'running'
      ? `Task ${task.id} is running.`
      : `Task ${task.id} ${task.status === 'stopped' ? 'was stopped' : `exited with code ${task.exitCode ?? 'unknown'}`}.`;

  pi.registerTool({
    name: PI_TOOL.bashBackground,
    label: 'Background shell',
    description:
      'Start a shell command that keeps running in the background (a dev server, a watcher, a long build or test run) ' +
      'and return at once with its task id. Read its output with task_output and stop it with task_stop. ' +
      'Use bash for commands that finish.',
    promptSnippet: `${PI_TOOL.bashBackground}: start a long-running command in the background`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command, in the syntax of the shell it runs in.' },
        description: { type: 'string', description: 'What it is, in a few words ("Dev server").' },
        shell: {
          type: 'string',
          enum: [...BACKGROUND_SHELLS],
          description: "The shell: the session's own shell tool when omitted (bash, or PowerShell where that is the only one).",
        },
      },
      required: ['command'],
    } as never,
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const input = params as { command?: unknown; description?: unknown; shell?: unknown };
      const command = str(input.command).trim();
      if (command === '') throw new Error(`${PI_TOOL.bashBackground} needs a command`);
      const title = str(input.description).trim() || command;
      const task = start(command, title, ctx.cwd, toolCallId, backgroundShell(input.shell, deps.active()));
      return {
        content: [
          {
            type: 'text',
            text: `Started background task ${task.id}. Read its output with ${PI_TOOL.taskOutput}; stop it with ${PI_TOOL.taskStop}.`,
          },
        ],
        details: { taskId: task.id },
      };
    },
  });

  pi.registerTool({
    name: PI_TOOL.taskOutput,
    label: 'Task output',
    description:
      'Read what a background task printed (its newest output) and whether it is still running. ' +
      '`wait` (seconds) waits for it to end first, up to that long.',
    promptSnippet: `${PI_TOOL.taskOutput}: read a background task's output`,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task id.' },
        wait: { type: 'number', description: `Seconds to wait for it to end, at most ${MAX_WAIT_SECONDS}.` },
        tail: { type: 'number', description: `How many of the last characters to return (default ${DEFAULT_TAIL_CHARS}).` },
      },
      required: ['id'],
    } as never,
    async execute(_toolCallId, params, signal) {
      const input = params as { id?: unknown; wait?: unknown; tail?: unknown };
      const task = find(input.id);
      const wait = Math.min(MAX_WAIT_SECONDS, Math.max(0, Number(input.wait) || 0));
      if (wait > 0 && task.status === 'running') {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, wait * 1000);
          const done = (): void => {
            clearTimeout(timer);
            resolve();
          };
          void task.ended.then(done);
          signal?.addEventListener('abort', done, { once: true });
        });
      }
      const tail = Math.max(1_000, Math.min(MAX_OUTPUT_CHARS, Number(input.tail) || DEFAULT_TAIL_CHARS));
      const output = task.output.length > tail ? `[… ${task.output.length - tail} earlier characters]\n${task.output.slice(-tail)}` : task.output;
      return {
        content: [{ type: 'text', text: `${describe(task)}\n\n${output || '(no output yet)'}` }],
        details: { taskId: task.id, status: task.status, exitCode: task.exitCode },
      };
    },
  });

  pi.registerTool({
    name: PI_TOOL.taskStop,
    label: 'Stop task',
    description: 'Stop a background task and everything it started.',
    promptSnippet: `${PI_TOOL.taskStop}: stop a background task`,
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The task id.' } },
      required: ['id'],
    } as never,
    async execute(_toolCallId, params) {
      const task = find((params as { id?: unknown }).id);
      if (task.status === 'running' && task.child.pid !== undefined) {
        task.stopping = true;
        killTree(task.child.pid);
        await Promise.race([task.ended, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      }
      return { content: [{ type: 'text', text: describe(task) }], details: { taskId: task.id, status: task.status } };
    },
  });
}
