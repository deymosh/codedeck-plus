/**
 * Translates synthesized OpenCode messages into Codedeck OutputEntry objects —
 * the OpenCode-backend counterpart of `sdk/adapter.ts`'s `sdkMessageToEntries`.
 *
 * `SdkSessionHandle.messages()` is typed as `AsyncIterable<SdkMessage>`, and
 * `SdkMessage` is a literal re-export of the Claude Agent SDK's own union —
 * `@opencode-ai/sdk`'s `Message`/`Part`/`Event` shapes have nothing to do with
 * it. `opencodeFacade.ts` bridges this by wrapping each OpenCode event it
 * cares about in one of the small envelopes below (cast `as unknown as
 * SdkMessage` at the seam, mirroring the existing `msg as unknown as
 * {state: string}` cast `session/runner.ts` already does for
 * `session_state_changed`) and this module is the ONLY place that unwraps and
 * reads them. `SessionRunner` never branches on which backend produced a
 * message — it calls whichever `translateMessage` function `bridge.ts`'s
 * `makeRunner` injected for the session's `backend`.
 */
import type { DiffData, DiffLine, OutputEntry } from '@codedeck/protocol';
import type { Part, SnapshotFileDiff } from '@opencode-ai/sdk/v2/client';
import { askQuestionEntries, MAX_DIFF_LINE_CHARS, MAX_DIFF_LINES, renderDiffFallback, toDiffLines } from './adapter';
import type { AdapterOptions, AskQuestionSpec } from './adapter';
import type { SdkMessage } from './facade';

/**
 * Synthesized once, right after `probeReady()` resolves — drives the SAME
 * `type: 'system', subtype: 'init'` branch `session/runner.ts` already has
 * for Claude Code, so the runner picks up `sdkSessionId`/`model`/
 * `permissionMode` with no backend-specific code.
 */
export interface OpenCodeInitMessage {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model?: string;
  permissionMode?: string;
}

/**
 * Synthesized on OpenCode's `session.idle` event — drives the SAME
 * `subtype: 'session_state_changed'` branch the runner already has for
 * Claude Code (stream_end / idle detection).
 */
export interface OpenCodeStateMessage {
  type: 'system';
  subtype: 'session_state_changed';
  state: 'idle' | 'running';
}

/**
 * One OpenCode message Part that reached a stable, translatable state.
 * `OpenCodeSessionHandle` filters out mid-stream text/reasoning deltas before
 * emitting this — see its doc comment — so this module never has to
 * deduplicate a part it has already seen.
 */
export interface OpenCodePartMessage {
  type: 'opencode-part';
  part: Part;
  /** `Part` itself carries no role; the handle tracks whose turn produced it. */
  role: 'user' | 'assistant';
}

/** A provider/session-level failure reported outside any Part
 *  (`AssistantMessage.error`, or a `session.error` event). */
export interface OpenCodeErrorMessage {
  type: 'opencode-error';
  content: string;
}

/** Synthesized once, right before the `init` message, when
 *  `OpenCodeSessionHandle.resolveSession()` found `opts.resume` no longer
 *  exists server-side and had to fall back to a brand-new session — the
 *  OpenCode counterpart of Claude Code's CDX-056/073 "conversation missing"
 *  notice, which the phone must not learn about only through a silent id
 *  change. */
