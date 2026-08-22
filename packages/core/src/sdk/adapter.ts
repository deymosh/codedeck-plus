/**
 * Translates Claude Agent SDK messages into Codedeck OutputEntry objects.
 *
 * The SDK emits typed SDKMessage objects (assistant, user, result, system,
 * etc.) on its async generator. This module maps them into the OutputEntry
 * format that the Nostr layer publishes to the phone app.
 *
 * Ported faithfully from the old bridge's sdkAdapter.ts (battle-tested);
 * only the imports changed: OutputEntry now comes from @codedeck/protocol and
 * SDK types come through the sdk/facade seam.
 */
import type { DiffData, DiffLine, OutputEntry } from '@codedeck/protocol';
import type {
  SdkMessage,
  SdkAssistantMessage,
  SdkUserMessage,
  SdkResultMessage,
  SdkResultError,
  SdkSystemMessage,
  SdkSessionStateChangedMessage,
} from './facade';

export interface AdapterOptions {
  /**
   * CDX-050: also emit an `entryType: 'diff'` entry (colored diff card) after
   * each Edit/Write/MultiEdit tool_use. Default false — a pre-CDX-050 phone
   * hard-fails zod on the unknown entryType, so the caller must only enable
   * this once every known phone advertised the 'diff' capability. The tool_use
   * entry is ALWAYS kept alongside (the tool group never loses its action).
   */
  emitDiffEntries?: boolean;
}

/**
 * Convert a single SDKMessage into zero or more OutputEntry objects.
 * Returns empty array for message types we don't relay (stream_event, etc.).
 */
export function sdkMessageToEntries(msg: SdkMessage, opts?: AdapterOptions): OutputEntry[] {
  switch (msg.type) {
    case 'assistant':
      return parseAssistant(msg as SdkAssistantMessage, opts);
    case 'user':
      return parseUser(msg as SdkUserMessage);
    case 'result':
      return parseResult(msg as SdkResultMessage);
    case 'system':
      return parseSystem(msg as SdkSystemMessage | SdkSessionStateChangedMessage);
    default:
      // stream_event, auth_status, task_notification, etc. — skip
      return [];
  }
}

