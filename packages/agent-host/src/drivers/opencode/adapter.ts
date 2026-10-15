/**
 * Translates OpenCode session events into transcript entries — the OpenCode
 * counterpart of the Claude driver's `sdkMessageToEntries`.
 *
 * The session (driver.ts) normalizes OpenCode's raw event stream into the
 * `OpenCodeEvent`s below — whole text and tool results only, deduplicated —
 * so this module is pure: one event in, zero or more entries out.
 *
 * OpenCode v2 replaced v1's part-shaped stream (`message.part.updated`
 * carrying a whole `Part`) with one event per thing that happens: text and
 * reasoning arrive as started/delta/ended triples, a tool call as
 * input/called and then success or failed. Only the *ended* halves are
 * translated — a delta is mid-stream, and the ended event carries the whole
 * text — which is where v1's "stable parts only" rule now lives.
 */
import type { FileDiffInfo } from '@opencode/client';
import { todosOf, toolLocations } from '../../sdk/tools';
import { opencodeTool } from './tools';
import {
  MAX_DIFF_LINE_CHARS,
  MAX_DIFF_LINES,
  toDiffLines,
  truncateToolResult,
  type DiffPayload,
  type TranslateContext,
} from '../../sdk/transcript';
import type { DiffLine, OutputEntry, Subagent, TaskKind, TaskStatus } from '../../sdk/types';

/** A new OpenCode session exists server-side and accepts prompts; `version`
 *  is the server's, when it said. */
export interface OpenCodeStarted {
  type: 'started';
  version?: string;
}

/** OpenCode's `session.idle`: the turn is over. */
export interface OpenCodeIdle {
  type: 'idle';
}

/** A message that reached its final state: what a user said, or what the
 *  agent answered. */
export interface OpenCodeText {
  type: 'text';
  role: 'user' | 'assistant';
  text: string;
  /** Set when a sub-agent's child session produced it. */
  subagent?: Subagent;
  /** The streamed part this entry completes, when the agent streamed it: the
   *  `key` its `partial` messages carried. */
  part?: string;
}

/** The model's reasoning for a step, once it stopped streaming. */
export interface OpenCodeReasoning {
  type: 'reasoning';
  text: string;
  subagent?: Subagent;
}

/** A tool call starting, with the input it will run with. */
export interface OpenCodeToolStart {
  type: 'tool-start';
  callId: string;
  toolName: string;
  input: Record<string, unknown>;
  subagent?: Subagent;
}

/** A tool call finishing, however it ended. File changes the call made ride
 *  along as diff payloads. */
export interface OpenCodeToolResult {
  type: 'tool-result';
  callId: string;
  text: string;
  isError?: boolean;
  diffs: DiffPayload[];
  subagent?: Subagent;
}

/** Work the agent left running in the background changed state — a
 *  sub-agent (its task id is its child session's id) or a shell command
 *  (its task id is the server's shell id). */
export interface OpenCodeTask {
  type: 'task';
  taskId: string;
  kind: TaskKind;
  title: string;
  status: TaskStatus;
  callId: string;
}

/** A session-level failure reported outside any message. */
export interface OpenCodeError {
  type: 'error';
  content: string;
}

/** A line about the session, not from the model (a command's outcome). */
export interface OpenCodeStatus {
  type: 'status';
  text: string;
}

/** The session to resume no longer exists server-side and a fresh one was
 *  created instead — the model does not remember earlier turns, which the
 *  user must not learn only through a silent id change. */
export interface OpenCodeResumeLost {
  type: 'resume-lost';
}

/** The persona the session ran as is gone (its agent file was removed), or
 *  the one it was asked for never existed here: it runs as Build now, which
 *  the user must not learn only through the session quietly changing. */
export interface OpenCodePersonaNotice {
  type: 'persona-notice';
  text: string;
}

/** Files the session changed, as OpenCode reports them (`session.diff`, or
 *  the file list of a finished step). */
export interface OpenCodeDiff {
  type: 'diff';
  files: FileDiffInfo[];
}

/** OpenCode asked the user a question (its `question` tool, answered through
 *  a form). The card comes from the bridge; this only marks the question
 *  tool's call as a card rather than a tool action. */
export interface OpenCodeQuestion {
  type: 'question';
  toolUseId: string;
}

