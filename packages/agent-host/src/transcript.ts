/**
 * Transcript helpers shared by every driver's translator: per-session
 * translation state, and the size caps that keep one entry comfortably
 * inside a relay event.
 */
import type { DiffLine } from './types';

/** Per-session state a translator keeps across messages. */
export interface TranslateContext {
  /** Tool-call ids whose call and result are not shown as tool actions
   *  (questions and plan approval render as their own cards). */
  hiddenCallIds: Set<string>;
}

export function newTranslateContext(): TranslateContext {
  return { hiddenCallIds: new Set() };
}

/** A tool result's text is capped so one entry stays well inside a relay event. */
export const MAX_TOOL_RESULT_CHARS = 4000;
/** Of a capped result, how much of its start is kept; the rest of the budget
 *  goes to its end, where a command reports how it finished (the failing
 *  test, the error, the summary line). */
const RESULT_HEAD_CHARS = 1000;

export function truncateToolResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  const tail = MAX_TOOL_RESULT_CHARS - RESULT_HEAD_CHARS;
  const omitted = text.length - MAX_TOOL_RESULT_CHARS;
  return `${text.slice(0, RESULT_HEAD_CHARS)}\n…[${omitted} characters omitted]…\n${text.slice(-tail)}`;
}

/** Wire caps for a diff entry (a whole-file write can be long). */
export const MAX_DIFF_LINES = 200;
export const MAX_DIFF_LINE_CHARS = 500;

/** A diff entry's payload (its path, lines, and whether lines were dropped). */
export interface DiffPayload {
  path: string;
  lines: DiffLine[];
  truncated?: boolean;
}

export function toDiffLines(text: string, type: DiffLine['type']): DiffLine[] {
  return text.split('\n').map((line) => ({
    type,
    text: line.length > MAX_DIFF_LINE_CHARS ? line.slice(0, MAX_DIFF_LINE_CHARS) + '…' : line,
  }));
}
