/**
 * opencodeEventToEntries — mirrors sdk-adapter.test.ts's style for the
 * OpenCode translator.
 *
 * V2 states each thing that happens as its own event (text, reasoning and a
 * tool call each arrive as started/…/ended), so the events here are the
 * *finished* halves the session normalizes the stream down to.
 */
import { describe, it, expect } from 'vitest';
import { opencodeEventToEntries, toolCallDiffs, toolResultText } from '../adapter';
import type { OpenCodeEvent } from '../adapter';
import { newTranslateContext, type TranslateContext } from '../../../sdk/transcript';
import type { OutputEntry } from '../../../sdk/types';
import type { FileDiffInfo } from '@opencode/client';

type EntryOf<T extends OutputEntry['entryType']> = Extract<OutputEntry, { entryType: T }>;

function translate(msg: unknown, ctx: TranslateContext = newTranslateContext()): OutputEntry[] {
  return opencodeEventToEntries(msg as OpenCodeEvent, ctx);
}

const subagent = { parentCallId: 'call_parent' };

const diffs = (entries: OutputEntry[]) =>
  entries.filter((e): e is EntryOf<'diff'> => e.entryType === 'diff');

/** A file OpenCode reports as changed by a call. */
const fileDiff = (file: string, patch: string, status: FileDiffInfo['status'] = 'modified'): FileDiffInfo =>
  ({ file, patch, additions: 1, deletions: 0, status });

describe('opencodeEventToEntries', () => {
  describe('session lifecycle', () => {
    it('converts idle into turn_complete', () => {
      expect(translate({ type: 'idle' })).toEqual([
        expect.objectContaining({ entryType: 'turn_complete' }),
      ]);
    });
  });

  describe('messages', () => {
    it('converts an assistant text into agent text', () => {
      expect(translate({ type: 'text', role: 'assistant', text: 'done' })).toEqual([
        expect.objectContaining({ entryType: 'text', role: 'agent', text: 'done' }),
      ]);
    });

    it('converts a user text into user text', () => {
      expect(translate({ type: 'text', role: 'user', text: 'hi' })).toEqual([
        expect.objectContaining({ entryType: 'text', role: 'user', text: 'hi' }),
      ]);
    });

    it('converts reasoning into a thinking entry', () => {
      expect(translate({ type: 'reasoning', text: 'hmm' })).toEqual([
        expect.objectContaining({ entryType: 'thinking', text: 'hmm' }),
      ]);
    });

    it('drops empty reasoning', () => {
      expect(translate({ type: 'reasoning', text: '' })).toEqual([]);
    });
  });

  describe('tool calls', () => {
    it('converts a starting call into a typed tool call, with its input', () => {
      const [entry] = translate({ type: 'tool-start', callId: 'call_1', toolName: 'shell', input: { command: 'ls -la' } });
      expect(entry).toMatchObject({ entryType: 'tool_call', callId: 'call_1', toolName: 'shell', kind: 'execute' });
      expect((entry as EntryOf<'tool_call'>).title).toBeTruthy();
    });

    it('pairs a finished call with its call id, and truncates a long output', () => {
      const long = 'x'.repeat(20_000);
      const entries = translate({ type: 'tool-result', callId: 'call_1', text: long, diffs: [] });
      const result = entries.find((e): e is EntryOf<'tool_result'> => e.entryType === 'tool_result')!;
      expect(result.callId).toBe('call_1');
      expect(result.text.length).toBeLessThan(long.length);
    });

    it('marks a failed call as an error result', () => {
      const entries = translate({ type: 'tool-result', callId: 'call_1', text: 'boom', isError: true, diffs: [] });
      expect(entries[0]).toMatchObject({ entryType: 'tool_result', isError: true });
    });

    it("hides OpenCode's own question tool — the card comes from the form it raises", () => {
      const ctx = newTranslateContext();
      expect(translate({ type: 'tool-start', callId: 'call_q', toolName: 'question', input: {} }, ctx)).toEqual([]);
      expect(ctx.hiddenCallIds.has('call_q')).toBe(true);
      // Its result is what marks the card answered, so it is still shown.
      expect(translate({ type: 'tool-result', callId: 'call_q', text: 'answered', diffs: [] }, ctx)).toHaveLength(1);
    });
  });

  describe('error, status and resume-lost', () => {
    it('converts a failure into an error entry', () => {
      expect(translate({ type: 'error', content: 'provider exploded' })).toEqual([
        expect.objectContaining({ entryType: 'error', text: 'provider exploded' }),
      ]);
    });

    it('converts a status line into a status entry', () => {
      expect(translate({ type: 'status', text: 'retrying' })[0]).toMatchObject({ entryType: 'status', text: 'retrying' });
    });

    it('converts a lost resume target into a session_restart notice, like a Claude Code restart', () => {
      expect(translate({ type: 'resume-lost' })[0]).toMatchObject({ entryType: 'notice', kind: 'session_restart' });
    });
  });

  describe('diffs', () => {
    it('renders one entry per file from its unified patch, with real add/del/context lines', () => {
      const entries = diffs(translate({
        type: 'diff',
        files: [fileDiff('a.ts', [
          '--- a.ts',
          '+++ a.ts',
          '@@ -1,3 +1,3 @@',
          ' keep',
          '-old',
          '+new',
        ].join('\n'))],
      }));
      expect(entries).toHaveLength(1);
      expect(entries[0]!.path).toBe('a.ts');
      expect(entries[0]!.lines).toEqual([
        { type: 'context', text: 'keep' },
        { type: 'del', text: 'old' },
        { type: 'add', text: 'new' },
      ]);
    });

    it('reads a "---" line inside a hunk as a deletion, not a header', () => {
      const entries = diffs(translate({
        type: 'diff',
        files: [fileDiff('a.ts', ['@@ -1 +1 @@', '---x', '+++y'].join('\n'))],
      }));
      expect(entries[0]!.lines).toEqual([
        { type: 'del', text: '--x' },
        { type: 'add', text: '++y' },
      ]);
    });

    it('emits one entry per file for a multi-file diff event', () => {
      const entries = diffs(translate({
        type: 'diff',
        files: [fileDiff('a.ts', '@@ -1 +1 @@\n-a\n+b'), fileDiff('b.ts', '@@ -1 +1 @@\n-c\n+d')],
      }));
      expect(entries.map((e) => e.path)).toEqual(['a.ts', 'b.ts']);
    });

    it('a file with only counts produces no card instead of throwing', () => {
      expect(diffs(translate({ type: 'diff', files: [fileDiff('a.ts', '')] }))).toEqual([]);
    });
  });

  describe('diffs from finished file-changing tool calls', () => {
    it('takes one card per file from metadata.files, patch and all', () => {
      const found = toolCallDiffs({
        files: [fileDiff('src/a.ts', '@@ -1 +1 @@\n-old\n+new'), fileDiff('src/b.ts', '', 'deleted')],
      });
      expect(found.map((d) => d.path)).toEqual(['src/a.ts']);
      expect(found[0]!.lines).toEqual([{ type: 'del', text: 'old' }, { type: 'add', text: 'new' }]);
    });

    it('a call that changed no file, or carries no metadata, produces no card', () => {
      expect(toolCallDiffs(undefined)).toEqual([]);
      expect(toolCallDiffs({ status: 'completed' })).toEqual([]);
    });
  });
});

