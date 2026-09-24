/**
 * sdkMessageToEntries — Claude Agent SDK messages to protocol v11 typed
 * entries (ported from the old bridge's sdkAdapter.test.ts).
 */
import { describe, it, expect } from 'vitest';
import type { EntryOf, EntryType, OutputEntry } from '@codedeck/protocol';
import { extractDiff, newTranslateContext, sdkMessageToEntries, type TranslateContext } from '../sdk/adapter';
import type {
  SdkAssistantMessage,
  SdkMessage,
  SdkUserMessage,
  SdkResultMessage,
  SdkSystemMessage,
} from '../sdk/facade';
import type { UUID } from 'node:crypto';

const SESSION_ID = '00ad78e2-a612-49a4-8533-8421f5e9306a' as UUID;
const MSG_UUID = '11ad78e2-a612-49a4-8533-8421f5e9306b' as UUID;

function translate(msg: SdkMessage, ctx: TranslateContext = newTranslateContext()): OutputEntry[] {
  return sdkMessageToEntries(msg, ctx);
}

function find<T extends EntryType>(entries: OutputEntry[], type: T): EntryOf<T> | undefined {
  return entries.find((e): e is EntryOf<T> => e.entryType === type);
}

function assistant(content: unknown[], parentToolUseId: string | null = null): SdkAssistantMessage {
  return {
    type: 'assistant',
    message: {
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-6',
      content,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    } as any,
    parent_tool_use_id: parentToolUseId,
    uuid: MSG_UUID,
    session_id: SESSION_ID,
  } as SdkAssistantMessage;
}

function user(content: unknown, parentToolUseId: string | null = null): SdkUserMessage {
  return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: parentToolUseId } as SdkUserMessage;
}

