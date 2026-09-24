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
export const MAX_TOOL_RESULT_CHARS = 2000;

export function truncateToolResult(text: string): string {
  return text.length > MAX_TOOL_RESULT_CHARS ? text.slice(0, MAX_TOOL_RESULT_CHARS) + '...[truncated]' : text;
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
