/**
 * Translates OpenCode session events into transcript entries — the OpenCode
 * counterpart of the Claude driver's `sdkMessageToEntries`.
 *
 * The session (session.ts) filters OpenCode's raw event stream down to the
 * `OpenCodeEvent`s below — stable parts only, deduplicated — so this module
 * is pure: one event in, zero or more entries out.
 */
import type { Part, SnapshotFileDiff } from '@opencode-ai/sdk/v2/client';
import { toolKindOf, toolLocations, toolTitle } from '../../tools';
import {
  MAX_DIFF_LINE_CHARS,
  MAX_DIFF_LINES,
  toDiffLines,
  truncateToolResult,
  type DiffPayload,
  type TranslateContext,
} from '../../transcript';
import type { DiffLine, OutputEntry } from '../../types';

/** The OpenCode session exists server-side and accepts prompts. */
export interface OpenCodeStarted {
  type: 'started';
  model?: string;
}

/** OpenCode's `session.idle`: the turn is over. */
export interface OpenCodeIdle {
  type: 'idle';
}

/**
 * One OpenCode message Part that reached a stable, translatable state. The
 * session filters out mid-stream text/reasoning deltas before emitting this,
 * so this module never has to deduplicate a part it has already seen.
 */
export interface OpenCodePart {
  type: 'part';
  part: Part;
  /** `Part` itself carries no role; the session tracks whose turn produced it. */
  role: 'user' | 'assistant';
}

/** A provider/session-level failure reported outside any Part
 *  (`AssistantMessage.error`, or a `session.error` event). */
export interface OpenCodeError {
  type: 'error';
  content: string;
}

/** The session to resume no longer exists server-side and a fresh one was
 *  created instead — the model does not remember earlier turns, which the
 *  user must not learn only through a silent id change. */
export interface OpenCodeResumeLost {
  type: 'resume-lost';
}

/** One file of an older (pre-1.x) server's `session.diff`: whole-file
 *  before/after text instead of a unified patch. */
export interface LegacyFileDiff {
  file: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
}

/** OpenCode's `session.diff`, translated into `diff` entries. OpenCode 1.x
 *  sends each file as a unified `patch`; older servers sent whole-file
 *  `before`/`after` — both are read. A file changed through
 *  edit/write/apply_patch already got its card from that tool call
 *  ([toolCallDiffs]), and `session.diff` often carries only counts, so the
 *  session drops those files; this path covers the rest (a file a shell
 *  command changed). */
export interface OpenCodeDiff {
  type: 'diff';
  files: Array<SnapshotFileDiff | LegacyFileDiff>;
}

/** OpenCode asked the user a question (its `question` tool). The card comes
 *  from the bridge; this only marks the question tool's call as a card
 *  rather than a tool action. */
export interface OpenCodeQuestion {
  type: 'question';
  toolUseId: string;
}

export type OpenCodeEvent =
  | OpenCodeStarted
  | OpenCodeIdle
  | OpenCodePart
  | OpenCodeError
  | OpenCodeResumeLost
  | OpenCodeDiff
  | OpenCodeQuestion;

/** OpenCode's own question tool: its call renders as the question card. */
const QUESTION_TOOL = 'question';

/** Convert one OpenCode event into zero or more transcript entries. */
export function opencodeEventToEntries(event: OpenCodeEvent, ctx: TranslateContext): OutputEntry[] {
  const ts = new Date().toISOString();
  switch (event.type) {
    case 'started':
      return [{ entryType: 'status', text: `OpenCode session started${event.model ? ` (${event.model})` : ''}`, timestamp: ts }];
    case 'idle':
      return [{ entryType: 'turn_complete', timestamp: ts }];
    case 'part':
      return parsePart(event, ctx);
    case 'error':
      return [{ entryType: 'error', text: event.content, timestamp: ts }];
    case 'resume-lost':
      return [{
        entryType: 'notice',
        kind: 'session_restart',
        text:
          "OpenCode's session was missing — starting a fresh conversation in the same workspace. The transcript is preserved, but the model does not remember earlier turns.",
        timestamp: ts,
      }];
    case 'diff':
      return event.files.flatMap((file) => {
        const diff = toDiffPayload(file);
        if (!diff) return [];
        return { entryType: 'diff', ...diff, timestamp: ts } satisfies OutputEntry;
      });
    case 'question':
      ctx.hiddenCallIds.add(event.toolUseId);
      return [];
    default:
      return [];
  }
}