function parseAssistant(msg: SdkAssistantMessage, opts?: AdapterOptions): OutputEntry[] {
  const entries: OutputEntry[] = [];
  const ts = new Date().toISOString();
  const model = msg.message.model;

  // Check if this message contains tool_use blocks (excluding ExitPlanMode/AskUserQuestion
  // which are handled as special cards, not collapsible tool actions)
  const hasToolUse = msg.message.content.some(
    (b: { type: string; name?: string }) =>
      b.type === 'tool_use' && b.name !== 'ExitPlanMode' && b.name !== 'AskUserQuestion',
  );
  // Sub-agent messages have a non-null parent_tool_use_id
  const isSubAgent = !!msg.parent_tool_use_id;

  // display_hint tells the phone whether to collapse text into tool groups or show it
  // - 'collapse': text accompanies tool calls → hide under "X actions"
  // - 'show': text is Claude's standalone response → show as full message
  const displayHint = (hasToolUse || isSubAgent) ? 'collapse' : 'show';

  for (const block of msg.message.content) {
    if (block.type === 'text') {
      entries.push({
        entryType: 'text',
        content: block.text,
        timestamp: ts,
        metadata: {
          role: 'assistant',
          model,
          display_hint: displayHint,
          ...(isSubAgent ? { subagent: true } : {}),
        },
      });
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      // Extended-thinking blocks get their own entry kind (previously dropped —
      // the 3c phone UI noted the gap). Redacted thinking has no readable text;
      // it is marked so the phone can render a placeholder instead of nothing.
      const redacted = block.type === 'redacted_thinking';
      entries.push({
        entryType: 'thinking',
        content: redacted ? '' : (block as { thinking?: string }).thinking ?? '',
        timestamp: ts,
        metadata: {
          role: 'assistant',
          model,
          ...(redacted ? { redacted: true } : {}),
          ...(isSubAgent ? { subagent: true } : {}),
        },
      });
    } else if (block.type === 'tool_use') {
      // Special handling for ExitPlanMode and AskUserQuestion
      if (block.name === 'ExitPlanMode') {
        const input = block.input as Record<string, unknown>;
        const plan = (input.plan as string) || '';
        if (plan) {
          entries.push({
            entryType: 'text',
            content: plan,
            timestamp: ts,
            metadata: { role: 'assistant', model, special: 'plan', tool_use_id: block.id },
          });
        }
        entries.push({
          entryType: 'system',
          content: 'Plan approval needed',
          timestamp: ts,
          metadata: { special: 'plan_approval', tool_use_id: block.id, has_plan: !!plan },
        });
      } else if (block.name === 'AskUserQuestion') {
        const input = block.input as Record<string, unknown>;
        const questions = (input.questions as Array<{
          question: string;
          header?: string;
          options?: Array<{ label: string; description?: string }>;
          multiSelect?: boolean;
        }>) || [];
        for (let qi = 0; qi < questions.length; qi++) {
          const q = questions[qi]!;
          entries.push({
            entryType: 'system',
            content: q.question,
            timestamp: ts,
            metadata: {
              special: 'ask_question',
              tool_use_id: block.id,
              header: q.header,
              options: q.options,
              multiSelect: q.multiSelect,
              question_index: qi,
              question_count: questions.length,
            },
          });
        }
      } else {
        entries.push({
          entryType: 'tool_use',
          content: formatToolInput(block.name, block.input as Record<string, unknown>),
          timestamp: ts,
          metadata: {
            role: 'assistant',
            tool_name: block.name,
            tool_use_id: block.id,
            tool_input: block.input,
            ...(isSubAgent ? { subagent: true } : {}),
          },
        });
        // CDX-050: colored diff card for file edits — emitted IN ADDITION to
        // the tool_use above (the legacy bridge did the same: the tool group
        // keeps its action, the diff renders as its own card). Gated on the
        // phone-side 'diff' capability by the caller.
        if (opts?.emitDiffEntries) {
          const diff = extractDiff(block.name, block.input as Record<string, unknown>);
          if (diff) {
            entries.push({
              entryType: 'diff',
              content: renderDiffFallback(diff),
              timestamp: ts,
              metadata: {
                role: 'assistant',
                tool_name: block.name,
                tool_use_id: block.id,
                ...(isSubAgent ? { subagent: true } : {}),
              },
              diff,
            });
          }
        }
      }
    }
  }

  // Token usage
  if (msg.message.usage) {
    entries.push({
      entryType: 'system',
      content: `Tokens: ${msg.message.usage.input_tokens} in / ${msg.message.usage.output_tokens} out`,
      timestamp: ts,
      metadata: { usage: msg.message.usage },
    });
  }

  return entries;
}

