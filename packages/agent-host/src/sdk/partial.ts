/**
 * Coalesces an agent's streaming deltas into the driver protocol's `partial`
 * events.
 *
 * Every `partial` is signed, encrypted and a relay round trip — often over
 * Tor — so a long reply must cost a few updates a second, never one per
 * token. A part's deltas are held and sent on a timer; each send carries only
 * the characters since the last one, and `offset` is the UTF-16 length already
 * sent (the coordinate the phone's live row grows by).
 *
 * The timer is the whole mechanism: a part is never sent on the delta that
 * first fills it, so a part that completes within one interval is not sent at
 * all — its completing entry carries it — and the completing entry always
 * drops whatever was still held rather than flushing it.
 */
import type { PartialKind, Subagent } from './types';

/** One part's streamed change, before coalescing. */
export interface PartialDelta {
  /** Names the part: the SDK's block or part id. */
  key: string;
  entryType: PartialKind;
  text: string;
  /** Set when a sub-agent (not the session's main agent) produced it. */
  subagent?: Subagent;
}

/** A coalesced update, ready for the `partial` session event: `key`'s text
 *  from `offset` on, `offset` counted in UTF-16 code units. */
export interface PartialUpdate {
  key: string;
  entryType: PartialKind;
  offset: number;
  text: string;
  subagent?: Subagent;
}

/** How often a part may be sent. A reply costs a few updates a second: fast
 *  enough to read as it is written, slow enough that a relay round trip per
 *  token never happens (and over Tor, so it still reaches the phone). */
export const PARTIAL_INTERVAL_MS = 250;

/** What one part has accumulated, and how to label its updates. */
interface HeldPart {
  entryType: PartialKind;
  subagent?: Subagent;
  text: string;
}

export class PartialCoalescer {
  /** Un-sent text per part, keyed by the part. */
  private readonly held = new Map<string, HeldPart>();
  /** UTF-16 length already sent for each part: the offset its next update
   *  starts at. */
  private readonly sent = new Map<string, number>();
  /** The one timer for the whole session. A tick sends every part that has
   *  text waiting; with nothing waiting there is no timer, and no timer
   *  outlives the session. */
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly send: (update: PartialUpdate) => void,
    private readonly intervalMs: number = PARTIAL_INTERVAL_MS,
  ) {}

  /** Hold one part's delta. The first text a part receives arms the timer;
   *  nothing is sent until its tick. */
  delta(delta: PartialDelta): void {
    if (delta.text === '') return;
    const held = this.held.get(delta.key);
    if (held) {
      held.text += delta.text;
    } else {
      this.held.set(delta.key, {
        entryType: delta.entryType,
        ...(delta.subagent ? { subagent: delta.subagent } : {}),
        text: delta.text,
      });
    }
    if (this.timer === undefined) {
      this.timer = setTimeout(() => this.flush(), this.intervalMs);
      this.timer.unref?.();
    }
  }

  /** The part's completing entry is about to be delivered: it carries the
   *  whole text, so anything still held is dropped, never sent. */
  complete(key: string): void {
    this.held.delete(key);
    this.sent.delete(key);
    if (this.held.size === 0) this.clearTimer();
  }

  /** The turn (or the session) is over: every part is dropped, and no timer
   *  survives to send text from a turn that has ended. */
  reset(): void {
    this.held.clear();
    this.sent.clear();
    this.clearTimer();
  }

  private flush(): void {
    this.timer = undefined;
    for (const [key, held] of this.held) {
      const offset = this.sent.get(key) ?? 0;
      this.sent.set(key, offset + held.text.length);
      this.send({
        key,
        entryType: held.entryType,
        offset,
        text: held.text,
        ...(held.subagent ? { subagent: held.subagent } : {}),
      });
    }
    this.held.clear();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
