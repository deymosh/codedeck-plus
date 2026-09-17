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
} from '../sdk/opencodeAdapter';
import type { SdkMessage } from '../sdk/facade';
import type { Part } from '@opencode-ai/sdk';

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

  it('returns empty array for an unrecognized envelope type', () => {
    const msg = { type: 'something-else' };
    expect(opencodeMessageToEntries(asSdkMessage(msg))).toEqual([]);
  });
});
