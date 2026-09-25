/**
 * opencodeEventToEntries — mirrors sdk-adapter.test.ts's style for the
 * OpenCode translator.
 */
import { describe, it, expect } from 'vitest';
import { opencodeEventToEntries } from '../drivers/opencode/adapter';
import type {
  OpenCodeStarted,
  OpenCodeIdle,
  OpenCodeEvent,
  OpenCodePart,
  OpenCodeError,
  OpenCodeResumeLost,
  OpenCodeDiff,
  OpenCodeQuestion,
  LegacyFileDiff,
} from '../drivers/opencode/adapter';
import { newTranslateContext, type TranslateContext } from '../transcript';
import type { OutputEntry } from '../types';
import type { Part } from '@opencode-ai/sdk/v2/client';

type EntryOf<T extends OutputEntry['entryType']> = Extract<OutputEntry, { entryType: T }>;

function translate(msg: unknown, ctx: TranslateContext = newTranslateContext()): OutputEntry[] {
  return opencodeEventToEntries(msg as OpenCodeEvent, ctx);
}

function partMsg(part: unknown, role: 'user' | 'assistant' = 'assistant'): OpenCodePart {
  return { type: 'part', part: part as Part, role };
}

function toolPart(state: Record<string, unknown>, tool = 'bash', callID = 'call_1'): OpenCodePart {
  return partMsg({ type: 'tool', id: 'p4', sessionID: 's1', messageID: 'm1', callID, tool, state });
}

const diffs = (entries: OutputEntry[]) =>
  entries.filter((e): e is EntryOf<'diff'> => e.entryType === 'diff');

