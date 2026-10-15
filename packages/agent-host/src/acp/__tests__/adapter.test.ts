/**
 * acpUpdateToEntries — the shared ACP translator, in the style of
 * sdk-adapter.test.ts and opencode-adapter.test.ts.
 *
 * The tool table is the one thing a driver supplies, so here it is a stub
 * that keeps each call's own name: what this file covers is the standard ACP
 * shape every agent's updates share — messages and thoughts, the tool call
 * lifecycle and its memory, results, and the updates ACP defines that carry
 * no entry of their own. Each agent's own read of its calls is covered beside
 * its table.
 */
import { describe, expect, it } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { OutputEntry } from '../../sdk/types';
import { acpUpdateToEntries, type AcpUpdateTranslation, type ToolCallMemory } from '../adapter';

type EntryOf<T extends OutputEntry['entryType']> = Extract<OutputEntry, { entryType: T }>;

/** The one part a driver supplies: the kind and title a call's name gives it. */
const TRANSLATION: AcpUpdateTranslation = {
  readToolCall: (name) => ({ kind: 'other', title: name }),
};

function entries(update: unknown, calls: ToolCallMemory = new Map()): OutputEntry[] {
  return acpUpdateToEntries(update as SessionUpdate, calls, TRANSLATION);
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

  it('ignores the updates the automation profile never sends over ACP', () => {
    // A client must not invent entries for the updates it is not sent: plans,
    // commands and modes are each their own notification.
    expect(entries({ sessionUpdate: 'plan', entries: [{ content: 'x', status: 'pending', priority: 'low' }] })).toEqual([]);
    expect(entries({ sessionUpdate: 'available_commands_update', availableCommands: [] })).toEqual([]);
    expect(entries({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' })).toEqual([]);
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

describe('text helper', () => {
  it('reads the text of a chunk', () => {
    expect(text({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } })).toBe('hello');
  });
});
