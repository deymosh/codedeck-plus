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
import { toolKindOf, toolLocations, toolTitle } from '../../tools';
import { MAX_DIFF_LINES, toDiffLines, truncateToolResult, type DiffPayload, type TranslateContext } from '../../transcript';
import type { DiffLine, OutputEntry, Subagent } from '../../types';
import type {
  SdkMessage,
  SdkAssistantMessage,
  SdkUserMessage,
  SdkResultMessage,
  SdkResultError,
  SdkSystemMessage,
  SdkSessionStateChangedMessage,
} from './facade';

/** Tools whose call renders as a dedicated card instead of a tool action. */
const CARD_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

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
    case 'system':
      return parseSystem(msg as SdkSystemMessage | SdkSessionStateChangedMessage);
    default:
      // stream_event, auth_status, task_notification, etc. — skip
      return [];
  }
}

function subagentField(isSubAgent: boolean): { subagent?: Subagent } {
  return isSubAgent ? { subagent: {} } : {};
}

function parseAssistant(msg: SdkAssistantMessage, ctx: TranslateContext): OutputEntry[] {
  const entries: OutputEntry[] = [];
  const ts = new Date().toISOString();

  // Text written alongside tool calls (or by a sub-agent) folds into the tool
  // group; a message that is only text is the agent's answer and stands alone.
  const hasToolUse = msg.message.content.some(
    (b: { type: string; name?: string }) => b.type === 'tool_use' && !CARD_TOOLS.has(b.name ?? ''),
  );
  // Sub-agent messages have a non-null parent_tool_use_id.
  const isSubAgent = !!msg.parent_tool_use_id;
  const collapsible = hasToolUse || isSubAgent;

  for (const block of msg.message.content) {
    if (block.type === 'text') {
      entries.push({
        entryType: 'text',
        role: 'agent',
        text: block.text,
        timestamp: ts,
        ...(collapsible ? { collapsible: true } : {}),
        ...subagentField(isSubAgent),
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
        ...subagentField(isSubAgent),
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
        entries.push({
          entryType: 'tool_call',
          callId: block.id,
          toolName: block.name,
          kind: toolKindOf(block.name),
          title: toolTitle(block.name, input),
          ...withLocations(toolLocations(input)),
          rawInput: block.input,
          timestamp: ts,
          ...subagentField(isSubAgent),
        });
        // A colored diff card for file edits, alongside the tool call (the
        // tool group keeps its action; the diff renders as its own card).
        const diff = extractDiff(block.name, input);
        if (diff) {
          entries.push({
            entryType: 'diff',
            ...diff,
            callId: block.id,
            timestamp: ts,
            ...subagentField(isSubAgent),
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
  // A sub-agent's prompt comes from the main agent, not the user: it folds
  // into the tool group as agent text.
  const isSubAgent = !!msg.parent_tool_use_id;
  const text = (t: string): OutputEntry =>
    isSubAgent
      ? { entryType: 'text', role: 'agent', text: t, collapsible: true, subagent: {}, timestamp: ts }
      : { entryType: 'text', role: 'user', text: t, timestamp: ts };

  if (typeof content === 'string') {
    entries.push(text(content));
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text') {
        entries.push(text(block.text));
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
