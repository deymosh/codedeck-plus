/**
 * Qwen Code's background shells, as `background_task` entries.
 *
 * Its `run_shell_command` takes `is_background`; over ACP (verified against
 * 0.27.1) such a call completes at once with a text result naming the shell
 * (`Background shell started.\nid: bg_…\npid: …\noutput file: …`), and its
 * end arrives later, outside any turn, as an `agent_message_chunk` whose
 * `_meta.backgroundTask` says how it went (`{taskId, status, kind,
 * commandLabel}`; status `completed`, `failed` or `cancelled`). Qwen Code
 * sends no `shell_output` update for it — the output stays in its file.
 *
 * The same end is then repeated as the first message of a turn Qwen Code
 * starts by itself to tell the model (`_meta.source` `background_notification`,
 * inside `_qwencode/start_turn` … `_qwencode/end_turn`): that copy is dropped,
 * while the model's reply (`background_notification_response`) is the
 * conversation and stays.
 */
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { OutputEntry, TaskKind, TaskStatus } from '../../sdk/types';
import { now } from '../../sdk/tools';

/** The bracket Qwen Code puts around a turn it starts by itself: a request
 *  that asks to be admitted, and the notification that ends it. */
export const START_TURN_METHOD = '_qwencode/start_turn';
export const END_TURN_METHOD = '_qwencode/end_turn';

/**
 * The only answer that keeps Qwen Code from running such a turn: anything
 * else — `-32601` included — admits it, and the model is asked. Refused, it
 * retries three times (1, 2 and 4 s later), then keeps the result for the
 * conversation's next message.
 */
export const TURN_REFUSED = { accepted: false } as const;

/** The shell tool, and the argument that sends it to the background. */
const SHELL_TOOL = 'run_shell_command';

/** How a started background shell's result names it. */
const STARTED = /^Background shell started\.\s*\nid: (\S+)/;

/** What Qwen Code says about a task it ended or started. */
interface BackgroundTaskMeta {
  taskId?: unknown;
  status?: unknown;
  kind?: unknown;
  commandLabel?: unknown;
}

/** A background task this session announced. */
interface KnownTask {
  kind: TaskKind;
  /** Qwen Code's own kind, which its cancel names the task by. */
  agentKind: string;
  title: string;
  callId?: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function kindOf(agentKind: string): TaskKind {
  if (agentKind === 'shell') return 'shell';
  if (agentKind === 'agent') return 'agent';
  return 'other';
}

function statusOf(status: string): TaskStatus {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  return 'stopped';
}

export class QwenBackgroundTasks {
  /** Background shell calls by tool call id: their command, once known. */
  private readonly calls = new Map<string, string>();
  private readonly tasks = new Map<string, KnownTask>();

  /** Qwen Code's kind for a task, for its cancel; undefined when this
   *  session never saw it start or saw it end. */
  agentKindOf(taskId: string): string | undefined {
    return this.tasks.get(taskId)?.agentKind;
  }

  /**
   * What one update adds or takes away: `entries` to show besides the
   * update's own, and `drop` when the update itself is a copy the
   * transcript already has.
   */
  read(update: SessionUpdate): { entries: OutputEntry[]; drop: boolean } {
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      return { entries: this.readCall(update), drop: false };
    }
    if (update.sessionUpdate !== 'agent_message_chunk') return { entries: [], drop: false };
    const meta = (update as { _meta?: { source?: unknown; backgroundTask?: unknown } | null })._meta;
    const task = meta?.backgroundTask as BackgroundTaskMeta | undefined;
    if (!task || typeof task !== 'object') return { entries: [], drop: false };
    switch (meta?.source) {
      case 'background_task_completed': {
        const text = update.content.type === 'text' ? update.content.text.trim() : '';
        return { entries: this.ended(task, text), drop: true };
      }
      case 'background_notification':
        return { entries: [], drop: true };
      default:
        return { entries: [], drop: false };
    }
  }

  private readCall(update: Extract<SessionUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }>): OutputEntry[] {
    const meta = (update as { _meta?: { toolName?: unknown } | null })._meta;
    const input = update.rawInput as { command?: unknown; is_background?: unknown } | undefined;
    if (str(meta?.toolName) === SHELL_TOOL && input?.is_background === true) {
      this.calls.set(update.toolCallId, str(input.command));
    }
    // A call that failed (refused, say) started no shell, and is done with.
    if (update.status === 'failed') this.calls.delete(update.toolCallId);
    if (update.status !== 'completed' || !this.calls.has(update.toolCallId)) return [];
    const result = (update.content ?? [])
      .map((c) => (c.type === 'content' && c.content.type === 'text' ? c.content.text : ''))
      .join('');
    const id = STARTED.exec(result)?.[1];
    const command = this.calls.get(update.toolCallId) ?? '';
    this.calls.delete(update.toolCallId);
    if (!id) return [];
    const task: KnownTask = { kind: 'shell', agentKind: 'shell', title: command || 'Background shell', callId: update.toolCallId };
    this.tasks.set(id, task);
    return [entry(id, task, 'running')];
  }

  private ended(meta: BackgroundTaskMeta, text: string): OutputEntry[] {
    const taskId = str(meta.taskId);
    if (!taskId) return [];
    const agentKind = str(meta.kind) || 'shell';
    // One that started before this session was attached to it (a resumed
    // conversation) still ends on the phone.
    const task = this.tasks.get(taskId) ?? {
      kind: kindOf(agentKind),
      agentKind,
      title: str(meta.commandLabel) || 'Background task',
    };
    this.tasks.delete(taskId);
    return [entry(taskId, task, statusOf(str(meta.status)), text || undefined)];
  }
}

function entry(taskId: string, task: KnownTask, status: TaskStatus, summary?: string): OutputEntry {
  return {
    entryType: 'background_task',
    taskId,
    kind: task.kind,
    title: task.title,
    status,
    ...(task.callId ? { callId: task.callId } : {}),
    ...(summary ? { summary } : {}),
    timestamp: now(),
  };
}