describe('sdkMessageToEntries', () => {
  describe('assistant messages', () => {
    it('converts text blocks into standalone agent text', () => {
      const entries = translate(assistant([{ type: 'text', text: 'Hello from Claude' }]));
      expect(entries).toEqual([
        { entryType: 'text', role: 'agent', text: 'Hello from Claude', timestamp: expect.any(String) },
      ]);
    });

    it('converts tool_use blocks into typed tool calls', () => {
      const entries = translate(assistant([
        { type: 'tool_use', id: 'tool_01', name: 'Bash', input: { command: 'ls -la' } },
      ]));
      expect(find(entries, 'tool_call')).toEqual({
        entryType: 'tool_call',
        callId: 'tool_01',
        toolName: 'Bash',
        kind: 'execute',
        title: 'ls -la',
        rawInput: { command: 'ls -la' },
        timestamp: expect.any(String),
      });
    });

    it('names the files a tool call touches', () => {
      const entries = translate(assistant([
        { type: 'tool_use', id: 'tool_01', name: 'Read', input: { file_path: '/src/main.ts' } },
      ]));
      expect(find(entries, 'tool_call')).toMatchObject({ kind: 'read', title: '/src/main.ts', locations: ['/src/main.ts'] });
    });

    it('titles search tools by their pattern', () => {
      const entries = translate(assistant([
        { type: 'tool_use', id: 'tool_01', name: 'Grep', input: { pattern: 'TODO' } },
      ]));
      expect(find(entries, 'tool_call')).toMatchObject({ kind: 'search', title: 'TODO' });
    });

    it('turns ExitPlanMode into a plan entry and hides the call', () => {
      const ctx = newTranslateContext();
      const entries = translate(assistant([
        { type: 'tool_use', id: 'tool_plan', name: 'ExitPlanMode', input: { plan: '## Plan\n1. Fix the bug\n2. Add tests' } },
      ]), ctx);
      expect(entries.map((e) => e.entryType)).toEqual(['plan']);
      expect(find(entries, 'plan')!.text).toContain('Fix the bug');
      // The approval card itself comes from the permission broker; the call's
      // result is hidden so it never renders as a stray tool action.
      expect(ctx.hiddenCallIds.has('tool_plan')).toBe(true);
      expect(translate(user([{ type: 'tool_result', tool_use_id: 'tool_plan', content: 'approved' }]), ctx)).toEqual([]);
    });

    it('emits no plan entry for a plan-less ExitPlanMode', () => {
      const entries = translate(assistant([
        { type: 'tool_use', id: 'tool_plan', name: 'ExitPlanMode', input: { plan: '' } },
      ]));
      expect(entries).toEqual([]);
    });

    it('hides AskUserQuestion — the broker publishes the question card', () => {
      const ctx = newTranslateContext();
      const entries = translate(assistant([{
        type: 'tool_use',
        id: 'tool_q',
        name: 'AskUserQuestion',
        input: { questions: [{ question: 'What should I do?', options: [{ label: 'Option A' }, { label: 'Option B' }] }] },
      }]), ctx);
      expect(entries).toEqual([]);
      expect(ctx.hiddenCallIds.has('tool_q')).toBe(true);
    });

    it('text written alongside tool calls is collapsible', () => {
      const entries = translate(assistant([
        { type: 'text', text: 'Let me explore the codebase.' },
        { type: 'tool_use', id: 'tool_agent', name: 'Agent', input: { description: 'Explore', prompt: 'Search for files...' } },
      ]));
      expect(find(entries, 'text')).toMatchObject({ role: 'agent', collapsible: true });
      expect(find(entries, 'tool_call')).toMatchObject({ kind: 'other', title: 'Explore' });
    });

    it('marks sub-agent output with a subagent envelope field', () => {
      const entries = translate(assistant([
        { type: 'text', text: 'Searching for files...' },
        { type: 'tool_use', id: 'tool_read', name: 'Read', input: { file_path: '/src/main.ts' } },
      ], 'parent_agent_tool'));
      expect(find(entries, 'text')).toMatchObject({ subagent: {}, collapsible: true });
      expect(find(entries, 'tool_call')).toMatchObject({ subagent: {} });
    });

    it('a text-only answer is not collapsible and not a sub-agent', () => {
      const text = find(translate(assistant([{ type: 'text', text: 'Here is the answer.' }])), 'text')!;
      expect(text.collapsible).toBeUndefined();
      expect(text.subagent).toBeUndefined();
    });
  });

  describe('user messages', () => {
    it('converts string content into user text', () => {
      expect(translate(user('Fix the bug'))).toEqual([
        { entryType: 'text', role: 'user', text: 'Fix the bug', timestamp: expect.any(String) },
      ]);
    });

    it('converts tool_result blocks, paired to their call id', () => {
      const entries = translate(user([
        { type: 'tool_result', tool_use_id: 'tool_01', content: 'file1.ts\nfile2.ts' },
        { type: 'tool_result', tool_use_id: 'tool_02', content: 'boom', is_error: true },
      ]));
      expect(entries).toEqual([
        { entryType: 'tool_result', callId: 'tool_01', text: 'file1.ts\nfile2.ts', timestamp: expect.any(String) },
        { entryType: 'tool_result', callId: 'tool_02', text: 'boom', isError: true, timestamp: expect.any(String) },
      ]);
    });

    it('truncates long tool results', () => {
      const result = find(translate(user([{ type: 'tool_result', tool_use_id: 'tool_01', content: 'x'.repeat(3000) }])), 'tool_result')!;
      expect(result.text.length).toBeLessThan(2100);
      expect(result.text).toContain('...[truncated]');
    });

    it('a sub-agent prompt folds into the tool group as agent text', () => {
      for (const content of ['Search the codebase for...', [{ type: 'text', text: 'Explore the src/ directory' }]]) {
        const entries = translate(user(content, 'tool_abc123'));
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ entryType: 'text', role: 'agent', collapsible: true, subagent: {} });
      }
    });
  });

  describe('result messages', () => {
    const base = {
      type: 'result' as const,
      duration_api_ms: 4000,
      usage: { input_tokens: 1000, output_tokens: 500 },
      modelUsage: {},
      permission_denials: [],
      uuid: MSG_UUID,
      session_id: SESSION_ID,
    };

    it('converts a success result into a status summary', () => {
      const entries = translate({
        ...base, subtype: 'success', duration_ms: 5000, is_error: false, num_turns: 3,
        result: 'Done', stop_reason: 'end_turn', total_cost_usd: 0.0123,
      } as unknown as SdkResultMessage);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ entryType: 'status' });
      expect(find(entries, 'status')!.text).toContain('3 turns');
      expect(find(entries, 'status')!.text).toContain('$0.0123');
    });

    it('drops the empty success results of a batched background-task completion', () => {
      expect(translate({
        ...base, subtype: 'success', duration_ms: 0, is_error: false, num_turns: 0,
        result: '', stop_reason: null, total_cost_usd: 0,
      } as unknown as SdkResultMessage)).toEqual([]);
    });

    it('converts an error result', () => {
      const entries = translate({
        ...base, subtype: 'error_during_execution', duration_ms: 1000, is_error: true, num_turns: 1,
        stop_reason: null, total_cost_usd: 0.001, errors: ['Something went wrong'],
      } as unknown as SdkResultMessage);
      expect(entries).toHaveLength(1);
      expect(find(entries, 'error')!.text).toContain('Something went wrong');
    });
  });

  describe('system messages', () => {
    it('converts the init message into a status line', () => {
      const entries = translate({
        type: 'system', subtype: 'init', claude_code_version: '1.2.3', model: 'claude-opus-4-6',
        tools: ['Bash'], mcp_servers: [], permissionMode: 'plan', apiKeySource: 'oauth', cwd: '/workspace',
        slash_commands: [], output_style: 'default', skills: [], plugins: [], uuid: MSG_UUID, session_id: SESSION_ID,
      } as unknown as SdkSystemMessage);
      expect(entries).toHaveLength(1);
      expect(find(entries, 'status')!.text).toBe('Claude Code 1.2.3 (claude-opus-4-6)');
    });

    it('converts session_state_changed idle into turn_complete', () => {
      const entries = translate({
        type: 'system', subtype: 'session_state_changed', state: 'idle', uuid: MSG_UUID, session_id: SESSION_ID,
      } as unknown as SdkMessage);
      expect(entries).toEqual([{ entryType: 'turn_complete', timestamp: expect.any(String) }]);
    });

    it('ignores session_state_changed running', () => {
      expect(translate({
        type: 'system', subtype: 'session_state_changed', state: 'running', uuid: MSG_UUID, session_id: SESSION_ID,
      } as unknown as SdkMessage)).toHaveLength(0);
    });
  });

  describe('ignored message types', () => {
    it('returns empty for stream_event messages', () => {
      const msg = { type: 'stream_event', event: {}, parent_tool_use_id: null, uuid: MSG_UUID, session_id: SESSION_ID };
      expect(translate(msg as unknown as SdkMessage)).toEqual([]);
    });
  });
});