export interface OpenCodeResumeLostMessage {
  type: 'opencode-resume-lost';
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

/** Synthesized from OpenCode's `session.diff` event, translated here into the
 *  same `entryType: 'diff'` cards Claude Code's CDX-050 diff entries use.
 *  OpenCode 1.x sends each file as a unified `patch`; older servers sent
 *  whole-file `before`/`after` — both are read. */
export interface OpenCodeDiffMessage {
  type: 'opencode-diff';
  files: Array<SnapshotFileDiff | LegacyFileDiff>;
}

/** OpenCode asked the user a question (its `question` tool). Rendered as the
 *  same question card Claude Code's AskUserQuestion produces; `toolUseId` is
 *  the question tool's call id, so that tool's own result later marks the
 *  card answered. */
export interface OpenCodeQuestionMessage {
  type: 'opencode-question';
  toolUseId: string;
  questions: AskQuestionSpec[];
}

export type OpenCodeAdapterMessage =
  | OpenCodeInitMessage
  | OpenCodeStateMessage
  | OpenCodePartMessage
  | OpenCodeErrorMessage
  | OpenCodeResumeLostMessage
  | OpenCodeDiffMessage
  | OpenCodeQuestionMessage;

/**
 * Convert one synthesized OpenCode message envelope into zero or more
 * OutputEntry objects. Signature matches `sdkMessageToEntries` exactly so
 * `SessionRunnerOptions.translateMessage` can hold either interchangeably.
 */
export function opencodeMessageToEntries(msg: SdkMessage, opts?: AdapterOptions): OutputEntry[] {
  const envelope = msg as unknown as OpenCodeAdapterMessage;
  switch (envelope.type) {
    case 'system':
      return parseSystem(envelope);
    case 'opencode-part':
      return parsePart(envelope);
    case 'opencode-error':
      return [{
        entryType: 'error',
        content: envelope.content,
        timestamp: new Date().toISOString(),
      }];
    case 'opencode-resume-lost':
      return [{
        entryType: 'system',
        content:
          "OpenCode's session was missing — starting a fresh conversation in the same workspace. The transcript is preserved, but the model does not remember earlier turns.",
        timestamp: new Date().toISOString(),
        metadata: { special: 'session_restart' },
      }];
    case 'opencode-diff':
      // Gated on the phone-side 'diff' capability by the caller, same as
      // Claude Code's own CDX-050 entries (adapter.ts) — the field is threaded
      // through this function's signature but was never read before this.
      if (!opts?.emitDiffEntries) return [];
      return envelope.files.flatMap((file) => {
        const diff = toDiffData(file);
        if (!diff) return [];
        return {
          entryType: 'diff',
          content: renderDiffFallback(diff),
          timestamp: new Date().toISOString(),
          metadata: { role: 'assistant' },
          diff,
        } satisfies OutputEntry;
      });
    case 'opencode-question':
      return askQuestionEntries(envelope.toolUseId, envelope.questions, new Date().toISOString());
    default:
      // Any OpenCode Part kind this pass doesn't translate (file, subtask,
      // agent, step markers, snapshots, patches, retries, compaction) — skip,
      // same policy as sdkMessageToEntries's default case.
      return [];
  }
}

function parseSystem(msg: OpenCodeInitMessage | OpenCodeStateMessage): OutputEntry[] {
  if (msg.subtype === 'init') {
    return [{
      entryType: 'system',
      content: `OpenCode session started${msg.model ? ` (${msg.model})` : ''}`,
      timestamp: new Date().toISOString(),
      metadata: {
        subtype: 'init',
        ...(msg.model ? { model: msg.model } : {}),
        ...(msg.permissionMode ? { permissionMode: msg.permissionMode } : {}),
      },
    }];
  }

  if (msg.state === 'idle') {
    // Same authoritative "turn is over" signal the phone reads from Claude
    // Code's session_state_changed — see sdk/adapter.ts's parseSystem.
    return [{
      entryType: 'system',
      content: '',
      timestamp: new Date().toISOString(),
      metadata: { stream_end: true },
    }];
  }
  return [];
}

function parsePart(msg: OpenCodePartMessage): OutputEntry[] {
  const { part, role } = msg;
  const ts = new Date().toISOString();

  switch (part.type) {
    case 'text':
      if (!part.text) return [];
      return [{
        entryType: 'text',
        content: part.text,
        timestamp: ts,
        metadata: { role },
      }];
    case 'reasoning':
      if (!part.text) return [];
      return [{
        entryType: 'thinking',
        content: part.text,
        timestamp: ts,
        metadata: { role },
      }];
    case 'tool':
      return parseTool(part, ts);
    default:
      return [];
  }
}

function parseTool(part: Extract<Part, { type: 'tool' }>, ts: string): OutputEntry[] {
  const state = part.state;

  // 'pending' input may still be streaming in — nothing stable to show yet.
  if (state.status === 'pending') return [];

  if (state.status === 'running') {
    return [{
      entryType: 'tool_use',
      content: formatToolInput(part.tool, state.input as Record<string, unknown>),
      timestamp: ts,
      metadata: {
        role: 'assistant',
        tool_name: part.tool,
        tool_use_id: part.callID,
        tool_input: state.input,
      },
    }];
  }

  if (state.status === 'completed') {
    const output = state.output ?? '';
    const text = output.length > 2000 ? output.slice(0, 2000) + '...[truncated]' : output;
    return [{
      entryType: 'tool_result',
      content: text,
      timestamp: ts,
      metadata: { tool_use_id: part.callID },
    }];
  }

  // status === 'error'
  return [{
    entryType: 'tool_result',
    content: state.error ?? 'Tool call failed',
    timestamp: ts,
    metadata: { tool_use_id: part.callID, error: true },
  }];
}

function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  return `${toolName}: ${JSON.stringify(input ?? {}).slice(0, 200)}`;
}

// --- session.diff translation ---

/** Bounds the LCS table below at MAX_DIFF_SOURCE_LINES² cells per side. Above
 *  this, diffFileLines() falls back to a flat del/add rendering rather than
 *  pay an unbounded O(n·m) cost on a huge file. */
const MAX_DIFF_SOURCE_LINES = 2000;

/**
 * Real add/del/context line diff between two FULL file texts, for older
 * servers whose `session.diff` carried whole-file `before`/`after` content
 * (1.x sends a unified patch, read by `patchLines`), unlike
 * Claude Code's Edit/Write tool inputs (old_string/new_string/content —
 * extractDiff() in adapter.ts), which only ever have the edited snippet to
 * flatten into del-then-add blocks. Flattening two full files that same way
 * would duplicate every unchanged line as both a deletion and an addition —
 * unusable for anything but a tiny file — so this does a standard LCS line
 * diff instead, at the cost of an O(n·m) table for files under the guard.
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
function toDiffData(file: SnapshotFileDiff | LegacyFileDiff): DiffData | null {
  let lines: DiffLine[];
  if ('patch' in file && typeof file.patch === 'string') {
    lines = patchLines(file.patch);
  } else if ('before' in file && typeof file.before === 'string' && typeof file.after === 'string') {
    lines = diffFileLines(file.before, file.after);
  } else {
    return null;
  }
  if (lines.length === 0) return null;
  const truncated = lines.length > MAX_DIFF_LINES;
  return {
    path: file.file ?? 'unknown file',
    lines: truncated ? lines.slice(0, MAX_DIFF_LINES) : lines,
    ...(truncated ? { truncated: true } : {}),
  };
}