export type OpenCodeEvent =
  | OpenCodeStarted
  | OpenCodeIdle
  | OpenCodeText
  | OpenCodeReasoning
  | OpenCodeToolStart
  | OpenCodeToolResult
  | OpenCodeError
  | OpenCodeStatus
  | OpenCodeResumeLost
  | OpenCodePersonaNotice
  | OpenCodeDiff
  | OpenCodeQuestion
  | OpenCodeTask;

/** OpenCode's own question tool, and its shell tool — the latter renders its
 *  command as the tool row's title, like Claude Code's Bash. */
export const QUESTION_TOOL = 'question';
export const SHELL_TOOL = 'shell';

/** Convert one OpenCode event into zero or more transcript entries. */
export function opencodeEventToEntries(event: OpenCodeEvent, ctx: TranslateContext): OutputEntry[] {
  const ts = new Date().toISOString();
  switch (event.type) {
    case 'started':
      return [{ entryType: 'status', text: event.version ? `OpenCode ${event.version}` : 'OpenCode session started', timestamp: ts }];
    case 'idle':
      return [{ entryType: 'turn_complete', timestamp: ts }];
    case 'text':
      // A sub-agent's prompt comes from the main agent, and its `subagent`
      // call already carries it as input: it is not shown again.
      if (event.subagent && event.role === 'user') return [];
      return tag(
        [{
          entryType: 'text',
          role: event.role === 'user' ? 'user' : 'agent',
          text: event.text,
          ...(event.part ? { part: event.part } : {}),
          timestamp: ts,
        }],
        event.subagent,
      );
    case 'reasoning':
      if (!event.text) return [];
      return tag([{ entryType: 'thinking', text: event.text, timestamp: ts }], event.subagent);
    case 'tool-start': {
      const entries = toolStartEntries(event, ctx, ts);
      return tag(entries, event.subagent);
    }
    case 'tool-result': {
      const entries = toolResultEntries(event, ts);
      return tag(entries, event.subagent);
    }
    case 'error':
      return [{ entryType: 'error', text: event.content, timestamp: ts }];
    case 'status':
      return [{ entryType: 'status', text: event.text, timestamp: ts }];
    case 'resume-lost':
      return [{
        entryType: 'notice',
        kind: 'session_restart',
        text:
          "OpenCode's session was missing — starting a fresh conversation in the same workspace. The transcript is preserved, but the model does not remember earlier turns.",
        timestamp: ts,
      }];
    case 'persona-notice':
      return [{ entryType: 'notice', kind: 'other', text: event.text, timestamp: ts }];
    case 'diff':
      return event.files.flatMap((file) => {
        const diff = toDiffPayload(file);
        return diff ? [{ entryType: 'diff', ...diff, timestamp: ts } satisfies OutputEntry] : [];
      });
    case 'question':
      ctx.hiddenCallIds.add(event.toolUseId);
      return [];
    case 'task':
      return [{
        entryType: 'background_task',
        taskId: event.taskId,
        kind: event.kind,
        title: event.title,
        status: event.status,
        callId: event.callId,
        timestamp: ts,
      }];
    default:
      return [];
  }
}

/** Every entry of one sub-agent's event carries that sub-agent. */
function tag(entries: OutputEntry[], subagent: Subagent | undefined): OutputEntry[] {
  return subagent ? entries.map((e) => ({ ...e, subagent })) : entries;
}

function toolStartEntries(
  event: Extract<OpenCodeEvent, { type: 'tool-start' }>,
  ctx: TranslateContext,
  ts: string,
): OutputEntry[] {
  // The question tool's own call is not a row: `form.created` renders it as
  // a question card instead (see the driver's handleForm).
  if (event.toolName === QUESTION_TOOL) {
    ctx.hiddenCallIds.add(event.callId);
    return [];
  }
  if (ctx.hiddenCallIds.has(event.callId)) return [];
  const locations = toolLocations(event.input);
  const call = opencodeTool(event.toolName, event.input, ctx.onUnknownTool);
  const todos = todosOf(event.input);
  return [
    {
      entryType: 'tool_call',
      callId: event.callId,
      toolName: event.toolName,
      kind: call.kind,
      title: call.title,
      ...(locations.length > 0 ? { locations } : {}),
      ...(call.input !== undefined ? { input: call.input } : {}),
      timestamp: ts,
    },
    ...(todos ? [{ entryType: 'todos' as const, items: todos, callId: event.callId, timestamp: ts }] : []),
  ];
}