function parsePart(msg: OpenCodePart, ctx: TranslateContext): OutputEntry[] {
  const { part, role } = msg;
  const ts = new Date().toISOString();

  switch (part.type) {
    case 'text':
      if (!part.text) return [];
      return [{ entryType: 'text', role: role === 'user' ? 'user' : 'agent', text: part.text, timestamp: ts }];
    case 'reasoning':
      if (!part.text) return [];
      return [{ entryType: 'thinking', text: part.text, timestamp: ts }];
    case 'tool':
      return parseTool(part, ts, ctx);
    default:
      // Part kinds with nothing to show (file, subtask, agent, step markers,
      // snapshots, patches, retries, compaction).
      return [];
  }
}

function parseTool(part: Extract<Part, { type: 'tool' }>, ts: string, ctx: TranslateContext): OutputEntry[] {
  const state = part.state;
  if (part.tool === QUESTION_TOOL) ctx.hiddenCallIds.add(part.callID);
  if (ctx.hiddenCallIds.has(part.callID)) return [];

  // 'pending' input may still be streaming in — nothing stable to show yet.
  if (state.status === 'pending') return [];

  if (state.status === 'running') {
    const input = (state.input ?? {}) as Record<string, unknown>;
    const locations = toolLocations(input);
    return [{
      entryType: 'tool_call',
      callId: part.callID,
      toolName: part.tool,
      kind: toolKindOf(part.tool),
      title: toolTitle(part.tool, input),
      ...(locations.length > 0 ? { locations } : {}),
      rawInput: state.input,
      timestamp: ts,
    }];
  }

  if (state.status === 'completed') {
    const entries: OutputEntry[] = [{
      entryType: 'tool_result',
      callId: part.callID,
      text: truncateToolResult(state.output ?? ''),
      timestamp: ts,
    }];
    // A file-changing call gets the same diff cards Claude Code's Edit/Write
    // calls do. Taken from the COMPLETED call — the change has actually been
    // applied by then, and the tool's own metadata carries the real patch.
    for (const diff of toolCallDiffs(part.tool, state.input, state.metadata)) {
      entries.push({ entryType: 'diff', ...diff, callId: part.callID, timestamp: ts });
    }
    return entries;
  }

  // status === 'error'
  return [{
    entryType: 'tool_result',
    callId: part.callID,
    text: state.error ?? 'Tool call failed',
    isError: true,
    timestamp: ts,
  }];
}

// --- session.diff translation ---

/** Bounds the LCS table below at MAX_DIFF_SOURCE_LINES² cells per side. Above
 *  this, diffFileLines() falls back to a flat del/add rendering rather than
 *  pay an unbounded O(n·m) cost on a huge file. */
const MAX_DIFF_SOURCE_LINES = 2000;

/**
 * Real add/del/context line diff between two FULL file texts, for older
 * servers whose `session.diff` carried whole-file `before`/`after` content
 * (1.x sends a unified patch, read by `patchLines`). Flattening two full
 * files into del-then-add blocks would duplicate every unchanged line as both
 * a deletion and an addition — unusable for anything but a tiny file — so
 * this does a standard LCS line diff instead, at the cost of an O(n·m) table
 * for files under the guard.
 */
function diffFileLines(before: string, after: string): DiffLine[] {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  if (beforeLines.length > MAX_DIFF_SOURCE_LINES || afterLines.length > MAX_DIFF_SOURCE_LINES) {
    return [...toDiffLines(before, 'del'), ...toDiffLines(after, 'add')];
  }

  const n = beforeLines.length;
  const m = afterLines.length;
  // dp[i][j] = length of the LCS of beforeLines[i:] and afterLines[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        beforeLines[i] === afterLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (beforeLines[i] === afterLines[j]) {
      out.push({ type: 'context', text: truncateDiffLine(beforeLines[i]!) });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: 'del', text: truncateDiffLine(beforeLines[i]!) });
      i++;
    } else {
      out.push({ type: 'add', text: truncateDiffLine(afterLines[j]!) });
      j++;
    }
  }
  while (i < n) {
    out.push({ type: 'del', text: truncateDiffLine(beforeLines[i]!) });
    i++;
  }
  while (j < m) {
    out.push({ type: 'add', text: truncateDiffLine(afterLines[j]!) });
    j++;
  }
  return out;
}

