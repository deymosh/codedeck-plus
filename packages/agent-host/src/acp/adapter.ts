/**
 * Translates an ACP agent's `session/update` notifications into transcript
 * entries — the counterpart of the Claude driver's `sdkMessageToEntries` and
 * the OpenCode driver's `opencodeEventToEntries`.
 *
 * Pure: one update in, zero or more entries out, with the only state being
 * the facts a tool call's own update carried (`ToolCallFacts`), which the
 * result update does not repeat. Two updates are not entries and are the
 * session's own: context usage (`usage_update`) and the option list
 * (`config_option_update`).
 *
 * What the standard updates mean is the same for every ACP agent: agent
 * messages and thoughts, generic tool call lifecycles, usage, config. What
 * they do not carry is the agent's own read of a call — the kind and title a
 * tool's name gives it — nor anything the agent says beyond them, so both
 * enter through `AcpUpdateTranslation`, the one part a driver supplies.
 */
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { todosOf, toolLocations, type ToolCallRead } from '../sdk/tools';
import { truncateToolResult, type DiffPayload } from '../sdk/transcript';
import type { OutputEntry } from '../sdk/types';

/** What a tool call's own update carried: its result update repeats neither
 *  the tool's name nor its input. */
export interface ToolCallFacts {
  name: string;
  input: Record<string, unknown>;
}

/** Every tool call of one session, by id. */
export type ToolCallMemory = Map<string, ToolCallFacts>;

/** How one agent's updates read beyond the standard ACP shape. */
export interface AcpUpdateTranslation {
  /** The name of one tool call. ACP carries it as the call's `name` when the
   *  agent has one, and the agent puts it in `title` otherwise; an agent that
   *  keeps its real tool name in `_meta` (Qwen Code) supplies it here, so its
   *  table is keyed by the name the tool actually has. */
  toolName?(update: Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>): string;
  /** The agent-neutral read of one tool call: its kind, the title the phone
   *  shows, and the call's input when it says more than the title. */
  readToolCall(name: string, input: Record<string, unknown>): ToolCallRead;
  /** Whether this call's own row is hidden, because its card *is* the
   *  exchange (a question tool, a plan review) and a row would be a second,
   *  emptier copy of it. */
  hidden?(name: string): boolean;
  /** The file changes a completed call made, from its own input — for an
   *  agent whose result update carries no ACP diff block. */
  diffs?(name: string, input: Record<string, unknown>): DiffPayload[];
}

/** Convert one update into entries. */
export function acpUpdateToEntries(
  update: SessionUpdate,
  calls: ToolCallMemory,
  translation: AcpUpdateTranslation,
): OutputEntry[] {
  const ts = new Date().toISOString();
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return textOf(update.content, 'agent', ts);
    case 'agent_thought_chunk':
      return textOf(update.content, 'thinking', ts);
    case 'tool_call':
      return toolCallEntries(update, calls, translation, ts);
    case 'tool_call_update':
      return toolResultEntries(update, calls, translation, ts);
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
  translation: AcpUpdateTranslation,
  ts: string,
): OutputEntry[] {
  const name = toolNameOf(update, translation);
  const input = record(update.rawInput);
  calls.set(update.toolCallId, { name, input });
  if (translation.hidden?.(name)) return [];
  const locations = toolLocations(input);
  const call = translation.readToolCall(name, input);
  const todos = todosOf(input);
  return [
    {
      entryType: 'tool_call',
      callId: update.toolCallId,
      toolName: name,
      kind: call.kind,
      title: titleOf(call, name, update),
      ...(locations.length > 0 ? { locations } : {}),
      ...(call.input !== undefined ? { input: call.input } : {}),
      timestamp: ts,
    },
    ...(todos ? [{ entryType: 'todos' as const, items: todos, callId: update.toolCallId, timestamp: ts }] : []),
  ];
}

/** One finished tool call: its result text, and whatever the driver adds for
 *  a completed one. A non-terminal update carries nothing new to show — the
 *  call's row is already there — but it may refine what the call's own start
 *  update said (an agent that opens a call with no arguments and fills them
 *  in as it starts running, as Qwen Code does), so its arguments are kept for
 *  the result's diff. */
function toolResultEntries(
  update: Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>,
  calls: ToolCallMemory,
  translation: AcpUpdateTranslation,
  ts: string,
): OutputEntry[] {
  const status = update.status ?? undefined;
  if (status !== 'completed' && status !== 'failed') {
    const facts = calls.get(update.toolCallId);
    const input = record(update.rawInput);
    if (facts !== undefined && Object.keys(input).length > 0) facts.input = input;
    return [];
  }
  const facts = calls.get(update.toolCallId);
  calls.delete(update.toolCallId);
  if (facts !== undefined && translation.hidden?.(facts.name)) return [];
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
    for (const diff of translation.diffs?.(facts.name, facts.input) ?? []) {
      entries.push({ entryType: 'diff', ...diff, callId: update.toolCallId, timestamp: ts });
    }
  }
  return entries;
}

/** The tool's own name: ACP carries it as `name` when the agent has one, and
 *  the agent puts it in `title` otherwise. A driver that keeps the real name
 *  elsewhere (Qwen Code's `_meta.toolName`) answers with it. */
function toolNameOf(
  update: Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>,
  translation: AcpUpdateTranslation,
): string {
  return translation.toolName?.(update) ?? update.name ?? update.title;
}

/** The row's title. The agent's own title is used when the call's arguments
 *  gave none of their own — it is what the agent chose to show, and reads
 *  better than the bare tool name the read falls back to (Qwen Code's first
 *  `tool_call` carries no arguments and the title `Shell`). */
function titleOf(
  call: ToolCallRead,
  name: string,
  update: Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>,
): string {
  return call.title === name && update.title !== name && update.title !== '' ? update.title : call.title;
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

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
