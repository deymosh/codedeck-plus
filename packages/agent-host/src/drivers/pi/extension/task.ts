/**
 * `task`: a sub-agent — a second Pi with a fresh context — that works on one
 * job and answers with its conclusion. It keeps searching and reading out of
 * the main conversation, and several run at once when the model asks for
 * several in one message (Pi runs a message's tool calls in parallel).
 *
 * Each runs as a child Pi in RPC mode, with no session file, loading this
 * same extension in its sub-agent form (`CODEDECK_PI_SUBAGENT`): the
 * permission gate and the provider profile, nothing that talks to the user.
 * This tool is the child's RPC client:
 *
 * - every tool call the child wants to run comes up as the gate's dialog and
 *   is handed to the driver as a `permission` request, so the session's mode
 *   decides it and a card, when one is needed, names the sub-agent. A
 *   sub-agent never runs anything its parent could not;
 * - what the child does (its tool calls, their results, its replies) goes to
 *   the driver as this call's progress, one event per update, and the phone
 *   shows it under the `task` call;
 * - its last reply is the tool's result.
 *
 * Two kinds: `explore` runs with Pi's read-only tools only — it can change
 * nothing, so it never needs a card — and `general` with the session's own
 * built-in tools.
 */
import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { request, type RequestUi } from './channel';
import { PROVIDER_TOKEN_FD } from './provider';
import {
  PI_PERMISSION_PREFIX,
  PI_TOOL,
  type PiPermissionReply,
  type PiSubagent,
} from './protocol';

/** The variable a child Pi finds its kind in; set, the extension loads in
 *  its sub-agent form. */
export const SUBAGENT_ENV = 'CODEDECK_PI_SUBAGENT';
/** The variable the driver names the extension file in, so a child loads
 *  the same one. */
export const EXTENSION_ENV = 'CODEDECK_PI_EXTENSION';

export const SUBAGENT_KINDS = ['explore', 'general'] as const;
export type SubagentKind = (typeof SUBAGENT_KINDS)[number];

/** Pi's own tools that only read. */
const READ_ONLY_BUILTINS = ['read', 'grep', 'find', 'ls'];
/** Every built-in tool name Pi has, so a child gets the session's built-ins
 *  and none of the parent-only tools this extension adds. */
const BUILTINS = new Set(['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls']);

/** The most of a sub-agent's answer the parent's model reads. */
const MAX_RESULT_CHARS = 50_000;
/** How long a child may take to stop after an abort before it is killed. */
const KILL_AFTER_MS = 3_000;

/** One thing the sub-agent did, as this call's progress carries it. */
export type SubagentEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; callId: string; toolName: string; args: Record<string, unknown> }
  // `patch`: an edit's unified patch (Pi's `details.patch`), for its diff card.
  | { kind: 'tool_result'; callId: string; text: string; isError: boolean; patch?: string };