function toolResultEntries(event: Extract<OpenCodeEvent, { type: 'tool-result' }>, ts: string): OutputEntry[] {
  const entries: OutputEntry[] = [{
    entryType: 'tool_result',
    callId: event.callId,
    text: truncateToolResult(event.text),
    ...(event.isError ? { isError: true } : {}),
    timestamp: ts,
  }];
  // A file-changing call gets the same diff cards Claude Code's Edit/Write
  // calls do. Taken from the FINISHED call — the change has actually been
  // applied by then, and OpenCode's own metadata carries the real patch.
  for (const diff of event.diffs) {
    entries.push({ entryType: 'diff', ...diff, callId: event.callId, timestamp: ts });
  }
  return entries;
}

// --- diffs ---

/** Lines of a unified diff. File headers (`diff`, `index`, `---`, `+++`) are
 *  only skipped before the first hunk: inside a hunk, `---x` is the deletion
 *  of the line `--x`, not a header. Hunk headers and "\ No newline" markers
 *  carry no line content. */
function patchLines(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith('\\')) continue;
    if (line.startsWith('+')) out.push({ type: 'add', text: truncateDiffLine(line.slice(1)) });
    else if (line.startsWith('-')) out.push({ type: 'del', text: truncateDiffLine(line.slice(1)) });
    else if (line.startsWith(' ')) out.push({ type: 'context', text: truncateDiffLine(line.slice(1)) });
  }
  return out;
}

function truncateDiffLine(line: string): string {
  return line.length > MAX_DIFF_LINE_CHARS ? line.slice(0, MAX_DIFF_LINE_CHARS) + '…' : line;
}

/** A diff payload inside the shared wire caps; `null` when there are no
 *  lines to show. */
function boundedDiff(path: string, lines: DiffLine[]): DiffPayload | null {
  if (lines.length === 0) return null;
  const truncated = lines.length > MAX_DIFF_LINES;
  return {
    path,
    lines: truncated ? lines.slice(0, MAX_DIFF_LINES) : lines,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** One file OpenCode reports as changed, as a card: its unified patch turned
 *  into lines. `null` when the patch carries no line content at all (only
 *  counts) — there is nothing to render then. */
function toDiffPayload(file: FileDiffInfo): DiffPayload | null {
  const path = typeof file.file === 'string' && file.file !== '' ? file.file : 'unknown file';
  return boundedDiff(path, patchLines(typeof file.patch === 'string' ? file.patch : ''));
}

/**
 * The files a finished OpenCode tool call changed, as diff payloads — the
 * OpenCode counterpart of the Claude adapter's `extractDiff`.
 *
 * V2 states this uniformly: a file-changing tool (edit, write, patch) puts
 * one `FileDiff.Info` per touched file under the result's `metadata.files`,
 * each with the file's path, its unified `patch`, its status and its line
 * counts. A delete or a move is therefore described the same way an edit is,
 * which is what makes the per-tool cases v1 needed (reading `filediff`,
 * falling back to the call's own `oldString`/`newString`, or to a written
 * `content`) unnecessary.
 */
export function toolCallDiffs(metadata: Record<string, unknown> | undefined): DiffPayload[] {
  const files = metadata?.files;
  const found: DiffPayload[] = [];
  for (const entry of Array.isArray(files) ? files : []) {
    const file = record(entry) as Partial<FileDiffInfo> | undefined;
    const path = typeof file?.file === 'string' && file.file !== '' ? file.file : undefined;
    if (!path) continue;
    const patch = typeof file?.patch === 'string' ? file.patch : '';
    const diff = boundedDiff(path, patchLines(patch));
    if (diff) found.push(diff);
  }
  return found;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The text of a tool result's content blocks; files it returned are named
 *  rather than inlined, since their bytes are not what the transcript shows. */
export function toolResultText(content: unknown, fallback: string): string {
  if (!Array.isArray(content)) return fallback;
  const parts: string[] = [];
  for (const block of content) {
    const b = record(block);
    if (typeof b?.text === 'string') parts.push(b.text);
    else if (typeof b?.uri === 'string') parts.push(`[${typeof b.name === 'string' && b.name ? b.name : b.uri}]`);
  }
  return parts.length > 0 ? parts.join('\n') : fallback;
}

/** A whole-file diff for a patch that carries no hunks of its own (a file
 *  created or deleted outright): every line is an addition or a deletion. */
export function wholeFileLines(text: string, kind: 'add' | 'del'): DiffLine[] {
  return toDiffLines(text, kind);
}