describe('thinking blocks', () => {
  it('emits a thinking entry with the thinking text', () => {
    const entries = translate(assistant([
      { type: 'thinking', thinking: 'Let me reason about this…', signature: 'sig' },
      { type: 'text', text: 'Here is the answer.' },
    ]));
    const thinking = find(entries, 'thinking')!;
    expect(thinking.text).toBe('Let me reason about this…');
    expect(thinking.redacted).toBeUndefined();
    // The visible text still comes through as its own entry, not collapsed.
    expect(find(entries, 'text')).toMatchObject({ text: 'Here is the answer.' });
    expect(find(entries, 'text')!.collapsible).toBeUndefined();
  });

  it('marks redacted_thinking as redacted with empty text', () => {
    const entries = translate(assistant([{ type: 'redacted_thinking', data: 'opaque' }]));
    expect(entries).toEqual([{ entryType: 'thinking', text: '', redacted: true, timestamp: expect.any(String) }]);
  });

  it('flags sub-agent thinking like other sub-agent output', () => {
    const entries = translate(assistant([{ type: 'thinking', thinking: 'inner monologue', signature: 's' }], 'tool_parent'));
    expect(entries[0]).toMatchObject({ entryType: 'thinking', subagent: {} });
  });
});

describe('diff entries (CDX-050)', () => {
  const toolUse = (name: string, input: Record<string, unknown>) =>
    assistant([{ type: 'tool_use', id: 'tool_d1', name, input }]);

  it('emits a diff entry AFTER the tool call for an Edit (tool group keeps its action)', () => {
    const entries = translate(toolUse('Edit', {
      file_path: '/repo/src/app.ts',
      old_string: 'const a = 1;\nconst b = 2;',
      new_string: 'const a = 2;',
    }));
    expect(entries.map((e) => e.entryType)).toEqual(['tool_call', 'diff']);
    expect(entries[1]).toEqual({
      entryType: 'diff',
      path: '/repo/src/app.ts',
      lines: [
        { type: 'del', text: 'const a = 1;' },
        { type: 'del', text: 'const b = 2;' },
        { type: 'add', text: 'const a = 2;' },
      ],
      // Correlated to its tool call.
      callId: 'tool_d1',
      timestamp: expect.any(String),
    });
  });

  it('Write emits an all-add diff', () => {
    const diff = find(translate(toolUse('Write', { file_path: 'notes.md', content: 'line one\nline two' })), 'diff');
    expect(diff?.path).toBe('notes.md');
    expect(diff?.lines).toEqual([
      { type: 'add', text: 'line one' },
      { type: 'add', text: 'line two' },
    ]);
  });

  it('MultiEdit concatenates hunks with a context separator', () => {
    const diff = find(translate(toolUse('MultiEdit', {
      file_path: 'x.ts',
      edits: [
        { old_string: 'foo', new_string: 'bar' },
        { old_string: 'baz', new_string: 'qux' },
      ],
    })), 'diff');
    expect(diff?.lines).toEqual([
      { type: 'del', text: 'foo' },
      { type: 'add', text: 'bar' },
      { type: 'context', text: '⋯' },
      { type: 'del', text: 'baz' },
      { type: 'add', text: 'qux' },
    ]);
  });

  it('non-edit tools produce no diff', () => {
    expect(translate(toolUse('Bash', { command: 'ls -la' })).map((e) => e.entryType)).toEqual(['tool_call']);
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

describe('every entry the adapter emits is valid on the wire', () => {
  it('round-trips through the protocol schema', async () => {
    const { outputEntrySchema } = await import('@codedeck/protocol');
    const ctx = newTranslateContext();
    const all = [
      ...translate(assistant([
        { type: 'thinking', thinking: 'hm', signature: 's' },
        { type: 'text', text: 'working' },
        { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' } },
      ]), ctx),
      ...translate(user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]), ctx),
    ];
    for (const entry of all) {
      expect(outputEntrySchema.safeParse(entry).success, JSON.stringify(entry)).toBe(true);
    }
  });
});