function parseUser(msg: SdkUserMessage): OutputEntry[] {
  const entries: OutputEntry[] = [];
  const ts = new Date().toISOString();
  const content = msg.message.content;
  // Sub-agent prompts have a non-null parent_tool_use_id — collapse them into tool groups
  const isSubAgent = !!msg.parent_tool_use_id;
  const textMeta = isSubAgent
    ? { role: 'assistant' as const, subagent: true, display_hint: 'collapse' as const }
    : { role: 'user' as const };

  // content can be string or array of content blocks
  if (typeof content === 'string') {
    entries.push({
      entryType: 'text',
      content,
      timestamp: ts,
      metadata: textMeta,
    });
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text') {
        entries.push({
          entryType: 'text',
          content: block.text,
          timestamp: ts,
          metadata: textMeta,
        });
      } else if (block.type === 'tool_result') {
        // tool_result content can be string or array
        const text = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content
                .filter((c: { type: string }): c is { type: 'text'; text: string } => c.type === 'text')
                .map((c: { text: string }) => c.text)
                .join('\n')
            : '';
        if (text) {
          entries.push({
            entryType: 'tool_result',
            content: text.length > 2000 ? text.slice(0, 2000) + '...[truncated]' : text,
            timestamp: ts,
            metadata: { tool_use_id: block.tool_use_id },
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
      content: errorMsg.errors?.join('\n') || msg.subtype,
      timestamp: ts,
      metadata: { error_type: msg.subtype },
    }];
  }
  // Success result — emit cost summary
  return [{
    entryType: 'system',
    content: `Session complete — ${msg.num_turns} turns, $${msg.total_cost_usd.toFixed(4)}`,
    timestamp: ts,
    metadata: {
      subtype: 'result',
      duration_ms: msg.duration_ms,
      num_turns: msg.num_turns,
      total_cost_usd: msg.total_cost_usd,
      usage: msg.usage,
    },
  }];
}

function parseSystem(msg: SdkSystemMessage | SdkSessionStateChangedMessage): OutputEntry[] {
  if (msg.subtype === 'init') {
    return [{
      entryType: 'system',
      content: `Claude Code ${msg.claude_code_version} (${msg.model})`,
      timestamp: new Date().toISOString(),
      metadata: {
        subtype: 'init',
        model: msg.model,
        version: msg.claude_code_version,
        tools: msg.tools,
        permissionMode: msg.permissionMode,
      },
    }];
  }

  // Emit stream_end when SDK reports session is idle (turn complete).
  // This is the authoritative signal that Claude finished responding and is
  // waiting for user input. The phone uses stream_end to show the unread dot.
  if (msg.subtype === 'session_state_changed') {
    const stateMsg = msg as unknown as { state: string };
    if (stateMsg.state === 'idle') {
      return [{
        entryType: 'system',
        content: '',
        timestamp: new Date().toISOString(),
        metadata: { stream_end: true },
      }];
    }
    return [];
  }

  return [];
}

// --- Diff extraction (CDX-050) ---

/** Wire caps: keep a diff entry comfortably inside one relay event. */
const MAX_DIFF_LINES = 200;
const MAX_DIFF_LINE_CHARS = 500;

function toDiffLines(text: string, type: DiffLine['type']): DiffLine[] {
  return text.split('\n').map((line) => ({
    type,
    text: line.length > MAX_DIFF_LINE_CHARS ? line.slice(0, MAX_DIFF_LINE_CHARS) + '…' : line,
  }));
}

/**
 * Build the structured diff payload from an Edit/Write/MultiEdit tool INPUT
 * (old_string/new_string/content — what the SDK message actually carries;
 * there are no line numbers, so this is a lines array, not unified hunks).
 * Returns null for non-edit tools or unusable input.
 */
export function extractDiff(
  toolName: string,
  input: Record<string, unknown>,
): DiffData | null {
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

/** Plain-text +/− rendering of the diff — the entry's `content` fallback. */
function renderDiffFallback(diff: DiffData): string {
  const prefix = { add: '+', del: '-', context: ' ' } as const;
  return diff.lines.map((l) => prefix[l.type] + l.text).join('\n');
}

function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return `Bash: ${input.command || ''}`;
    case 'Read':
      return `Read: ${input.file_path || ''}`;
    case 'Write':
      return `Write: ${input.file_path || ''}`;
    case 'Edit':
      return `Edit: ${input.file_path || ''}`;
    case 'Glob':
      return `Glob: ${input.pattern || ''}`;
    case 'Grep':
      return `Grep: ${input.pattern || ''}`;
    case 'Task':
    case 'Agent':
      return `${toolName}: ${input.description || ''} (${input.subagent_type || ''})`;
    case 'WebSearch':
      return `WebSearch: ${input.query || ''}`;
    case 'WebFetch':
      return `WebFetch: ${input.url || ''}`;
    default:
      return `${toolName}: ${JSON.stringify(input).slice(0, 200)}`;
  }
}
