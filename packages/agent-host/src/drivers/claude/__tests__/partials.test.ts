/**
 * ClaudePartTracker and the adapter's part naming: which stream events become
 * reply-text deltas, and how the `text` entry that completes a streamed block
 * names the same key (so the phone's live row is replaced, not duplicated).
 */
import { describe, expect, it } from 'vitest';
import { ClaudePartTracker } from '../partials';
import { sdkMessageToEntries } from '../adapter';
import { newTranslateContext } from '../../../sdk/transcript';
import type { SdkAssistantMessage, SdkPartialAssistantMessage } from '../facade';

function stream(event: unknown, parent: string | null = null): SdkPartialAssistantMessage {
  return { type: 'stream_event', event, parent_tool_use_id: parent } as SdkPartialAssistantMessage;
}

function assistant(id: string, content: unknown[], parent: string | null = null): SdkAssistantMessage {
  return {
    type: 'assistant',
    message: { id, type: 'message', role: 'assistant', content },
    parent_tool_use_id: parent,
  } as unknown as SdkAssistantMessage;
}

const started = (id: string) => stream({ type: 'message_start', message: { id } });
const blockStart = (index: number, type: string) =>
  stream({ type: 'content_block_start', index, content_block: { type } });
const textDelta = (index: number, text: string, parent: string | null = null) =>
  stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } }, parent);
const thinkingDelta = (index: number, thinking: string) =>
  stream({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } });

describe('ClaudePartTracker', () => {
  it('turns reply-text deltas into parts keyed by message and block index', () => {
    const tracker = new ClaudePartTracker();
    expect(tracker.streamEvent(started('msg_1'))).toEqual([]);
    expect(tracker.streamEvent(blockStart(0, 'text'))).toEqual([]);
    expect(tracker.streamEvent(textDelta(0, 'Hel'))).toEqual([{ key: 'msg_1:0', entryType: 'text', text: 'Hel' }]);
    expect(tracker.streamEvent(textDelta(0, 'lo'))).toEqual([{ key: 'msg_1:0', entryType: 'text', text: 'lo' }]);
  });

  it('streams nothing for reasoning, nor for a tool call', () => {
    const tracker = new ClaudePartTracker();
    tracker.streamEvent(started('msg_1'));
    expect(tracker.streamEvent(blockStart(0, 'thinking'))).toEqual([]);
    expect(tracker.streamEvent(thinkingDelta(0, 'hmm'))).toEqual([]);
    expect(tracker.streamEvent(blockStart(1, 'tool_use'))).toEqual([]);
  });

  it("streams nothing for a sub-agent's own text", () => {
    const tracker = new ClaudePartTracker();
    // The main agent's stream and the sub-agent's interleave; only the main
    // one is streamed (a sub-agent's text renders inside its tool group).
    tracker.streamEvent(started('msg_main'));
    tracker.streamEvent(stream({ type: 'message_start', message: { id: 'msg_sub' } }, 'agent_1'));
    expect(tracker.streamEvent(textDelta(0, 'inner', 'agent_1'))).toEqual([]);
    expect(tracker.streamEvent(textDelta(0, 'outer'))).toEqual([{ key: 'msg_main:0', entryType: 'text', text: 'outer' }]);
  });

  it('hands the streamed index back for each completed block, in order', () => {
    const tracker = new ClaudePartTracker();
    tracker.streamEvent(started('msg_1'));
    tracker.streamEvent(blockStart(2, 'text')); // a tool_use/text ahead of it, say
    expect(tracker.takeTextPart('msg_1')).toBe('msg_1:2');
    // Nothing left: a block that never streamed carries no part.
    expect(tracker.takeTextPart('msg_1')).toBeUndefined();
  });

  it('forgets every part at the end of a turn', () => {
    const tracker = new ClaudePartTracker();
    tracker.streamEvent(started('msg_1'));
    tracker.streamEvent(blockStart(0, 'text'));
    tracker.reset();
    expect(tracker.takeTextPart('msg_1')).toBeUndefined();
  });
});

describe('a completed streamed block names its part', () => {
  it('sets part on the text entry the streamed block became', () => {
    const blocks = new ClaudePartTracker();
    blocks.streamEvent(started('msg_1'));
    blocks.streamEvent(blockStart(0, 'text'));
    const entries = sdkMessageToEntries(assistant('msg_1', [{ type: 'text', text: 'Hello' }]), newTranslateContext(), blocks);
    expect(entries).toEqual([
      expect.objectContaining({ entryType: 'text', text: 'Hello', part: 'msg_1:0' }),
    ]);
  });

  it('leaves a text block that never streamed without a part', () => {
    const entries = sdkMessageToEntries(assistant('msg_1', [{ type: 'text', text: 'whole' }]), newTranslateContext(), new ClaudePartTracker());
    expect(entries[0]).not.toHaveProperty('part');
  });

  it("never names a part on a sub-agent's text or on reasoning", () => {
    const blocks = new ClaudePartTracker();
    blocks.streamEvent(started('msg_1'));
    blocks.streamEvent(blockStart(0, 'text'));
    const entries = sdkMessageToEntries(
      assistant('msg_1', [{ type: 'thinking', thinking: 'thought' }, { type: 'text', text: 'inner' }], 'agent_1'),
      newTranslateContext(),
      blocks,
    );
    for (const entry of entries) expect(entry).not.toHaveProperty('part');
  });
});
