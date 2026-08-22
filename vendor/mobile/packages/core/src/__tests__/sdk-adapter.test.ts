/**
 * sdkMessageToEntries — ported from the old bridge's sdkAdapter.test.ts
 * (imports adjusted to @codedeck/core's sdk/{facade,adapter} seam).
 */
import { describe, it, expect } from 'vitest';
import { extractDiff, sdkMessageToEntries } from '../sdk/adapter';
import type {
  SdkAssistantMessage,
  SdkUserMessage,
  SdkResultMessage,
  SdkSystemMessage,
} from '../sdk/facade';
import type { UUID } from 'node:crypto';

const SESSION_ID = '00ad78e2-a612-49a4-8533-8421f5e9306a' as UUID;
const MSG_UUID = '11ad78e2-a612-49a4-8533-8421f5e9306b' as UUID;

describe('sdkMessageToEntries', () => {
  describe('assistant messages', () => {
    it('converts text blocks', () => {
      const msg: SdkAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'msg_01',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-6',
          content: [{ type: 'text', text: 'Hello from Claude' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        } as any,
        parent_tool_use_id: null,
        uuid: MSG_UUID,
        session_id: SESSION_ID,
      };

      const entries = sdkMessageToEntries(msg);
      expect(entries.length).toBeGreaterThanOrEqual(1);

      const textEntry = entries.find(e => e.entryType === 'text');
      expect(textEntry).toBeDefined();
      expect(textEntry!.content).toBe('Hello from Claude');
      expect(textEntry!.metadata?.role).toBe('assistant');
    });

    it('converts tool_use blocks', () => {
      const msg: SdkAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'msg_01',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-6',
          content: [{
            type: 'tool_use',
            id: 'tool_01',
            name: 'Bash',
            input: { command: 'ls -la' },
          }],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        } as any,
        parent_tool_use_id: null,
        uuid: MSG_UUID,
        session_id: SESSION_ID,
      };

      const entries = sdkMessageToEntries(msg);
      const toolEntry = entries.find(e => e.entryType === 'tool_use');
      expect(toolEntry).toBeDefined();
      expect(toolEntry!.content).toBe('Bash: ls -la');
      expect(toolEntry!.metadata?.tool_name).toBe('Bash');
      expect(toolEntry!.metadata?.tool_use_id).toBe('tool_01');
    });

    it('converts ExitPlanMode to plan approval', () => {
      const msg: SdkAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'msg_01',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-6',
          content: [{
            type: 'tool_use',
            id: 'tool_plan',
            name: 'ExitPlanMode',
            input: { plan: '## Plan\n1. Fix the bug\n2. Add tests' },
          }],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        } as any,
        parent_tool_use_id: null,
        uuid: MSG_UUID,
        session_id: SESSION_ID,
      };

      const entries = sdkMessageToEntries(msg);

      const planText = entries.find(e => e.metadata?.special === 'plan');
      expect(planText).toBeDefined();
      expect(planText!.content).toContain('Fix the bug');

      const planApproval = entries.find(e => e.metadata?.special === 'plan_approval');
      expect(planApproval).toBeDefined();
      expect(planApproval!.metadata?.has_plan).toBe(true);
    });

    it('sets has_plan=false for plan-less ExitPlanMode', () => {
      const msg: SdkAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'msg_01',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-6',
          content: [{
            type: 'tool_use',
            id: 'tool_plan',
            name: 'ExitPlanMode',
            input: { plan: '' },
          }],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        } as any,
        parent_tool_use_id: null,
        uuid: MSG_UUID,
        session_id: SESSION_ID,
      };

      const entries = sdkMessageToEntries(msg);

      // No plan text entry should be emitted
      const planText = entries.find(e => e.metadata?.special === 'plan');
      expect(planText).toBeUndefined();

      const planApproval = entries.find(e => e.metadata?.special === 'plan_approval');
      expect(planApproval).toBeDefined();
      expect(planApproval!.metadata?.has_plan).toBe(false);
    });

    it('converts AskUserQuestion to question entries', () => {
      const msg: SdkAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'msg_01',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-6',
          content: [{
            type: 'tool_use',
            id: 'tool_q',
            name: 'AskUserQuestion',
            input: {
              questions: [
                { question: 'What should I do?', options: [{ label: 'Option A' }, { label: 'Option B' }] },
              ],
            },
          }],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        } as any,
        parent_tool_use_id: null,
        uuid: MSG_UUID,
        session_id: SESSION_ID,
      };

      const entries = sdkMessageToEntries(msg);
      const questionEntry = entries.find(e => e.metadata?.special === 'ask_question');
      expect(questionEntry).toBeDefined();
      expect(questionEntry!.content).toBe('What should I do?');
      expect(questionEntry!.metadata?.options).toHaveLength(2);
    });

    it('includes token usage', () => {
      const msg: SdkAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'msg_01',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-6',
          content: [{ type: 'text', text: 'Done' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        } as any,
        parent_tool_use_id: null,
        uuid: MSG_UUID,
        session_id: SESSION_ID,
      };

      const entries = sdkMessageToEntries(msg);
      const usageEntry = entries.find(e => e.metadata?.usage);
      expect(usageEntry).toBeDefined();
      expect(usageEntry!.content).toContain('500');
      expect(usageEntry!.content).toContain('200');
    });

    it('sets display_hint collapse when tool_use blocks are present', () => {
      const msg: SdkAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'msg_01',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-6',
          content: [
            { type: 'text', text: 'Let me explore the codebase.' },
            { type: 'tool_use', id: 'tool_agent', name: 'Agent', input: { description: 'Explore', prompt: 'Search for files...' } },
          ],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        } as any,
        parent_tool_use_id: null,
        uuid: MSG_UUID,
        session_id: SESSION_ID,
      };

      const entries = sdkMessageToEntries(msg);
      const textEntry = entries.find(e => e.entryType === 'text');
      expect(textEntry).toBeDefined();
      expect(textEntry!.metadata?.display_hint).toBe('collapse');
    });

    it('tags entries with subagent when parent_tool_use_id is set', () => {
      const msg: SdkAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'msg_01',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-6',
          content: [
            { type: 'text', text: 'Searching for files...' },
            { type: 'tool_use', id: 'tool_read', name: 'Read', input: { file_path: '/src/main.ts' } },
          ],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        } as any,
        parent_tool_use_id: 'parent_agent_tool',
        uuid: MSG_UUID,
        session_id: SESSION_ID,
      };

      const entries = sdkMessageToEntries(msg);
      const textEntry = entries.find(e => e.entryType === 'text');
      expect(textEntry!.metadata?.subagent).toBe(true);
      expect(textEntry!.metadata?.display_hint).toBe('collapse');

      const toolEntry = entries.find(e => e.entryType === 'tool_use');
      expect(toolEntry!.metadata?.subagent).toBe(true);
    });

    it('sets display_hint show when no tool_use blocks are present', () => {
      const msg: SdkAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'msg_01',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-6',
          content: [
            { type: 'text', text: 'Here is the answer to your question.' },
          ],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        } as any,
        parent_tool_use_id: null,
        uuid: MSG_UUID,
        session_id: SESSION_ID,
      };

      const entries = sdkMessageToEntries(msg);
      const textEntry = entries.find(e => e.entryType === 'text');
      expect(textEntry!.metadata?.display_hint).toBe('show');
      expect(textEntry!.metadata?.subagent).toBeUndefined();
    });
  });

  describe('user messages', () => {
    it('converts string content', () => {
      const msg = {
        type: 'user',
        message: { role: 'user', content: 'Fix the bug' },
        parent_tool_use_id: null,
      } as SdkUserMessage;

      const entries = sdkMessageToEntries(msg);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.entryType).toBe('text');
      expect(entries[0]!.content).toBe('Fix the bug');
      expect(entries[0]!.metadata?.role).toBe('user');
    });

    it('converts array content with tool_result', () => {
      const msg = {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool_01', content: 'file1.ts\nfile2.ts' },
          ],
        },
        parent_tool_use_id: null,
      } as SdkUserMessage;

      const entries = sdkMessageToEntries(msg);
      const toolResult = entries.find(e => e.entryType === 'tool_result');
      expect(toolResult).toBeDefined();
      expect(toolResult!.content).toBe('file1.ts\nfile2.ts');
      expect(toolResult!.metadata?.tool_use_id).toBe('tool_01');
    });

    it('truncates long tool results', () => {
      const longContent = 'x'.repeat(3000);
      const msg = {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool_01', content: longContent },
          ],
        },
        parent_tool_use_id: null,
      } as SdkUserMessage;

      const entries = sdkMessageToEntries(msg);
      expect(entries[0]!.content.length).toBeLessThan(2100);
      expect(entries[0]!.content).toContain('...[truncated]');
    });

    it('tags subagent prompts with collapse hint instead of user role', () => {
      const msg = {
        type: 'user',
        message: { role: 'user', content: 'Search the codebase for...' },
        parent_tool_use_id: 'tool_abc123',
      } as SdkUserMessage;

      const entries = sdkMessageToEntries(msg);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.metadata?.role).toBe('assistant');
      expect(entries[0]!.metadata?.subagent).toBe(true);
      expect(entries[0]!.metadata?.display_hint).toBe('collapse');
    });

    it('tags subagent array content with collapse hint', () => {
      const msg = {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Explore the src/ directory' },
          ],
        },
        parent_tool_use_id: 'tool_abc456',
      } as SdkUserMessage;

      const entries = sdkMessageToEntries(msg);
      const textEntry = entries.find(e => e.entryType === 'text');
      expect(textEntry).toBeDefined();
      expect(textEntry!.metadata?.role).toBe('assistant');
      expect(textEntry!.metadata?.subagent).toBe(true);
      expect(textEntry!.metadata?.display_hint).toBe('collapse');
    });
  });

  describe('result messages', () => {
    it('converts success result', () => {
      const msg = {
        type: 'result' as const,
        subtype: 'success' as const,
        duration_ms: 5000,
        duration_api_ms: 4000,
        is_error: false,
        num_turns: 3,
        result: 'Done',
        stop_reason: 'end_turn',
        total_cost_usd: 0.0123,
        usage: { input_tokens: 1000, output_tokens: 500 },
        modelUsage: {},
        permission_denials: [],
        uuid: MSG_UUID,
        session_id: SESSION_ID,
      } as unknown as SdkResultMessage;

      const entries = sdkMessageToEntries(msg);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.entryType).toBe('system');
      expect(entries[0]!.content).toContain('3 turns');
      expect(entries[0]!.content).toContain('$0.0123');
    });

    it('converts error result', () => {
      const msg = {
        type: 'result' as const,
        subtype: 'error_during_execution' as const,
        duration_ms: 1000,
        duration_api_ms: 800,
        is_error: true,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0.001,
        usage: { input_tokens: 100, output_tokens: 10 },
        modelUsage: {},
        permission_denials: [],
        errors: ['Something went wrong'],
        uuid: MSG_UUID,
        session_id: SESSION_ID,
      } as unknown as SdkResultMessage;

      const entries = sdkMessageToEntries(msg);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.entryType).toBe('error');
      expect(entries[0]!.content).toContain('Something went wrong');
    });
  });

  describe('system messages', () => {
    it('converts init message', () => {
      const msg = {
        type: 'system' as const,
        subtype: 'init' as const,
        claude_code_version: '1.2.3',
        model: 'claude-opus-4-6',
        tools: ['Bash', 'Read', 'Edit'],
        mcp_servers: [],
        permissionMode: 'plan' as const,
        apiKeySource: 'oauth' as const,
        cwd: '/workspace',
        slash_commands: [],
        output_style: 'default',
        skills: [],
        plugins: [],
        uuid: MSG_UUID,
        session_id: SESSION_ID,
      } as unknown as SdkSystemMessage;

      const entries = sdkMessageToEntries(msg);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.entryType).toBe('system');
      expect(entries[0]!.content).toContain('1.2.3');
      expect(entries[0]!.metadata?.model).toBe('claude-opus-4-6');
    });

    it('converts session_state_changed idle to stream_end', () => {
      const msg = {
        type: 'system' as const,
        subtype: 'session_state_changed' as const,
        state: 'idle' as const,
        uuid: MSG_UUID,
        session_id: SESSION_ID,
      };
      const entries = sdkMessageToEntries(msg as any);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.entryType).toBe('system');
      expect(entries[0]!.metadata?.stream_end).toBe(true);
    });

    it('ignores session_state_changed running', () => {
      const msg = {
        type: 'system' as const,
        subtype: 'session_state_changed' as const,
        state: 'running' as const,
        uuid: MSG_UUID,
        session_id: SESSION_ID,
      };
      const entries = sdkMessageToEntries(msg as any);
      expect(entries).toHaveLength(0);
    });
  });

  describe('ignored message types', () => {
    it('returns empty for stream_event messages', () => {
      const msg = { type: 'stream_event' as const, event: {}, parent_tool_use_id: null, uuid: MSG_UUID, session_id: SESSION_ID };
      expect(sdkMessageToEntries(msg as any)).toEqual([]);
    });
  });

  describe('tool input formatting', () => {
    it('formats Read tool', () => {
      const msg: SdkAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'msg_01', type: 'message', role: 'assistant', model: 'claude-opus-4-6',
          content: [{ type: 'tool_use', id: 'tool_01', name: 'Read', input: { file_path: '/src/main.ts' } }],
          stop_reason: 'tool_use', stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        } as any,
        parent_tool_use_id: null, uuid: MSG_UUID, session_id: SESSION_ID,
      };

      const entries = sdkMessageToEntries(msg);
      const toolEntry = entries.find(e => e.entryType === 'tool_use');
      expect(toolEntry!.content).toBe('Read: /src/main.ts');
    });

    it('formats Grep tool', () => {
      const msg: SdkAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'msg_01', type: 'message', role: 'assistant', model: 'claude-opus-4-6',
          content: [{ type: 'tool_use', id: 'tool_01', name: 'Grep', input: { pattern: 'TODO' } }],
          stop_reason: 'tool_use', stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        } as any,
        parent_tool_use_id: null, uuid: MSG_UUID, session_id: SESSION_ID,
      };

      const entries = sdkMessageToEntries(msg);
      const toolEntry = entries.find(e => e.entryType === 'tool_use');
      expect(toolEntry!.content).toBe('Grep: TODO');
    });
  });
});

