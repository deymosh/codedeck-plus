/**
 * Pairs Claude Code's streamed reply parts with the completed blocks they
 * become, so a `partial` and the `text` entry that replaces it carry the same
 * key.
 *
 * With `includePartialMessages`, the CLI streams an assistant message as
 * Anthropic SSE events and then delivers it as one assistant message PER
 * completed content block — so a completed block carries no index of its own
 * to name the partials it streamed under. This records each streamed text
 * block's index (from `content_block_start`) per message id, in stream order,
 * and hands those back in the same order as the blocks complete.
 *
 * Only the main agent's reply text is streamed: the phone shows a model's
 * reasoning collapsed and a sub-agent's text inside its tool group, so
 * spending a signed, encrypted relay round trip on either would be traffic
 * for what nobody sees. A stream with `parent_tool_use_id` set is therefore
 * ignored here, and a completed block from one is left plain (no part).
 */
import type { PartialDelta } from '../../sdk/partial';
import type { SdkPartialAssistantMessage } from './facade';

export class ClaudePartTracker {
  /** The message the current stream belongs to: only `message_start` names
   *  it, and the deltas that follow carry only a block index. */
  private messageId: string | undefined;
  /** Each message's streamed text blocks, by their content-block index, in
   *  stream order — consumed as the blocks complete. */
  private readonly textIndexes = new Map<string, number[]>();

  /** The text deltas a `stream_event` carries, ready to coalesce; nothing for
   *  a sub-agent's stream or for a block that is not the reply text. */
  streamEvent(msg: SdkPartialAssistantMessage): PartialDelta[] {
    if (msg.parent_tool_use_id) return [];
    const event = msg.event;
    if (event.type === 'message_start') {
      this.messageId = event.message.id;
      return [];
    }
    const messageId = this.messageId;
    if (!messageId) return [];
    if (event.type === 'content_block_start') {
      if (event.content_block.type === 'text') {
        const indexes = this.textIndexes.get(messageId) ?? [];
        indexes.push(event.index);
        this.textIndexes.set(messageId, indexes);
      }
      return [];
    }
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta' && event.delta.text) {
      return [{ key: `${messageId}:${event.index}`, entryType: 'text', text: event.delta.text }];
    }
    return [];
  }

  /**
   * The part key the next completed text block of `messageId` streamed under,
   * or undefined when it never streamed (partials were not requested, or the
   * block came whole) — the entry then carries no part. Blocks complete in
   * the order they streamed, so the first recorded index is the one whose
   * deltas this block is the end of.
   */
  takeTextPart(messageId: string): string | undefined {
    const indexes = this.textIndexes.get(messageId);
    const index = indexes?.shift();
    if (index === undefined) return undefined;
    if (indexes && indexes.length === 0) this.textIndexes.delete(messageId);
    return `${messageId}:${index}`;
  }

  /** The turn (or the session) is over: no streamed part survives it. */
  reset(): void {
    this.messageId = undefined;
    this.textIndexes.clear();
  }
}
