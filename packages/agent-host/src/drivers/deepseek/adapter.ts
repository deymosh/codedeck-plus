/**
 * Translates the DeepSeek Harness's ACP `session/update` notifications into
 * transcript entries — the counterpart of the Claude driver's
 * `sdkMessageToEntries` and the OpenCode driver's `opencodeEventToEntries`.
 *
 * The ACP part is the shared translation (acp/adapter); what the harness adds
 * to it is its own: the tool names this profile mounts (tools.ts), the two
 * calls whose card *is* the exchange, and the file changes it does not report
 * as an ACP diff block.
 *
 * The harness sends the standard ACP updates for what it does — agent
 * messages and thoughts, generic tool call lifecycles, usage, config — and
 * nothing else: no plans, no slash commands, no modes, no terminal or
 * filesystem callbacks. Its tool calls arrive with `kind: "other"` and the
 * tool's own name as their title, so the agent-neutral kind and title are
 * read from the call's arguments, and from this driver's own table of names
 * (tools.ts), exactly as they are for the other agents.
 */
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { acpUpdateToEntries, type ToolCallMemory } from '../../acp/adapter';
import { MAX_DIFF_LINES, toDiffLines, type DiffPayload } from '../../sdk/transcript';
import type { OutputEntry } from '../../sdk/types';
import { deepseekTool } from './tools';

export type { ToolCallFacts, ToolCallMemory } from '../../acp/adapter';

/**
 * The tools whose card *is* the exchange. The question tool asks through the
 * harness's `user-questions` service and so does the plan review
 * (`exit_plan_mode`); the bridge shows each as a question card and sends the
 * answer back, so their own tool rows would be a second, emptier copy — and
 * for a plan review the copy is its raw arguments, the whole plan as JSON.
 */
const QUESTION_TOOLS = new Set(['ask_user_question', 'exit_plan_mode']);

/** Convert one update into entries. `reportUnknownTool` is told every tool
 *  name no agent's table lists (`unknownToolReporter`). */
export function deepseekUpdateToEntries(
  update: SessionUpdate,
  calls: ToolCallMemory,
  reportUnknownTool?: (toolName: string) => void,
): OutputEntry[] {
  return acpUpdateToEntries(update, calls, {
    readToolCall: (name, input) => deepseekTool(name, input, reportUnknownTool),
    hidden: (name) => QUESTION_TOOLS.has(name),
    diffs: (name, input) => toolCallDiffs(name, input),
  });
}

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
