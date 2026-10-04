/**
 * deepseekUpdateToEntries and toolCallDiffs — the DeepSeek Harness
 * translator, in the style of sdk-adapter.test.ts and opencode-adapter.test.ts.
 *
 * The updates are the ones the harness's own ACP module sends: assistant
 * messages and thoughts, generic tool call lifecycles whose kind is always
 * `other` and whose title is the tool's name, and usage. Nothing else — no
 * plans, no modes, no commands — which the last case covers.
 */
import { describe, expect, it } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { DiffLine, OutputEntry } from '../../../types';
import { deepseekUpdateToEntries, toolCallDiffs, type ToolCallMemory } from '../adapter';

type EntryOf<T extends OutputEntry['entryType']> = Extract<OutputEntry, { entryType: T }>;

function entries(update: unknown, calls: ToolCallMemory = new Map()): OutputEntry[] {
  return deepseekUpdateToEntries(update as SessionUpdate, calls);
}

/** The call one update reports, ready for its result. */
function started(name: string, input: Record<string, unknown> = {}, calls: ToolCallMemory = new Map()): ToolCallMemory {
  entries({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: name, kind: 'other', status: 'in_progress', rawInput: input }, calls);
  return calls;
}

const text = (update: unknown): string => (entries(update)[0] as EntryOf<'text'>).text;

describe('messages', () => {
  it('renders an agent message chunk as agent text', () => {
    expect(entries({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } })).toEqual([
      { entryType: 'text', role: 'agent', text: 'Done.', timestamp: expect.any(String) },
    ]);
  });

  it('drops an empty chunk', () => {
    expect(entries({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } })).toEqual([]);
  });

  it('renders a thought as thinking', () => {
    expect(entries({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } })).toEqual([
      { entryType: 'thinking', text: 'hmm', timestamp: expect.any(String) },
    ]);
  });

  it('ignores the updates the harness never sends over ACP', () => {
    // The automation profile carries no plans, commands, modes or terminal
    // callbacks; a client must not invent entries for them.
    expect(entries({ sessionUpdate: 'plan', entries: [{ content: 'x', status: 'pending', priority: 'low' }] })).toEqual([]);
    expect(entries({ sessionUpdate: 'available_commands_update', availableCommands: [] })).toEqual([]);
    expect(entries({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' })).toEqual([]);
  });
});

describe('tool calls', () => {
  it('summarizes a command, with its whole text as the call input', () => {
    const call = entries({
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'bash',
      kind: 'other',
      status: 'in_progress',
      rawInput: { command: 'npm ci\nnpm test', description: 'Install and test' },
    })[0] as EntryOf<'tool_call'>;
    expect(call).toMatchObject({ entryType: 'tool_call', callId: 'c1', toolName: 'bash', kind: 'execute', title: 'npm ci…' });
    expect(call.input).toBe('npm ci\nnpm test');
  });

  it('uses the ACP name when the harness sends one', () => {
    const call = entries({
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'Running the tests',
      name: 'bash',
      kind: 'other',
      status: 'in_progress',
      rawInput: { command: 'npm test' },
    })[0] as EntryOf<'tool_call'>;
    expect(call.toolName).toBe('bash');
    expect(call.kind).toBe('execute');
  });

  it('names the file a read touches and leaves a single-path input out', () => {
    const call = entries({
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'read',
      kind: 'other',
      status: 'in_progress',
      rawInput: { file_path: 'src/main.ts' },
    })[0] as EntryOf<'tool_call'>;
    expect(call).toMatchObject({ kind: 'read', title: 'src/main.ts', locations: ['src/main.ts'] });
    expect(call.input).toBeUndefined();
  });

  it('reads str_replace_editor\'s own path as its location', () => {
    const call = entries({
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'str_replace_editor',
      kind: 'other',
      status: 'in_progress',
      rawInput: { command: 'str_replace', path: '/repo/a.py', old_str: 'x', new_str: 'y' },
    })[0] as EntryOf<'tool_call'>;
    expect(call).toMatchObject({ kind: 'edit', title: 'str_replace /repo/a.py', locations: ['/repo/a.py'] });
  });

  it('shows a checklist a todo call wrote, and no input for it', () => {
    const call = entries({
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'todo_write',
      kind: 'other',
      status: 'in_progress',
      rawInput: { todos: [{ content: 'Ship it', status: 'in_progress' }] },
    });
    expect(call[0]).toMatchObject({ entryType: 'tool_call', kind: 'think' });
    expect((call[0] as EntryOf<'tool_call'>).input).toBeUndefined();
    expect(call[1]).toEqual({
      entryType: 'todos',
      callId: 'c1',
      items: [{ text: 'Ship it', status: 'in_progress' }],
      timestamp: expect.any(String),
    });
  });

  it('keeps the tool name of an MCP tool', () => {
    const call = entries({
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'mcp__github__create_issue',
      kind: 'other',
      status: 'in_progress',
      rawInput: { title: 'a bug' },
    })[0] as EntryOf<'tool_call'>;
    expect(call.toolName).toBe('mcp__github__create_issue');
    expect(call.kind).toBe('other');
  });
});

describe('tool results', () => {
  it('renders a completed call and forgets it', () => {
    const calls = started('bash', { command: 'ls' });
    const result = entries(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'a.ts\nb.ts' } }],
      },
      calls,
    );
    expect(result).toEqual([
      { entryType: 'tool_result', callId: 'c1', text: 'a.ts\nb.ts', timestamp: expect.any(String) },
    ]);
    expect(calls.size).toBe(0);
  });

  it('marks a failed call', () => {
    const calls = started('bash', { command: 'ls' });
    const result = entries(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'not found' } }],
      },
      calls,
    )[0] as EntryOf<'tool_result'>;
    expect(result).toMatchObject({ entryType: 'tool_result', text: 'not found', isError: true });
  });

  it('shows an image result as a placeholder', () => {
    const calls = started('read_image', { file_path: 'a.png' });
    const result = entries(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } }],
      },
      calls,
    );
    expect((result[0] as EntryOf<'tool_result'>).text).toBe('[image]');
  });

  it('shows nothing for a progress update', () => {
    const calls = started('bash', { command: 'ls' });
    expect(
      entries({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress', content: [] }, calls),
    ).toEqual([]);
    expect(calls.size).toBe(1);
  });

  it('renders a result whose call was never seen', () => {
    const result = entries({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'gone',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'orphan' } }],
    });
    expect(result).toEqual([{ entryType: 'tool_result', callId: 'gone', text: 'orphan', timestamp: expect.any(String) }]);
  });
});