/** The details of one progress update: who, which event, in order. */
export interface SubagentUpdate {
  subagent: PiSubagent;
  seq: number;
  event: SubagentEvent;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function textOf(content: unknown): string {
  return (Array.isArray(content) ? content : [])
    .flatMap((block) => {
      const part = record(block);
      return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [];
    })
    .join('\n');
}

export interface ChildOptions {
  /** `node` and the Pi CLI the parent runs as. */
  command: string;
  cli: string;
  extension: string;
  kind: SubagentKind;
  tools: string[];
  model?: string;
  thinking?: string;
  cwd: string;
  env: Record<string, string | undefined>;
  /** The provider profile's token, handed to the child on its own pipe
   *  (provider.ts), never in its environment. */
  token?: string;
  prompt: string;
  subagent: PiSubagent;
  ui: RequestUi;
  signal?: AbortSignal;
  onEvent(event: SubagentEvent): void;
  /** Spawn seam for tests. */
  spawnFn?: typeof spawn;
}

/** Run one sub-agent to its end: its last reply, or why it failed. */
export function runSubagent(options: ChildOptions): Promise<{ text: string; error?: string }> {
  const args = [
    options.cli,
    '--mode',
    'rpc',
    '--no-session',
    '--offline',
    '-e',
    options.extension,
    '--tools',
    options.tools.join(','),
    ...(options.model ? ['--model', options.model] : []),
    ...(options.thinking ? ['--thinking', options.thinking] : []),
  ];
  const child = (options.spawnFn ?? spawn)(options.command, args, {
    cwd: options.cwd,
    env: { ...options.env, [SUBAGENT_ENV]: options.kind },
    stdio: options.token !== undefined ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  });
  if (options.token !== undefined) {
    const pipe = child.stdio[PROVIDER_TOKEN_FD] as Writable | null | undefined;
    // A child that died before reading it closes the pipe; its exit says why.
    pipe?.on('error', () => {});
    pipe?.end(options.token);
  }

  return new Promise((resolve) => {
    const facts = new Map<string, { toolName: string; args: Record<string, unknown> }>();
    let lastText = '';
    let error: string | undefined;
    let stderr = '';
    let pending = '';
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const send = (line: Record<string, unknown>): void => {
      if (!child.stdin || child.stdin.destroyed) return;
      child.stdin.write(`${JSON.stringify(line)}\n`);
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', abort);
      child.stdin?.end();
      resolve({ text: lastText, ...(error !== undefined ? { error } : {}) });
    };
    const abort = (): void => {
      error = 'The sub-agent was stopped.';
      send({ type: 'abort' });
      child.stdin?.end();
      killTimer = setTimeout(() => child.kill(), KILL_AFTER_MS);
      finish();
    };

    const permission = async (id: string, callId: string): Promise<void> => {
      const fact = facts.get(callId);
      const reply = await request<PiPermissionReply>(options.ui, {
        op: 'permission',
        subagent: options.subagent,
        callId,
        toolName: fact?.toolName ?? 'tool',
        input: fact?.args ?? {},
      });
      send({ type: 'extension_ui_response', id, value: reply?.allow ? 'allow' : reply?.plan ? 'plan' : 'deny' });
    };

    const handle = (rec: Record<string, unknown>): void => {
      switch (rec.type) {
        case 'response':
          if (rec.command === 'prompt' && rec.success === false) {
            error = typeof rec.error === 'string' ? rec.error : 'the sub-agent refused the task';
            finish();
          }
          return;
        case 'message_end': {
          const message = record(rec.message);
          if (message?.role !== 'assistant') return;
          if (message.stopReason === 'error' && typeof message.errorMessage === 'string') error = message.errorMessage;
          const text = textOf(message.content).trim();
          if (text !== '') {
            lastText = text;
            error = undefined;
            options.onEvent({ kind: 'text', text });
          }
          return;
        }
        case 'tool_execution_start': {
          const callId = typeof rec.toolCallId === 'string' ? rec.toolCallId : undefined;
          const toolName = typeof rec.toolName === 'string' ? rec.toolName : undefined;
          if (!callId || !toolName) return;
          const callArgs = record(rec.args) ?? {};
          facts.set(callId, { toolName, args: callArgs });
          options.onEvent({ kind: 'tool_call', callId, toolName, args: callArgs });
          return;
        }
        case 'tool_execution_end': {
          const callId = typeof rec.toolCallId === 'string' ? rec.toolCallId : undefined;
          if (!callId) return;
          facts.delete(callId);
          const patch = record(record(rec.result)?.details)?.patch;
          options.onEvent({
            kind: 'tool_result',
            callId,
            text: textOf(record(rec.result)?.content),
            isError: rec.isError === true,
            ...(typeof patch === 'string' ? { patch } : {}),
          });
          return;
        }
        case 'extension_ui_request': {
          const id = typeof rec.id === 'string' ? rec.id : undefined;
          if (!id) return;
          const title = typeof rec.title === 'string' ? rec.title : '';
          if (rec.method === 'select' && title.startsWith(PI_PERMISSION_PREFIX)) {
            void permission(id, title.slice(PI_PERMISSION_PREFIX.length)).catch(() => {
              send({ type: 'extension_ui_response', id, value: 'deny' });
            });
            return;
          }
          // Nothing else in a sub-agent may ask the user: its dialogs close.
          if (rec.method === 'select' || rec.method === 'confirm' || rec.method === 'input' || rec.method === 'editor') {
            send({ type: 'extension_ui_response', id, cancelled: true });
          }
          return;
        }
        case 'agent_settled':
          finish();
          return;
        default:
          return;
      }
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      pending += chunk;
      for (;;) {
        const end = pending.indexOf('\n');
        if (end < 0) break;
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        if (line === '') continue;
        try {
          const rec = record(JSON.parse(line));
          if (rec) handle(rec);
        } catch {
          // Not a record: Pi writes only JSON lines in RPC mode.
        }
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2_000);
    });
    child.on('error', (failure: Error) => {
      error = `the sub-agent could not start: ${failure.message}`;
      finish();
    });
    child.on('exit', (code) => {
      if (killTimer) clearTimeout(killTimer);
      if (!settled && error === undefined) {
        error = `the sub-agent exited (${code ?? 'killed'})${stderr.trim() ? `: ${stderr.trim().split('\n').at(-1)}` : ''}`;
      }
      finish();
    });

    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener('abort', abort, { once: true });
    send({ id: 'codedeck-task', type: 'prompt', message: options.prompt });
  });
}

