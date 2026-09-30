/**
 * Translates Claude Agent SDK messages into protocol v11 `OutputEntry`
 * objects — typed, agent-neutral transcript entries the Nostr layer publishes
 * to the phone.
 *
 * Interactive cards (permission requests, questions, plan approval) are NOT
 * produced here: the permission broker emits them when the agent actually
 * waits on the user, and resolves them when it stops waiting. This module only
 * hides the tool calls behind those cards so they do not also render as
 * ordinary tool actions.
 */
import { todosOf, toolInput, toolKindOf, toolLocations, toolTitle } from '../../tools';
import {
  MAX_DIFF_LINES,
  toDiffLines,
  truncateToolResult,
  type DiffPayload,
  type KnownTask,
  type TranslateContext,
} from '../../transcript';
import type { DiffLine, OutputEntry, Subagent, TaskKind, TaskStatus } from '../../types';
import type {
  SdkMessage,
  SdkAssistantMessage,
  SdkUserMessage,
  SdkResultMessage,
  SdkResultError,
  SdkSystemMessage,
  SdkSessionStateChangedMessage,
} from './facade';

/**
 * Convert a single SDKMessage into zero or more OutputEntry objects.
 * Returns an empty array for message types we don't relay (stream_event, …).
 */
export function sdkMessageToEntries(msg: SdkMessage, ctx: TranslateContext): OutputEntry[] {
  switch (msg.type) {
    case 'assistant':
      return parseAssistant(msg as SdkAssistantMessage, ctx);
    case 'user':
      return parseUser(msg as SdkUserMessage, ctx);
    case 'result':
      return parseResult(msg as SdkResultMessage);
    case 'system': {
      const subtype = (msg as { subtype?: string }).subtype ?? '';
      if (subtype.startsWith('task_') || subtype === 'background_tasks_changed') {
        return parseTask(msg as unknown as Record<string, unknown>, ctx);
      }
      return parseSystem(msg as SdkSystemMessage | SdkSessionStateChangedMessage);
    }
    default:
      // stream_event, auth_status, task_notification, etc. — skip
      return [];
  }
}

/** A sub-agent's entries name the call that started it (the SDK's
 *  `parent_tool_use_id`) and, when that call said, the sub-agent's kind. */
function subagentField(parent: string | null | undefined, ctx: TranslateContext): { subagent?: Subagent } {
  if (!parent) return {};
  const label = ctx.subagentLabels.get(parent);
  return { subagent: { ...(label ? { label } : {}), parentCallId: parent } };
}

function parseAssistant(msg: SdkAssistantMessage, ctx: TranslateContext): OutputEntry[] {
  const entries: OutputEntry[] = [];
  const ts = new Date().toISOString();

  const sub = subagentField(msg.parent_tool_use_id, ctx);

  for (const block of msg.message.content) {
    if (block.type === 'text') {
      entries.push({
        entryType: 'text',
        role: 'agent',
        text: block.text,
        timestamp: ts,
        ...sub,
      });
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      // Redacted thinking has no readable text; the flag lets the phone show a
      // placeholder instead of nothing.
      const redacted = block.type === 'redacted_thinking';
      entries.push({
        entryType: 'thinking',
        text: redacted ? '' : (block as { thinking?: string }).thinking ?? '',
        timestamp: ts,
        ...(redacted ? { redacted: true } : {}),
        ...sub,
      });
    } else if (block.type === 'tool_use') {
      const input = (block.input ?? {}) as Record<string, unknown>;
      if (block.name === 'ExitPlanMode') {
        ctx.hiddenCallIds.add(block.id);
        const plan = typeof input.plan === 'string' ? input.plan : '';
        if (plan) entries.push({ entryType: 'plan', text: plan, timestamp: ts });
      } else if (block.name === 'AskUserQuestion') {
        ctx.hiddenCallIds.add(block.id);
      } else {
        if (toolKindOf(block.name) === 'agent' && typeof input.subagent_type === 'string' && input.subagent_type) {
          ctx.subagentLabels.set(block.id, input.subagent_type);
        }
        const full = toolInput(block.name, input);
        entries.push({
          entryType: 'tool_call',
          callId: block.id,
          toolName: block.name,
          kind: toolKindOf(block.name),
          title: toolTitle(block.name, input),
          ...withLocations(toolLocations(input)),
          ...(full !== undefined ? { input: full } : {}),
          timestamp: ts,
          ...sub,
        });
        const todos = todosOf(input);
        if (todos) entries.push({ entryType: 'todos', items: todos, callId: block.id, timestamp: ts, ...sub });
        // A colored diff card for file edits, alongside the tool call (the
        // tool group keeps its action; the diff renders as its own card).
        const diff = extractDiff(block.name, input);
        if (diff) {
          entries.push({
            entryType: 'diff',
            ...diff,
            callId: block.id,
            timestamp: ts,
            ...sub,
          });
        }
      }
    }
  }

  return entries;
}