describe('file changes', () => {
  const diffOf = (parsed: OutputEntry[]): { path: string; lines: DiffLine[]; truncated?: boolean } => {
    const diff = parsed.find((entry): entry is EntryOf<'diff'> => entry.entryType === 'diff')!;
    return { path: diff.path, lines: diff.lines, ...(diff.truncated ? { truncated: true } : {}) };
  };

  it('shows an edit as the replaced text', () => {
    const calls = started('edit', { file_path: 'a.ts', old_string: 'one', new_string: 'two' });
    const result = entries({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [] }, calls);
    expect(diffOf(result)).toEqual({
      path: 'a.ts',
      lines: [
        { type: 'del', text: 'one' },
        { type: 'add', text: 'two' },
      ],
    });
  });

  it('shows a write as all additions', () => {
    const calls = started('write', { file_path: 'new.ts', content: 'a\nb' });
    const result = entries({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [] }, calls);
    expect(diffOf(result).lines).toEqual([
      { type: 'add', text: 'a' },
      { type: 'add', text: 'b' },
    ]);
  });

  it('follows what str_replace_editor was asked to do', () => {
    const create = started('str_replace_editor', { command: 'create', path: '/repo/a.py', file_text: 'print(1)' });
    expect(
      diffOf(entries({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [] }, create)).lines,
    ).toEqual([{ type: 'add', text: 'print(1)' }]);

    const replace = started('str_replace_editor', { command: 'str_replace', path: '/repo/a.py', old_str: 'x', new_str: 'y' });
    expect(
      diffOf(entries({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [] }, replace)).lines,
    ).toEqual([
      { type: 'del', text: 'x' },
      { type: 'add', text: 'y' },
    ]);

    const view = started('str_replace_editor', { command: 'view', path: '/repo/a.py' });
    expect(entries({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [] }, view)).toHaveLength(1);
  });

  it('shows nothing for a failed change', () => {
    const calls = started('edit', { file_path: 'a.ts', old_string: 'one', new_string: 'two' });
    const result = entries({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'failed', content: [] }, calls);
    expect(result.map((entry) => entry.entryType)).toEqual(['tool_result']);
  });

  it('bounds a change to the wire cap', () => {
    const long = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n');
    const calls = started('write', { file_path: 'big.ts', content: long });
    const diff = diffOf(entries({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [] }, calls));
    expect(diff.truncated).toBe(true);
    expect(diff.lines).toHaveLength(200);
  });

  it('truncates a very long line', () => {
    const calls = started('write', { file_path: 'wide.ts', content: 'x'.repeat(600) });
    const diff = diffOf(entries({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [] }, calls));
    expect(diff.lines[0]!.text).toHaveLength(501);
    expect(diff.lines[0]!.text.endsWith('…')).toBe(true);
  });
});

describe('toolCallDiffs', () => {
  it('reads nothing out of a tool that changes no file', () => {
    expect(toolCallDiffs('bash', { command: 'ls' })).toEqual([]);
    expect(toolCallDiffs('edit', {})).toEqual([]);
    expect(toolCallDiffs('write', { file_path: 'a.ts' })).toEqual([]);
  });

  it('accepts the path a Claude-shaped editor uses', () => {
    expect(toolCallDiffs('write', { path: '/a/b.ts', file_text: 'x' })).toEqual([
      { path: '/a/b.ts', lines: [{ type: 'add', text: 'x' }] },
    ]);
  });
});

describe('text helper', () => {
  it('reads the text of a chunk', () => {
    expect(text({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } })).toBe('hello');
  });
});