describe('opencodeEventToEntries', () => {
  describe('session lifecycle', () => {
    it('converts started into a status line naming the model', () => {
      const msg: OpenCodeStarted = { type: 'started', model: 'anthropic/claude-sonnet-4-6' };
      expect(translate(msg)).toEqual([
        { entryType: 'status', text: 'OpenCode session started (anthropic/claude-sonnet-4-6)', timestamp: expect.any(String) },
      ]);
    });

    it('converts started with no model without throwing', () => {
      const msg: OpenCodeStarted = { type: 'started' };
      expect(translate(msg)).toMatchObject([{ entryType: 'status', text: 'OpenCode session started' }]);
    });

    it('converts idle into turn_complete', () => {
      const msg: OpenCodeIdle = { type: 'idle' };
      expect(translate(msg)).toEqual([{ entryType: 'turn_complete', timestamp: expect.any(String) }]);
    });
  });

  describe('part messages', () => {
    it('converts an assistant text part into agent text', () => {
      const entries = translate(partMsg({ type: 'text', id: 'p1', sessionID: 's1', messageID: 'm1', text: 'Hello from OpenCode' }));
      expect(entries).toEqual([{ entryType: 'text', role: 'agent', text: 'Hello from OpenCode', timestamp: expect.any(String) }]);
    });

    it('drops an empty text part', () => {
      expect(translate(partMsg({ type: 'text', id: 'p1', sessionID: 's1', messageID: 'm1', text: '' }))).toEqual([]);
    });

    it('converts a reasoning part into a thinking entry', () => {
      const entries = translate(partMsg({
        type: 'reasoning', id: 'p2', sessionID: 's1', messageID: 'm1', text: 'thinking it through', time: { start: 0 },
      }));
      expect(entries).toEqual([{ entryType: 'thinking', text: 'thinking it through', timestamp: expect.any(String) }]);
    });

    it('converts a user text part into user text', () => {
      const entries = translate(partMsg({ type: 'text', id: 'p3', sessionID: 's1', messageID: 'm2', text: 'do the thing' }, 'user'));
      expect(entries[0]).toMatchObject({ entryType: 'text', role: 'user' });
    });

    it('skips a pending tool part', () => {
      expect(translate(toolPart({ status: 'pending', input: {}, raw: '' }))).toEqual([]);
    });

    it('converts a running tool part into a typed tool call', () => {
      const entries = translate(toolPart({ status: 'running', input: { command: 'ls -la' }, time: { start: 0 } }));
      expect(entries).toEqual([{
        entryType: 'tool_call',
        callId: 'call_1',
        toolName: 'bash',
        kind: 'execute',
        title: 'ls -la',
        rawInput: { command: 'ls -la' },
        timestamp: expect.any(String),
      }]);
    });

    it('converts a completed tool part into a tool_result paired by call id', () => {
      const entries = translate(toolPart({
        status: 'completed', input: { command: 'ls -la' }, output: 'file1.txt\nfile2.txt',
        title: 'bash', metadata: {}, time: { start: 0, end: 1 },
      }));
      expect(entries).toEqual([
        { entryType: 'tool_result', callId: 'call_1', text: 'file1.txt\nfile2.txt', timestamp: expect.any(String) },
      ]);
    });

    it('truncates a long completed tool output', () => {
      const longOutput = 'x'.repeat(3000);
      const [result] = translate(toolPart({
        status: 'completed', input: {}, output: longOutput, title: 'bash', metadata: {}, time: { start: 0, end: 1 },
      })) as EntryOf<'tool_result'>[];
      expect(result!.text.length).toBeLessThan(longOutput.length);
      expect(result!.text).toContain('[truncated]');
    });

    it('converts an errored tool part into an error tool_result', () => {
      const entries = translate(toolPart({ status: 'error', input: {}, error: 'command not found', time: { start: 0, end: 1 } }));
      expect(entries).toEqual([
        { entryType: 'tool_result', callId: 'call_1', text: 'command not found', isError: true, timestamp: expect.any(String) },
      ]);
    });

    it('hides OpenCode\'s own question tool — the question card comes from the permission broker', () => {
      const ctx = newTranslateContext();
      expect(translate(toolPart({ status: 'running', input: {}, time: { start: 0 } }, 'question', 'call_q'), ctx)).toEqual([]);
      expect(translate(toolPart({
        status: 'completed', input: {}, output: 'answered', title: '', metadata: {}, time: { start: 0, end: 1 },
      }, 'question', 'call_q'), ctx)).toEqual([]);
    });

    it('drops an unhandled part kind (e.g. file)', () => {
      expect(translate(partMsg({ type: 'file', id: 'p5', sessionID: 's1', messageID: 'm1', mime: 'text/plain', url: 'file:///x' }))).toEqual([]);
    });
  });

  describe('error messages', () => {
    it('converts a provider/session error into an error entry', () => {
      const msg: OpenCodeError = { type: 'error', content: 'provider auth failed' };
      expect(translate(msg)).toEqual([{ entryType: 'error', text: 'provider auth failed', timestamp: expect.any(String) }]);
    });
  });

  describe('resume-lost messages', () => {
    it('converts a lost resume target into a session_restart notice, like a Claude Code restart', () => {
      const msg: OpenCodeResumeLost = { type: 'resume-lost' };
      const [notice] = translate(msg) as EntryOf<'notice'>[];
      expect(notice).toMatchObject({ entryType: 'notice', kind: 'session_restart' });
      expect(notice!.text).toMatch(/does not remember earlier turns/);
    });
  });

  describe('diff messages', () => {
    function fileDiff(over: Partial<LegacyFileDiff> = {}): LegacyFileDiff {
      return { file: 'src/a.ts', before: 'line1\nline2\nline3', after: 'line1\nCHANGED\nline3', additions: 1, deletions: 1, ...over };
    }

    it('renders one diff entry per file, with real add/del/context lines (not a flat before/after dump)', () => {
      const msg: OpenCodeDiff = { type: 'diff', files: [fileDiff()] };
      expect(translate(msg)).toEqual([{
        entryType: 'diff',
        path: 'src/a.ts',
        lines: [
          { type: 'context', text: 'line1' },
          { type: 'del', text: 'line2' },
          { type: 'add', text: 'CHANGED' },
          { type: 'context', text: 'line3' },
        ],
        timestamp: expect.any(String),
      }]);
    });

    it('emits one entry per file for a multi-file diff event', () => {
      const msg: OpenCodeDiff = { type: 'diff', files: [fileDiff({ file: 'a.ts' }), fileDiff({ file: 'b.ts' })] };
      expect(diffs(translate(msg)).map((e) => e.path)).toEqual(['a.ts', 'b.ts']);
    });

    it('falls back to a flat del/add rendering (no LCS) for a file above the line-count guard', () => {
      const bigBefore = Array.from({ length: 2001 }, (_, i) => `l${i}`).join('\n');
      const bigAfter = Array.from({ length: 2001 }, (_, i) => `l${i}x`).join('\n');
      const msg: OpenCodeDiff = { type: 'diff', files: [fileDiff({ file: 'huge.ts', before: bigBefore, after: bigAfter })] };
      const [diff] = diffs(translate(msg));
      // Flat fallback: no LCS ran, so no 'context' lines at all — and since the
      // 'del' block (2001 lines) alone exceeds the MAX_DIFF_LINES=200 wire cap,
      // the truncated output is entirely 'del'.
      expect(diff!.lines.length).toBe(200);
      expect(diff!.lines.every((l) => l.type === 'del')).toBe(true);
      expect(diff!.truncated).toBe(true);
    });

    it('reads a 1.x unified patch (headers skipped, a "---" line inside a hunk is a deletion)', () => {
      const patch = [
        'diff --git a/src/a.ts b/src/a.ts',
        'index 1..2 100644',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,3 +1,3 @@',
        ' keep',
        '-old',
        '+new',
        '---dashes',
        '\\ No newline at end of file',
      ].join('\n');
      const msg: OpenCodeDiff = {
        type: 'diff',
        files: [{ file: 'src/a.ts', patch, additions: 1, deletions: 2, status: 'modified' }],
      };
      const [diff] = diffs(translate(msg));
      expect(diff!.path).toBe('src/a.ts');
      expect(diff!.lines).toEqual([
        { type: 'context', text: 'keep' },
        { type: 'del', text: 'old' },
        { type: 'add', text: 'new' },
        { type: 'del', text: '--dashes' },
      ]);
    });

    it('a file with only counts (no patch, no before/after) produces no card instead of throwing', () => {
      const msg: OpenCodeDiff = { type: 'diff', files: [{ file: 'bin.png', additions: 0, deletions: 0 }] };
      expect(translate(msg)).toEqual([]);
    });
  });

  describe('diffs from completed file-changing tool calls', () => {
    function completed(tool: string, input: Record<string, unknown>, metadata: Record<string, unknown> = {}) {
      return toolPart({ status: 'completed', input, output: 'ok', title: '', metadata, time: { start: 1, end: 2 } }, tool);
    }

    it('edit: reads the unified patch from metadata.filediff, after the tool_result', () => {
      const patch = 'Index: /w/a.ts\n===\n--- /w/a.ts\n+++ /w/a.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n';
      const entries = translate(completed('edit', { filePath: '/w/a.ts', oldString: 'old', newString: 'new' }, {
        filediff: { file: '/w/a.ts', patch, additions: 1, deletions: 1 },
      }));
      expect(entries.map((e) => e.entryType)).toEqual(['tool_result', 'diff']);
      expect(entries[1]).toEqual({
        entryType: 'diff',
        path: '/w/a.ts',
        lines: [
          { type: 'context', text: 'keep' },
          { type: 'del', text: 'old' },
          { type: 'add', text: 'new' },
        ],
        callId: 'call_1',
        timestamp: expect.any(String),
      });
    });

    it('edit: falls back to oldString/newString when the metadata has no patch', () => {
      const [diff] = diffs(translate(completed('edit', { filePath: '/w/a.ts', oldString: 'a\nb', newString: 'c' })));
      expect(diff!.lines).toEqual([
        { type: 'del', text: 'a' },
        { type: 'del', text: 'b' },
        { type: 'add', text: 'c' },
      ]);
    });

    it('write: the written content is all additions', () => {
      const [diff] = diffs(translate(completed('write', { filePath: '/w/new.ts', content: 'one\ntwo' }, { filepath: '/w/new.ts', exists: false })));
      expect(diff).toMatchObject({ path: '/w/new.ts', lines: [{ type: 'add', text: 'one' }, { type: 'add', text: 'two' }] });
    });

    it('apply_patch: one card per touched file — patched, moved, deleted', () => {
      const found = diffs(translate(completed('apply_patch', { patchText: '…' }, {
        files: [
          { filePath: '/w/a.ts', relativePath: 'a.ts', type: 'update', patch: '@@ -1 +1 @@\n-x\n+y' },
          { filePath: '/w/old.ts', movePath: '/w/moved.ts', type: 'move', diff: '@@ -1 +1 @@\n-p\n+q' },
          { filePath: '/w/gone.ts', type: 'delete' },
        ],
      })));
      expect(found.map((e) => ({ path: e.path, lines: e.lines }))).toEqual([
        { path: '/w/a.ts', lines: [{ type: 'del', text: 'x' }, { type: 'add', text: 'y' }] },
        { path: '/w/moved.ts', lines: [{ type: 'del', text: 'p' }, { type: 'add', text: 'q' }] },
        { path: '/w/gone.ts', lines: [{ type: 'context', text: '(file deleted)' }] },
      ]);
    });

    it('other tools, and calls with nothing to show, produce no card', () => {
      expect(diffs(translate(completed('read', { filePath: '/w/a.ts' })))).toEqual([]);
      expect(diffs(translate(completed('write', { filePath: '/w/a.ts', content: '' })))).toEqual([]);
      expect(diffs(translate(completed('edit', { oldString: 'a', newString: 'b' })))).toEqual([]);
    });
  });

  describe('question messages', () => {
    it('emit nothing themselves, and hide the question tool\'s call', () => {
      const ctx = newTranslateContext();
      const msg: OpenCodeQuestion = {
        type: 'question',
        toolUseId: 'call_q',
      };
      expect(translate(msg, ctx)).toEqual([]);
      expect(ctx.hiddenCallIds.has('call_q')).toBe(true);
    });
  });

  it('returns empty array for an unrecognized envelope type', () => {
    expect(translate({ type: 'something-else' })).toEqual([]);
  });
});