function withLocations(locations: string[]): { locations?: string[] } {
  return locations.length > 0 ? { locations } : {};
}

function parseUser(msg: SdkUserMessage, ctx: TranslateContext): OutputEntry[] {
  const entries: OutputEntry[] = [];
  const ts = new Date().toISOString();
  const content = msg.message.content;
  // A sub-agent's prompt comes from the main agent, not the user, and its
  // call already carries it as input: it is not shown again.
  const isSubAgent = !!msg.parent_tool_use_id;
  const text = (t: string): OutputEntry[] =>
    isSubAgent ? [] : [{ entryType: 'text', role: 'user', text: t, timestamp: ts }];

  if (typeof content === 'string') {
    entries.push(...text(content));
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text') {
        entries.push(...text(block.text));
      } else if (block.type === 'tool_result') {
        if (ctx.hiddenCallIds.has(block.tool_use_id)) continue;
        const resultText = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content
                .filter((c: { type: string }): c is { type: 'text'; text: string } => c.type === 'text')
                .map((c: { text: string }) => c.text)
                .join('\n')
            : '';
        if (resultText) {
          entries.push({
            entryType: 'tool_result',
            callId: block.tool_use_id,
            text: truncateToolResult(resultText),
            ...(block.is_error ? { isError: true } : {}),
            timestamp: ts,
          });
        }
      }
    }
  }

  return entries;
}

function parseResult(msg: SdkResultMessage): OutputEntry[] {
  const ts = new Date().toISOString();
  if (msg.subtype !== 'success') {
    // Error variants: error_during_execution, error_max_turns, etc.
    const errorMsg = msg as SdkResultError;
    return [{
      entryType: 'error',
      text: errorMsg.errors?.join('\n') || msg.subtype,
      timestamp: ts,
      agentExtras: { errorType: msg.subtype },
    }];
  }
  // When several queued background-task completions are answered by one
  // model call, the SDK still emits a result per completion, but every one
  // except the last is empty (num_turns: 0). Those carry no turn and no cost,
  // so they get no summary row.
  if (msg.num_turns === 0) return [];
  return [{
    entryType: 'status',
    text: `Session complete — ${msg.num_turns} turns, $${msg.total_cost_usd.toFixed(4)}`,
    timestamp: ts,
    agentExtras: {
      durationMs: msg.duration_ms,
      numTurns: msg.num_turns,
      totalCostUsd: msg.total_cost_usd,
    },
  }];
}

function parseSystem(msg: SdkSystemMessage | SdkSessionStateChangedMessage): OutputEntry[] {
  if (msg.subtype === 'init') {
    return [{
      entryType: 'status',
      text: `Claude Code ${msg.claude_code_version} (${msg.model})`,
      timestamp: new Date().toISOString(),
    }];
  }

  // What a hook says to the user (its `systemMessage`): "PreToolUse:Bash
  // says: …".
  if ((msg as { subtype?: string }).subtype === 'informational') {
    const content = (msg as unknown as { content?: unknown }).content;
    if (typeof content === 'string' && content.trim()) {
      return [{ entryType: 'status', text: content.trim(), timestamp: new Date().toISOString() }];
    }
    return [];
  }

  // The SDK reporting the session idle is the authoritative "turn over,
  // waiting for input" signal (the phone's unread dot / notification).
  if (msg.subtype === 'session_state_changed') {
    const stateMsg = msg as unknown as { state: string };
    if (stateMsg.state === 'idle') {
      return [{ entryType: 'turn_complete', timestamp: new Date().toISOString() }];
    }
    return [];
  }

  return [];
}

// --- Background tasks ---

function taskKindOf(taskType: unknown): TaskKind {
  if (taskType === 'local_bash') return 'shell';
  if (taskType === 'local_agent' || taskType === 'remote_agent') return 'agent';
  return 'other';
}

function taskEntry(taskId: string, task: KnownTask, status: TaskStatus, summary?: string): OutputEntry {
  return {
    entryType: 'background_task',
    taskId,
    kind: task.kind,
    title: task.title,
    status,
    ...(task.callId ? { callId: task.callId } : {}),
    ...(summary ? { summary } : {}),
    timestamp: new Date().toISOString(),
  };
}