describe('thinking blocks (CDX-005 remainder — previously dropped)', () => {
  function assistantWith(content: unknown[]): SdkAssistantMessage {
    return {
      type: 'assistant',
      message: {
        id: 'msg_th',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-6',
        content,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: null,
      } as any,
      parent_tool_use_id: null,
      uuid: MSG_UUID,
      session_id: SESSION_ID,
    } as SdkAssistantMessage;
  }

  it('emits a thinking entry with the thinking text', () => {
    const entries = sdkMessageToEntries(assistantWith([
      { type: 'thinking', thinking: 'Let me reason about this…', signature: 'sig' },
      { type: 'text', text: 'Here is the answer.' },
    ]));
    const thinking = entries.find((e) => e.entryType === 'thinking');
    expect(thinking).toBeDefined();
    expect(thinking!.content).toBe('Let me reason about this…');
    expect(thinking!.metadata?.role).toBe('assistant');
    expect(thinking!.metadata?.redacted).toBeUndefined();
    // The visible text still comes through as its own entry.
    expect(entries.find((e) => e.entryType === 'text')?.content).toBe('Here is the answer.');
  });

  it('marks redacted_thinking with metadata.redacted and empty content', () => {
    const entries = sdkMessageToEntries(assistantWith([
      { type: 'redacted_thinking', data: 'opaque' },
    ]));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entryType).toBe('thinking');
    expect(entries[0]!.content).toBe('');
    expect(entries[0]!.metadata?.redacted).toBe(true);
  });

  it('flags sub-agent thinking like other sub-agent output', () => {
    const msg = assistantWith([{ type: 'thinking', thinking: 'inner monologue', signature: 's' }]);
    (msg as { parent_tool_use_id: string | null }).parent_tool_use_id = 'tool_parent';
    const entries = sdkMessageToEntries(msg);
    expect(entries[0]!.entryType).toBe('thinking');
    expect(entries[0]!.metadata?.subagent).toBe(true);
  });

  it('thinking does not force text into collapse (display_hint stays "show" without tools)', () => {
    const entries = sdkMessageToEntries(assistantWith([
      { type: 'thinking', thinking: 'hm', signature: 's' },
      { type: 'text', text: 'standalone answer' },
    ]));
    const text = entries.find((e) => e.entryType === 'text');
    expect(text!.metadata?.display_hint).toBe('show');
  });
});

