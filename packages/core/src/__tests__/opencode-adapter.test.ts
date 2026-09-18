/**
 * opencodeMessageToEntries — mirrors sdk-adapter.test.ts's style for the
 * OpenCode-backend translator.
 */
import { describe, it, expect } from 'vitest';
import { opencodeMessageToEntries } from '../sdk/opencodeAdapter';
import type {
  OpenCodeInitMessage,
  OpenCodeStateMessage,
  OpenCodePartMessage,
  OpenCodeErrorMessage,
  OpenCodeResumeLostMessage,
  OpenCodeDiffMessage,
} from '../sdk/opencodeAdapter';
import type { SdkMessage } from '../sdk/facade';
import type { FileDiff, Part } from '@opencode-ai/sdk';

function asSdkMessage(msg: unknown): SdkMessage {
  return msg as SdkMessage;
}

describe('opencodeMessageToEntries', () => {
  describe('system messages', () => {
    it('converts init into a system entry carrying model + permissionMode', () => {
      const msg: OpenCodeInitMessage = {
        type: 'system',
        subtype: 'init',
        session_id: 'ses_abc',
        model: 'anthropic/claude-sonnet-4-6',
        permissionMode: 'default',
      };

      const entries = opencodeMessageToEntries(asSdkMessage(msg));
      expect(entries).toHaveLength(1);
      expect(entries[0]!.entryType).toBe('system');
      expect(entries[0]!.content).toContain('anthropic/claude-sonnet-4-6');
      expect(entries[0]!.metadata?.subtype).toBe('init');
      expect(entries[0]!.metadata?.model).toBe('anthropic/claude-sonnet-4-6');
      expect(entries[0]!.metadata?.permissionMode).toBe('default');
    });

    it('converts init with no model/permissionMode without throwing', () => {
      const msg: OpenCodeInitMessage = {
        type: 'system',
        subtype: 'init',
        session_id: 'ses_abc',
      };
      const entries = opencodeMessageToEntries(asSdkMessage(msg));
      expect(entries).toHaveLength(1);
      expect(entries[0]!.metadata?.model).toBeUndefined();
    });

    it('converts idle state into a stream_end marker', () => {
      const msg: OpenCodeStateMessage = {
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
      };
      const entries = opencodeMessageToEntries(asSdkMessage(msg));
      expect(entries).toHaveLength(1);
      expect(entries[0]!.metadata?.stream_end).toBe(true);
    });

    it('drops running state (nothing to relay)', () => {
      const msg: OpenCodeStateMessage = {
        type: 'system',
        subtype: 'session_state_changed',
        state: 'running',
      };
      expect(opencodeMessageToEntries(asSdkMessage(msg))).toEqual([]);
    });
  });

  describe('part messages', () => {
    it('converts a text part', () => {
      const part = { type: 'text', id: 'p1', sessionID: 's1', messageID: 'm1', text: 'Hello from OpenCode' } as Part;
      const msg: OpenCodePartMessage = { type: 'opencode-part', part, role: 'assistant' };

      const entries = opencodeMessageToEntries(asSdkMessage(msg));
      expect(entries).toHaveLength(1);
      expect(entries[0]!.entryType).toBe('text');
      expect(entries[0]!.content).toBe('Hello from OpenCode');
      expect(entries[0]!.metadata?.role).toBe('assistant');
    });

    it('drops an empty text part', () => {
      const part = { type: 'text', id: 'p1', sessionID: 's1', messageID: 'm1', text: '' } as Part;
      const msg: OpenCodePartMessage = { type: 'opencode-part', part, role: 'assistant' };
      expect(opencodeMessageToEntries(asSdkMessage(msg))).toEqual([]);
    });

    it('converts a reasoning part into a thinking entry', () => {
      const part = {
        type: 'reasoning',
        id: 'p2',
        sessionID: 's1',
        messageID: 'm1',
        text: 'thinking it through',
        time: { start: 0 },
      } as Part;
      const msg: OpenCodePartMessage = { type: 'opencode-part', part, role: 'assistant' };

      const entries = opencodeMessageToEntries(asSdkMessage(msg));
      expect(entries).toHaveLength(1);
      expect(entries[0]!.entryType).toBe('thinking');
      expect(entries[0]!.content).toBe('thinking it through');
    });

    it('converts a user text part with role user', () => {
      const part = { type: 'text', id: 'p3', sessionID: 's1', messageID: 'm2', text: 'do the thing' } as Part;
      const msg: OpenCodePartMessage = { type: 'opencode-part', part, role: 'user' };

      const entries = opencodeMessageToEntries(asSdkMessage(msg));
      expect(entries[0]!.metadata?.role).toBe('user');
    });

    it('skips a pending tool part', () => {
      const part = {
        type: 'tool',
        id: 'p4',
        sessionID: 's1',
        messageID: 'm1',
        callID: 'call_1',
        tool: 'bash',
        state: { status: 'pending', input: {}, raw: '' },
      } as Part;
      const msg: OpenCodePartMessage = { type: 'opencode-part', part, role: 'assistant' };
      expect(opencodeMessageToEntries(asSdkMessage(msg))).toEqual([]);
    });

    it('converts a running tool part into a tool_use entry', () => {
      const part = {
        type: 'tool',
        id: 'p4',
        sessionID: 's1',
        messageID: 'm1',
        callID: 'call_1',
        tool: 'bash',
        state: { status: 'running', input: { command: 'ls -la' }, time: { start: 0 } },
      } as Part;
      const msg: OpenCodePartMessage = { type: 'opencode-part', part, role: 'assistant' };

      const entries = opencodeMessageToEntries(asSdkMessage(msg));
      expect(entries).toHaveLength(1);
      expect(entries[0]!.entryType).toBe('tool_use');
      expect(entries[0]!.content).toBe('bash: {"command":"ls -la"}');
      expect(entries[0]!.metadata?.tool_name).toBe('bash');
      expect(entries[0]!.metadata?.tool_use_id).toBe('call_1');
    });

    it('converts a completed tool part into a tool_result entry', () => {
      const part = {
        type: 'tool',
        id: 'p4',
        sessionID: 's1',
        messageID: 'm1',
        callID: 'call_1',
        tool: 'bash',
        state: {
          status: 'completed',
          input: { command: 'ls -la' },
          output: 'file1.txt\nfile2.txt',
          title: 'bash',
          metadata: {},
          time: { start: 0, end: 1 },
        },
      } as Part;
      const msg: OpenCodePartMessage = { type: 'opencode-part', part, role: 'assistant' };

      const entries = opencodeMessageToEntries(asSdkMessage(msg));
      expect(entries).toHaveLength(1);
      expect(entries[0]!.entryType).toBe('tool_result');
      expect(entries[0]!.content).toBe('file1.txt\nfile2.txt');
      expect(entries[0]!.metadata?.tool_use_id).toBe('call_1');
    });

    it('truncates a long completed tool output', () => {
      const longOutput = 'x'.repeat(3000);
      const part = {
        type: 'tool',
        id: 'p4',
        sessionID: 's1',
        messageID: 'm1',
        callID: 'call_1',
        tool: 'bash',
        state: {
          status: 'completed',
          input: {},
          output: longOutput,
          title: 'bash',
          metadata: {},
          time: { start: 0, end: 1 },
        },
      } as Part;
      const msg: OpenCodePartMessage = { type: 'opencode-part', part, role: 'assistant' };

      const entries = opencodeMessageToEntries(asSdkMessage(msg));
      expect(entries[0]!.content.length).toBeLessThan(longOutput.length);
      expect(entries[0]!.content).toContain('[truncated]');
    });

    it('converts an errored tool part into a tool_result entry marked error', () => {
      const part = {
        type: 'tool',
        id: 'p4',
        sessionID: 's1',
        messageID: 'm1',
        callID: 'call_1',
        tool: 'bash',
        state: {
          status: 'error',
          input: {},
          error: 'command not found',
          time: { start: 0, end: 1 },
        },
      } as Part;
      const msg: OpenCodePartMessage = { type: 'opencode-part', part, role: 'assistant' };

      const entries = opencodeMessageToEntries(asSdkMessage(msg));
      expect(entries).toHaveLength(1);
      expect(entries[0]!.entryType).toBe('tool_result');
      expect(entries[0]!.content).toBe('command not found');
      expect(entries[0]!.metadata?.error).toBe(true);
    });

    it('drops an unhandled part kind (e.g. file)', () => {
      const part = { type: 'file', id: 'p5', sessionID: 's1', messageID: 'm1', mime: 'text/plain', url: 'file:///x' } as Part;
      const msg: OpenCodePartMessage = { type: 'opencode-part', part, role: 'assistant' };
      expect(opencodeMessageToEntries(asSdkMessage(msg))).toEqual([]);
    });
  });

  describe('error messages', () => {
    it('converts a provider/session error into an error entry', () => {
      const msg: OpenCodeErrorMessage = { type: 'opencode-error', content: 'provider auth failed' };
      const entries = opencodeMessageToEntries(asSdkMessage(msg));
      expect(entries).toHaveLength(1);
      expect(entries[0]!.entryType).toBe('error');
      expect(entries[0]!.content).toBe('provider auth failed');
    });
  });

  describe('resume-lost messages', () => {
    it('converts a lost resume target into a visible system entry, same special marker as a Claude Code restart', () => {
      const msg: OpenCodeResumeLostMessage = { type: 'opencode-resume-lost' };
      const entries = opencodeMessageToEntries(asSdkMessage(msg));
      expect(entries).toHaveLength(1);
      expect(entries[0]!.entryType).toBe('system');
      expect(entries[0]!.content).toMatch(/does not remember earlier turns/);
      expect(entries[0]!.metadata?.special).toBe('session_restart');
    });
  });

  describe('diff messages', () => {
    function fileDiff(over: Partial<FileDiff> = {}): FileDiff {
      return { file: 'src/a.ts', before: 'line1\nline2\nline3', after: 'line1\nCHANGED\nline3', additions: 1, deletions: 1, ...over };
    }

    it('is gated on opts.emitDiffEntries — no entries without it', () => {
      const msg: OpenCodeDiffMessage = { type: 'opencode-diff', files: [fileDiff()] };
      expect(opencodeMessageToEntries(asSdkMessage(msg))).toEqual([]);
      expect(opencodeMessageToEntries(asSdkMessage(msg), { emitDiffEntries: false })).toEqual([]);
    });

    it('renders one diff entry per file, with real add/del/context lines (not a flat before/after dump)', () => {
      const msg: OpenCodeDiffMessage = { type: 'opencode-diff', files: [fileDiff()] };
      const entries = opencodeMessageToEntries(asSdkMessage(msg), { emitDiffEntries: true });
      expect(entries).toHaveLength(1);
      expect(entries[0]!.entryType).toBe('diff');
      expect(entries[0]!.diff?.path).toBe('src/a.ts');
      const lines = entries[0]!.diff?.lines ?? [];
      expect(lines).toEqual([
        { type: 'context', text: 'line1' },
        { type: 'del', text: 'line2' },
        { type: 'add', text: 'CHANGED' },
        { type: 'context', text: 'line3' },
      ]);
      expect(entries[0]!.content).toBe(' line1\n-line2\n+CHANGED\n line3');
    });

    it('emits one entry per file for a multi-file diff event', () => {
      const msg: OpenCodeDiffMessage = {
        type: 'opencode-diff',
        files: [fileDiff({ file: 'a.ts' }), fileDiff({ file: 'b.ts' })],
      };
      const entries = opencodeMessageToEntries(asSdkMessage(msg), { emitDiffEntries: true });
      expect(entries.map((e) => e.diff?.path)).toEqual(['a.ts', 'b.ts']);
    });

    it('falls back to a flat del/add rendering (no LCS) for a file above the line-count guard', () => {
      const bigBefore = Array.from({ length: 2001 }, (_, i) => `l${i}`).join('\n');
      const bigAfter = Array.from({ length: 2001 }, (_, i) => `l${i}x`).join('\n');
      const msg: OpenCodeDiffMessage = {
        type: 'opencode-diff',
        files: [fileDiff({ file: 'huge.ts', before: bigBefore, after: bigAfter })],
      };
      const entries = opencodeMessageToEntries(asSdkMessage(msg), { emitDiffEntries: true });
      const lines = entries[0]!.diff?.lines ?? [];
      // Flat fallback: no LCS ran, so no 'context' lines at all — and since the
      // 'del' block (2001 lines) alone exceeds the MAX_DIFF_LINES=200 wire cap,
      // the truncated output is entirely 'del'.
      expect(lines.length).toBe(200);
      expect(lines.every((l) => l.type === 'del')).toBe(true);
      expect(entries[0]!.diff?.truncated).toBe(true);
    });
  });

  it('returns empty array for an unrecognized envelope type', () => {
    const msg = { type: 'something-else' };
    expect(opencodeMessageToEntries(asSdkMessage(msg))).toEqual([]);
  });
});