function announce(taskId: string, task: KnownTask): OutputEntry[] {
  if (task.announced) return [];
  task.announced = true;
  return [taskEntry(taskId, task, 'running')];
}

/**
 * The SDK's task messages as `background_task` entries. Every task is
 * remembered from `task_started`, but only one running in the background
 * is reported: started there, or moved there later (`task_updated`), or
 * found running by a `background_tasks_changed` snapshot (after a resume).
 * Its end comes from `task_notification`, which carries how it went. A task
 * the SDK marks ambient (housekeeping) is never reported.
 */
function parseTask(msg: Record<string, unknown>, ctx: TranslateContext): OutputEntry[] {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const taskId = str(msg.task_id);
  switch (msg.subtype) {
    case 'task_started': {
      if (!taskId || msg.ambient || msg.skip_transcript) return [];
      const callId = str(msg.tool_use_id);
      const task: KnownTask = {
        kind: taskKindOf(msg.task_type),
        title: str(msg.description) || 'Background task',
        ...(callId ? { callId } : {}),
        announced: false,
      };
      ctx.tasks.set(taskId, task);
      return msg.is_backgrounded === true ? announce(taskId, task) : [];
    }
    case 'task_updated': {
      const task = ctx.tasks.get(taskId);
      const patch = (msg.patch ?? {}) as Record<string, unknown>;
      if (!task) return [];
      if (str(patch.description)) task.title = str(patch.description);
      return patch.is_backgrounded === true ? announce(taskId, task) : [];
    }
    case 'task_notification': {
      const task = ctx.tasks.get(taskId);
      ctx.tasks.delete(taskId);
      if (!task?.announced) return [];
      const status: TaskStatus = msg.status === 'completed' ? 'completed' : msg.status === 'failed' ? 'failed' : 'stopped';
      return [taskEntry(taskId, task, status, str(msg.summary) || undefined)];
    }
    case 'background_tasks_changed': {
      const out: OutputEntry[] = [];
      for (const raw of Array.isArray(msg.tasks) ? msg.tasks : []) {
        const t = raw as Record<string, unknown>;
        const id = str(t.task_id);
        if (!id || t.ambient) continue;
        let task = ctx.tasks.get(id);
        if (!task) {
          task = { kind: taskKindOf(t.task_type), title: str(t.description) || 'Background task', announced: false };
          ctx.tasks.set(id, task);
        }
        out.push(...announce(id, task));
      }
      return out;
    }
    default:
      return [];
  }
}

// --- Diff extraction (CDX-050) ---

/**
 * Build the diff payload from an Edit/Write/MultiEdit tool INPUT
 * (old_string/new_string/content — what the SDK message actually carries;
 * there are no line numbers, so this is a lines array, not unified hunks).
 * Returns null for non-edit tools or unusable input.
 */
export function extractDiff(toolName: string, input: Record<string, unknown>): DiffPayload | null {
  const path = typeof input.file_path === 'string' ? input.file_path : '';
  if (!path) return null;

  let lines: DiffLine[] = [];
  if (toolName === 'Edit') {
    const oldStr = typeof input.old_string === 'string' ? input.old_string : '';
    const newStr = typeof input.new_string === 'string' ? input.new_string : '';
    if (!oldStr && !newStr) return null;
    if (oldStr) lines.push(...toDiffLines(oldStr, 'del'));
    if (newStr) lines.push(...toDiffLines(newStr, 'add'));
  } else if (toolName === 'Write') {
    const content = typeof input.content === 'string' ? input.content : '';
    if (!content) return null;
    lines = toDiffLines(content, 'add');
  } else if (toolName === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    for (const edit of edits) {
      if (typeof edit !== 'object' || edit === null) continue;
      const e = edit as Record<string, unknown>;
      const oldStr = typeof e.old_string === 'string' ? e.old_string : '';
      const newStr = typeof e.new_string === 'string' ? e.new_string : '';
      if (!oldStr && !newStr) continue;
      // Context separator between hunks (edits have no line anchors).
      if (lines.length > 0) lines.push({ type: 'context', text: '⋯' });
      if (oldStr) lines.push(...toDiffLines(oldStr, 'del'));
      if (newStr) lines.push(...toDiffLines(newStr, 'add'));
    }
    if (lines.length === 0) return null;
  } else {
    return null;
  }

  const truncated = lines.length > MAX_DIFF_LINES;
  return {
    path,
    lines: truncated ? lines.slice(0, MAX_DIFF_LINES) : lines,
    ...(truncated ? { truncated: true } : {}),
  };
}
