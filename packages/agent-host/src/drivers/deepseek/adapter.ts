/**
 * Translates the DeepSeek Harness's ACP `session/update` notifications into
 * transcript entries — the counterpart of the Claude driver's
 * `sdkMessageToEntries` and the OpenCode driver's `opencodeEventToEntries`.
 *
 * Pure: one update in, zero or more entries out, with the only state being
 * the facts a tool call's own update carried (`ToolCallFacts`), which the
 * harness's result update does not repeat. Two updates are not entries and
 * are the session's own: context usage (`usage_update`) and the option list
 * (`config_option_update`).
 *
 * The harness sends the standard ACP updates for what it does — agent
 * messages and thoughts, generic tool call lifecycles, usage, config — and
 * nothing else: no plans, no slash commands, no modes, no terminal or
 * filesystem callbacks. Its tool calls arrive with `kind: "other"` and the
 * tool's own name as their title, so the agent-neutral kind and summary come
 * from the name (src/tools.ts) exactly as they do for the other agents.
 */
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { todosOf, toolInput, toolKindOf, toolLocations, toolTitle } from '../../tools';
import { MAX_DIFF_LINES, truncateToolResult, toDiffLines, type DiffPayload } from '../../transcript';
import type { OutputEntry } from '../../types';

/** What a tool call's own update carried: its result update repeats neither
 *  the tool's name nor its input. */
export interface ToolCallFacts {
  name: string;
  input: Record<string, unknown>;
}

/** Every tool call of one session, by id. */
export type ToolCallMemory = Map<string, ToolCallFacts>;

/** Convert one update into entries. */
export function deepseekUpdateToEntries(update: SessionUpdate, calls: ToolCallMemory): OutputEntry[] {
  const ts = new Date().toISOString();
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return textOf(update.content, 'agent', ts);
    case 'agent_thought_chunk':
      return textOf(update.content, 'thinking', ts);
    case 'tool_call':
      return toolCallEntries(update, calls, ts);
    case 'tool_call_update':
      return toolResultEntries(update, calls, ts);
    default:
      return [];
  }
}

function textOf(content: unknown, role: 'agent' | 'thinking', ts: string): OutputEntry[] {
  const block = content as { type?: unknown; text?: unknown } | null;
  if (block?.type !== 'text' || typeof block.text !== 'string' || block.text === '') return [];
  return [role === 'thinking' ? { entryType: 'thinking', text: block.text, timestamp: ts } : { entryType: 'text', role, text: block.text, timestamp: ts }];
}

/** One started tool call: its row, and the checklist when the call wrote one. */
function toolCallEntries(
  update: Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>,
  calls: ToolCallMemory,
  ts: string,
): OutputEntry[] {
  const name = toolNameOf(update);
  const input = record(update.rawInput);
  calls.set(update.toolCallId, { name, input });
  const locations = fileLocations(name, input);
  const full = toolInput(name, input);
  const todos = todosOf(input);
  return [
    {
      entryType: 'tool_call',
      callId: update.toolCallId,
      toolName: name,
      kind: toolKindOf(name),
      title: toolTitle(name, input) || name,
      ...(locations.length > 0 ? { locations } : {}),
      ...(full !== undefined ? { input: full } : {}),
      timestamp: ts,
    },
    ...(todos ? [{ entryType: 'todos' as const, items: todos, callId: update.toolCallId, timestamp: ts }] : []),
  ];
}

/** One finished tool call: its result text, and the file change it made when
 *  the harness's own input says what changed (its result update carries no
 *  diff block). A non-terminal update carries nothing new to show — the
 *  call's row is already there. */
function toolResultEntries(
  update: Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>,
  calls: ToolCallMemory,
  ts: string,
): OutputEntry[] {
  const status = update.status ?? undefined;
  if (status !== 'completed' && status !== 'failed') return [];
  const facts = calls.get(update.toolCallId);
  calls.delete(update.toolCallId);
  const text = contentText(update.content);
  const entries: OutputEntry[] = [
    {
      entryType: 'tool_result',
      callId: update.toolCallId,
      text: truncateToolResult(text),
      ...(status === 'failed' ? { isError: true } : {}),
      timestamp: ts,
    },
  ];
  if (status === 'completed' && facts) {
    for (const diff of toolCallDiffs(facts.name, facts.input)) {
      entries.push({ entryType: 'diff', ...diff, callId: update.toolCallId, timestamp: ts });
    }
  }
  return entries;
}

/** The tool's own name: ACP carries it as `name` when the agent has one, and
 *  the harness puts it in `title`. */
function toolNameOf(update: Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>): string {
  return update.name ?? update.title;
}

/** Everything a result's content blocks say, one line each. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    const block = record(item);
    if (block?.type !== 'content') continue;
    const inner = record(block.content);
    if (inner?.type === 'text' && typeof inner.text === 'string') parts.push(inner.text);
    else if (inner?.type === 'image') parts.push('[image]');
  }
  return parts.join('\n');
}

// --- file changes ---

/**
 * The files a completed call changed, from its own input. The harness's
 * result update carries text only — no ACP diff block — so a file change is
 * reconstructed the way the agent described it: the replaced text for `edit`
 * and `str_replace_editor`, the whole file for `write` and a create.
 *
 * `str_replace_editor` is the Claude-Code-shaped editor the harness also
 * mounts: its `command` decides which of its arguments are the change.
 */
export function toolCallDiffs(name: string, input: Record<string, unknown>): DiffPayload[] {
  switch (name) {
    case 'edit': {
      const path = str(input.file_path) ?? str(input.path);
      if (!path) return [];
      return bounded(path, [
        ...toDiffLines(str(input.old_string) ?? '', 'del'),
        ...toDiffLines(str(input.new_string) ?? '', 'add'),
      ]);
    }
    case 'write': {
      const path = str(input.file_path) ?? str(input.path);
      const content = str(input.content) ?? str(input.file_text);
      if (!path || content === undefined) return [];
      return bounded(path, toDiffLines(content, 'add'));
    }
    case 'str_replace_editor': {
      const path = str(input.path);
      if (!path) return [];
      const command = str(input.command) ?? '';
      if (command === 'create') {
        const content = str(input.file_text);
        return content === undefined ? [] : bounded(path, toDiffLines(content, 'add'));
      }
      if (command === 'str_replace') {
        return bounded(path, [
          ...toDiffLines(str(input.old_str) ?? '', 'del'),
          ...toDiffLines(str(input.new_str) ?? '', 'add'),
        ]);
      }
      if (command === 'insert') {
        return bounded(path, toDiffLines(str(input.new_str) ?? '', 'add'));
      }
      return [];
    }
    default:
      return [];
  }
}

/** A diff payload inside the shared wire cap; nothing for an empty change. */
function bounded(path: string, lines: DiffPayload['lines']): DiffPayload[] {
  if (lines.length === 0) return [];
  const truncated = lines.length > MAX_DIFF_LINES;
  return [{
    path,
    lines: truncated ? lines.slice(0, MAX_DIFF_LINES) : lines,
    ...(truncated ? { truncated: true } : {}),
  }];
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The file a call names. The harness's own file tools agree on `file_path`;
 * `str_replace_editor` is the odd one out with `path` — a key `glob` and
 * `grep` use for a directory, so only that editor is read that way.
 */
function fileLocations(name: string, input: Record<string, unknown>): string[] {
  const direct = toolLocations(input);
  if (direct.length > 0) return direct;
  const path = name === 'str_replace_editor' ? str(input.path) : undefined;
  return path ? [path] : [];
}