/**
 * The task's result from how its sub-agent ended. One that failed or was
 * stopped did not finish its job, even if it said something first: the call
 * fails, with what it said as context rather than as its conclusion.
 */
export function taskResult(result: { text: string; error?: string }): string {
  if (result.error !== undefined) {
    throw new Error(
      result.text === '' ? result.error : `${result.error}\n\nIts last reply before that:\n${result.text.slice(0, MAX_RESULT_CHARS)}`,
    );
  }
  if (result.text === '') return '(the sub-agent said nothing)';
  return result.text.length > MAX_RESULT_CHARS ? `${result.text.slice(0, MAX_RESULT_CHARS)}\n\n[truncated]` : result.text;
}

/**
 * The tools a child of `kind` runs with, from the session's active ones. A
 * plain `--tools` list is the whole selection, so a general child names
 * `web_fetch` (which its extension registers) as well; nothing else of this
 * extension's is a child's.
 */
export function subagentTools(kind: SubagentKind, active: readonly string[]): string[] {
  const builtins = active.filter((name) => BUILTINS.has(name));
  if (kind === 'explore') return builtins.filter((name) => READ_ONLY_BUILTINS.includes(name));
  return active.includes(PI_TOOL.webFetch) ? [...builtins, PI_TOOL.webFetch] : builtins;
}

export function registerTask(
  pi: Pick<ExtensionAPI, 'registerTool' | 'getActiveTools'>,
  env: Record<string, string | undefined>,
  token?: string,
): void {
  pi.registerTool({
    name: PI_TOOL.task,
    label: 'Sub-agent',
    description:
      'Hand one self-contained job to a sub-agent with a fresh context, and get its conclusion back. ' +
      "Use 'explore' to search and read the code (it can change nothing and needs no approval), 'general' " +
      'for work that edits or runs things (its tool calls ask like yours do). Several task calls in one ' +
      'message run in parallel. The prompt is all the sub-agent knows: say what to find or do, what is ' +
      'already known, and what to report back.',
    promptSnippet: 'task: run a sub-agent (explore = read-only search; general = full tools)',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'The job in three to five words.' },
        prompt: { type: 'string', description: 'The full brief for the sub-agent.' },
        agent: { type: 'string', enum: [...SUBAGENT_KINDS], description: "The kind; 'explore' when omitted." },
      },
      required: ['description', 'prompt'],
    } as never,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const input = params as { description?: unknown; prompt?: unknown; agent?: unknown };
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      if (prompt === '') throw new Error('task needs a prompt');
      const kind: SubagentKind = input.agent === 'general' ? 'general' : 'explore';
      const extension = env[EXTENSION_ENV];
      const cli = process.argv[1];
      if (!extension || !cli) throw new Error('sub-agents are not available in this session');
      const subagent: PiSubagent = { label: kind, parentCallId: toolCallId };
      let seq = 0;
      const result = await runSubagent({
        command: process.execPath,
        cli,
        extension,
        kind,
        tools: subagentTools(kind, pi.getActiveTools()),
        ...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
        ...(ctx.thinkingLevel ? { thinking: String(ctx.thinkingLevel) } : {}),
        cwd: ctx.cwd,
        env,
        ...(token !== undefined ? { token } : {}),
        prompt,
        subagent,
        ui: ctx.ui,
        ...(signal ? { signal } : {}),
        onEvent: (event) => {
          const details: SubagentUpdate = { subagent, seq: ++seq, event };
          onUpdate?.({ content: [{ type: 'text', text: '' }], details } as never);
        },
      });
      return { content: [{ type: 'text', text: taskResult(result) }], details: { subagent } };
    },
  });
}