describe('diff entries (CDX-050)', () => {
  function assistantToolUse(name: string, input: Record<string, unknown>): SdkAssistantMessage {
    return {
      type: 'assistant',
      message: {
        id: 'msg_diff',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-6',
        content: [{ type: 'tool_use', id: 'tool_d1', name, input }],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: null,
      } as any,
      parent_tool_use_id: null,
      uuid: MSG_UUID,
      session_id: SESSION_ID,
    } as SdkAssistantMessage;
  }

  it('emits a diff entry AFTER the tool_use for an Edit (tool group keeps its action)', () => {
    const entries = sdkMessageToEntries(
      assistantToolUse('Edit', {
        file_path: '/repo/src/app.ts',
        old_string: 'const a = 1;\nconst b = 2;',
        new_string: 'const a = 2;',
      }),
      { emitDiffEntries: true },
    );
    const kinds = entries.map((e) => e.entryType);
    expect(kinds).toEqual(['tool_use', 'diff']);

    const diff = entries[1]!;
    expect(diff.diff?.path).toBe('/repo/src/app.ts');
    expect(diff.diff?.lines).toEqual([
      { type: 'del', text: 'const a = 1;' },
      { type: 'del', text: 'const b = 2;' },
      { type: 'add', text: 'const a = 2;' },
    ]);
    expect(diff.diff?.truncated).toBeUndefined();
    // Plain-text fallback mirrors the same lines with +/− prefixes.
    expect(diff.content).toBe('-const a = 1;\n-const b = 2;\n+const a = 2;');
    // Correlated to its tool_use so grouping/answered detection still works.
    expect(diff.metadata?.tool_use_id).toBe('tool_d1');
    expect(diff.metadata?.tool_name).toBe('Edit');
  });

  it('Write emits an all-add diff', () => {
    const entries = sdkMessageToEntries(
      assistantToolUse('Write', { file_path: 'notes.md', content: 'line one\nline two' }),
      { emitDiffEntries: true },
    );
    const diff = entries.find((e) => e.entryType === 'diff');
    expect(diff?.diff?.path).toBe('notes.md');
    expect(diff?.diff?.lines).toEqual([
      { type: 'add', text: 'line one' },
      { type: 'add', text: 'line two' },
    ]);
  });

  it('MultiEdit concatenates hunks with a context separator', () => {
    const entries = sdkMessageToEntries(
      assistantToolUse('MultiEdit', {
        file_path: 'x.ts',
        edits: [
          { old_string: 'foo', new_string: 'bar' },
          { old_string: 'baz', new_string: 'qux' },
        ],
      }),
      { emitDiffEntries: true },
    );
    const diff = entries.find((e) => e.entryType === 'diff');
    expect(diff?.diff?.lines).toEqual([
      { type: 'del', text: 'foo' },
      { type: 'add', text: 'bar' },
      { type: 'context', text: '⋯' },
      { type: 'del', text: 'baz' },
      { type: 'add', text: 'qux' },
    ]);
  });

  it('emission is OFF by default (old phones reject the unknown entryType)', () => {
    const entries = sdkMessageToEntries(
      assistantToolUse('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }),
    );
    expect(entries.map((e) => e.entryType)).toEqual(['tool_use']);
  });

  it('non-edit tools are unaffected even with emission on', () => {
    const entries = sdkMessageToEntries(
      assistantToolUse('Bash', { command: 'ls -la' }),
      { emitDiffEntries: true },
    );
    expect(entries.map((e) => e.entryType)).toEqual(['tool_use']);
  });

  it('skips unusable input (no file_path / empty strings)', () => {
    expect(extractDiff('Edit', { old_string: 'x', new_string: 'y' })).toBeNull();
    expect(extractDiff('Edit', { file_path: 'a.ts', old_string: '', new_string: '' })).toBeNull();
    expect(extractDiff('Write', { file_path: 'a.ts', content: '' })).toBeNull();
    expect(extractDiff('MultiEdit', { file_path: 'a.ts', edits: [] })).toBeNull();
  });

  it('caps huge edits at 200 lines and flags truncation', () => {
    const big = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
    const diff = extractDiff('Write', { file_path: 'big.txt', content: big });
    expect(diff?.lines).toHaveLength(200);
    expect(diff?.truncated).toBe(true);
  });
});
