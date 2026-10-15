/**
 * Translates Qwen Code's ACP `session/update` notifications into transcript
 * entries — the counterpart of the Claude driver's `sdkMessageToEntries` and
 * the OpenCode driver's `opencodeEventToEntries`.
 *
 * The ACP part is the shared translation (acp/adapter); what Qwen Code adds to
 * it is its own: the tool name it keeps in `_meta.toolName` (its `title` is a
 * display string, `Shell`, and its first `tool_call` update carries no
 * arguments), the tool table (tools.ts), and the two calls whose card *is* the
 * exchange.
 *
 * Qwen Code sends the standard ACP updates for what it does — agent messages
 * and thoughts, generic tool call lifecycles, usage, config, the current mode
 * and the available commands — and nothing else. Its text arrives in many
 * empty `agent_message_chunk`s, which the shared reader drops.
 */
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { acpUpdateToEntries, type ToolCallMemory } from '../../acp/adapter';
import type { OutputEntry } from '../../sdk/types';
import { qwenTool } from './tools';

export type { ToolCallFacts, ToolCallMemory } from '../../acp/adapter';

/**
 * The tools whose card *is* the exchange. `ask_user_question` and
 * `exit_plan_mode` both arrive as permission asks — the first a question form,
 * the second a plan review — so their own tool rows would be a second,
 * emptier copy of the same exchange.
 */
const EXCHANGE_TOOLS = new Set(['ask_user_question', 'exit_plan_mode']);

/** The agent's real tool name, which it keeps in the call's `_meta`. */
export function qwenToolName(update: Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>): string {
  const meta = (update as { _meta?: { toolName?: unknown } | null })._meta;
  return typeof meta?.toolName === 'string' && meta.toolName !== '' ? meta.toolName : (update.name ?? update.title);
}

/** Convert one update into entries. `reportUnknownTool` is told every tool
 *  name no agent's table lists (`unknownToolReporter`). */
export function qwenUpdateToEntries(
  update: SessionUpdate,
  calls: ToolCallMemory,
  reportUnknownTool?: (toolName: string) => void,
): OutputEntry[] {
  return acpUpdateToEntries(update, calls, {
    toolName: (call) => qwenToolName(call),
    readToolCall: (name, input) => qwenTool(name, input, reportUnknownTool),
    hidden: (name) => EXCHANGE_TOOLS.has(name),
  });
}
