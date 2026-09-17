/**
 * Translates synthesized OpenCode messages into Codedeck OutputEntry objects —
 * the OpenCode-backend counterpart of `sdk/adapter.ts`'s `sdkMessageToEntries`.
 *
 * `SdkSessionHandle.messages()` is typed as `AsyncIterable<SdkMessage>`, and
 * `SdkMessage` is a literal re-export of the Claude Agent SDK's own union —
 * `@opencode-ai/sdk`'s `Message`/`Part`/`Event` shapes have nothing to do with
 * it. `opencodeFacade.ts` bridges this by wrapping each OpenCode event it
 * cares about in one of the small envelopes below (cast `as unknown as
 * SdkMessage` at the seam, mirroring the existing `msg as unknown as
 * {state: string}` cast `session/runner.ts` already does for
 * `session_state_changed`) and this module is the ONLY place that unwraps and
 * reads them. `SessionRunner` never branches on which backend produced a
 * message — it calls whichever `translateMessage` function `bridge.ts`'s
 * `makeRunner` injected for the session's `backend`.
 */
import type { OutputEntry } from '@codedeck/protocol';
import type { Part } from '@opencode-ai/sdk';
import type { AdapterOptions } from './adapter';
import type { SdkMessage } from './facade';

/**
 * Synthesized once, right after `probeReady()` resolves — drives the SAME
 * `type: 'system', subtype: 'init'` branch `session/runner.ts` already has
 * for Claude Code, so the runner picks up `sdkSessionId`/`model`/
 * `permissionMode` with no backend-specific code.
 */
export interface OpenCodeInitMessage {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model?: string;
  permissionMode?: string;
}

/**
 * Synthesized on OpenCode's `session.idle` event — drives the SAME
 * `subtype: 'session_state_changed'` branch the runner already has for
 * Claude Code (stream_end / idle detection).
 */
export interface OpenCodeStateMessage {
  type: 'system';
  subtype: 'session_state_changed';
  state: 'idle' | 'running';
}

/**
 * One OpenCode message Part that reached a stable, translatable state.
 * `OpenCodeSessionHandle` filters out mid-stream text/reasoning deltas before
 * emitting this — see its doc comment — so this module never has to
 * deduplicate a part it has already seen.
 */
export interface OpenCodePartMessage {
  type: 'opencode-part';
  part: Part;
  /** `Part` itself carries no role; the handle tracks whose turn produced it. */
  role: 'user' | 'assistant';
}

/** A provider/session-level failure reported outside any Part
 *  (`AssistantMessage.error`, or a `session.error` event). */
export interface OpenCodeErrorMessage {
  type: 'opencode-error';
  content: string;
}

export type OpenCodeAdapterMessage =
  | OpenCodeInitMessage
  | OpenCodeStateMessage
  | OpenCodePartMessage
  | OpenCodeErrorMessage;

/**
 * Convert one synthesized OpenCode message envelope into zero or more
 * OutputEntry objects. Signature matches `sdkMessageToEntries` exactly so
 * `SessionRunnerOptions.translateMessage` can hold either interchangeably.
 */
export function opencodeMessageToEntries(msg: SdkMessage, opts?: AdapterOptions): OutputEntry[] {
  const envelope = msg as unknown as OpenCodeAdapterMessage;
  switch (envelope.type) {
    case 'system':
      return parseSystem(envelope);
    case 'opencode-part':
      return parsePart(envelope);
    case 'opencode-error':
      return [{
        entryType: 'error',
        content: envelope.content,
        timestamp: new Date().toISOString(),
      }];
    default:
      // Any OpenCode Part kind this pass doesn't translate (file, subtask,
      // agent, step markers, snapshots, patches, retries, compaction) — skip,
      // same policy as sdkMessageToEntries's default case.
      return [];
  }
}

function parseSystem(msg: OpenCodeInitMessage | OpenCodeStateMessage): OutputEntry[] {
  if (msg.subtype === 'init') {
    return [{
      entryType: 'system',
      content: `OpenCode session started${msg.model ? ` (${msg.model})` : ''}`,
      timestamp: new Date().toISOString(),
      metadata: {
        subtype: 'init',
        ...(msg.model ? { model: msg.model } : {}),
        ...(msg.permissionMode ? { permissionMode: msg.permissionMode } : {}),
      },
    }];
  }

  if (msg.state === 'idle') {
    // Same authoritative "turn is over" signal the phone reads from Claude
    // Code's session_state_changed — see sdk/adapter.ts's parseSystem.
    return [{
      entryType: 'system',
      content: '',
      timestamp: new Date().toISOString(),
      metadata: { stream_end: true },
    }];
  }
  return [];
}

function parsePart(msg: OpenCodePartMessage): OutputEntry[] {
  const { part, role } = msg;
  const ts = new Date().toISOString();

  switch (part.type) {
    case 'text':
      if (!part.text) return [];
      return [{
        entryType: 'text',
        content: part.text,
        timestamp: ts,
        metadata: { role },
      }];
    case 'reasoning':
      if (!part.text) return [];
      return [{
        entryType: 'thinking',
        content: part.text,
        timestamp: ts,
        metadata: { role },
      }];
    case 'tool':
      return parseTool(part, ts);
    default:
      return [];
  }
}

function parseTool(part: Extract<Part, { type: 'tool' }>, ts: string): OutputEntry[] {
  const state = part.state;

  // 'pending' input may still be streaming in — nothing stable to show yet.
  if (state.status === 'pending') return [];

  if (state.status === 'running') {
    return [{
      entryType: 'tool_use',
      content: formatToolInput(part.tool, state.input as Record<string, unknown>),
      timestamp: ts,
      metadata: {
        role: 'assistant',
        tool_name: part.tool,
        tool_use_id: part.callID,
        tool_input: state.input,
      },
    }];
  }

  if (state.status === 'completed') {
    const output = state.output ?? '';
    const text = output.length > 2000 ? output.slice(0, 2000) + '...[truncated]' : output;
    return [{
      entryType: 'tool_result',
      content: text,
      timestamp: ts,
      metadata: { tool_use_id: part.callID },
    }];
  }

  // status === 'error'
  return [{
    entryType: 'tool_result',
    content: state.error ?? 'Tool call failed',
    timestamp: ts,
    metadata: { tool_use_id: part.callID, error: true },
  }];
}

function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  return `${toolName}: ${JSON.stringify(input ?? {}).slice(0, 200)}`;
}