function truncateDiffLine(line: string): string {
  return line.length > MAX_DIFF_LINE_CHARS ? line.slice(0, MAX_DIFF_LINE_CHARS) + '…' : line;
}

/**
 * Lines of a unified diff. File headers (`diff`, `index`, `---`, `+++`) are
 * only skipped before the first hunk: inside a hunk, `---x` is the deletion
 * of the line `--x`, not a header. Hunk headers and "\ No newline" markers
 * carry no line content.
 */
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

/** `null` when the event carries no line content at all (only counts) —
 *  there is nothing to render as a card then. */
function toDiffPayload(file: SnapshotFileDiff | LegacyFileDiff): DiffPayload | null {
  let lines: DiffLine[];
  if ('patch' in file && typeof file.patch === 'string') {
    lines = patchLines(file.patch);
  } else if ('before' in file && typeof file.before === 'string' && typeof file.after === 'string') {
    lines = diffFileLines(file.before, file.after);
  } else {
    return null;
  }
  return boundedDiff(file.file ?? 'unknown file', lines);
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

// --- tool-call diffs ---

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The files a COMPLETED OpenCode tool call changed, as diff payloads — the
 * OpenCode counterpart of the Claude adapter's `extractDiff`. What each tool
 * reports (OpenCode 1.x):
 *
 * - `edit`: `metadata.filediff = {file, patch, …}` (and `metadata.diff`,
 *   the same unified patch); the input's `oldString`/`newString` are the
 *   fallback when neither is present.
 * - `write`: metadata carries no diff, so the written `content` is the
 *   card — all additions, exactly like Claude Code's Write.
 * - `apply_patch` (listed as `patch` by some servers): one
 *   `metadata.files[]` entry per touched file, `type` add/update/delete/
 *   move, with its unified `patch` (or `diff`). A delete without one still
 *   gets a card, so a removed file is never silent.
 *
 * Any other tool, or a call without usable content, yields nothing.
 */
export function toolCallDiffs(
  tool: string,
  input: Record<string, unknown>,
  metadata: Record<string, unknown> | undefined,
): DiffPayload[] {
  const found: Array<DiffPayload | null> = [];
  switch (tool) {
    case 'edit': {
      const filediff = record(metadata?.filediff);
      const path = str(filediff?.file) ?? str(input.filePath);
      if (!path) break;
      const patch = str(filediff?.patch) ?? str(metadata?.diff);
      if (patch) {
        found.push(boundedDiff(path, patchLines(patch)));
      } else {
        const oldStr = str(input.oldString);
        const newStr = str(input.newString);
        found.push(boundedDiff(path, [
          ...(oldStr ? toDiffLines(oldStr, 'del') : []),
          ...(newStr ? toDiffLines(newStr, 'add') : []),
        ]));
      }
      break;
    }
    case 'write': {
      const path = str(input.filePath) ?? str(metadata?.filepath);
      const content = str(input.content);
      if (path && content) found.push(boundedDiff(path, toDiffLines(content, 'add')));
      break;
    }
    case 'patch':
    case 'apply_patch': {
      const files: unknown = metadata?.files;
      for (const entry of Array.isArray(files) ? files : []) {
        const file = record(entry);
        if (!file) continue;
        // A move shows where the file ended up.
        const path = str(file.movePath) ?? str(file.filePath) ?? str(file.relativePath);
        if (!path) continue;
        const patch = str(file.patch) ?? str(file.diff);
        let lines = patch ? patchLines(patch) : [];
        if (lines.length === 0 && file.type === 'delete') {
          const oldContent = str(file.oldContent);
          lines = oldContent ? toDiffLines(oldContent, 'del') : [{ type: 'context', text: '(file deleted)' }];
        } else if (lines.length === 0 && file.type === 'add') {
          const newContent = str(file.newContent);
          if (newContent) lines = toDiffLines(newContent, 'add');
        }
        found.push(boundedDiff(path, lines));
      }
      break;
    }
    default:
      break;
  }
  return found.filter((d): d is DiffPayload => d !== null);
}