describe('sub-agents and background tasks', () => {
  it("tags a sub-agent's entries with the call that started it, and drops its prompt", () => {
    expect(translate({ type: 'text', role: 'assistant', text: 'child says', subagent })).toEqual([
      expect.objectContaining({ entryType: 'text', text: 'child says', subagent }),
    ]);
    // The parent's `subagent` call already carries the prompt as its input.
    expect(translate({ type: 'text', role: 'user', text: 'do a thing', subagent })).toEqual([]);
  });

  it('sends the checklist a todo-writing call makes', () => {
    const entries = translate({
      type: 'tool-start',
      callId: 'call_1',
      toolName: 'todowrite',
      input: { todos: [{ content: 'write tests', status: 'pending' }] },
    });
    expect(entries.find((e) => e.entryType === 'todos')).toMatchObject({
      entryType: 'todos',
      items: [{ text: 'write tests' }],
    });
  });

  it('reports a background sub-agent as a task', () => {
    expect(translate({ type: 'task', taskId: 'ses_child', kind: 'agent', title: 'explore', status: 'running', callId: 'call_1' })).toEqual([
      expect.objectContaining({ entryType: 'background_task', taskId: 'ses_child', status: 'running', kind: 'agent' }),
    ]);
  });

  it('reports a background shell command as a shell task', () => {
    expect(translate({ type: 'task', taskId: 'sh_1', kind: 'shell', title: 'npm run dev', status: 'completed', callId: 'call_1' })).toEqual([
      expect.objectContaining({ entryType: 'background_task', taskId: 'sh_1', status: 'completed', kind: 'shell' }),
    ]);
  });

  it('returns nothing for an unrecognized envelope type', () => {
    expect(translate({ type: 'nonsense' })).toEqual([]);
  });
});

describe('toolResultText', () => {
  it('joins the text blocks and names a file block rather than inlining it', () => {
    expect(toolResultText([{ type: 'text', text: 'out' }, { type: 'file', uri: 'file:///a.png', mime: 'image/png' }], 'fallback'))
      .toBe('out\n[file:///a.png]');
  });

  it('falls back when there is no content at all', () => {
    expect(toolResultText(undefined, 'fallback')).toBe('fallback');
    expect(toolResultText([], 'fallback')).toBe('fallback');
  });
});
