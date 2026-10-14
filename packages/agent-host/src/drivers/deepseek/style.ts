/**
 * How DeepSeek Harness sessions look on the phone.
 *
 * The harness has no terminal UI to mirror — its own client is a web page —
 * so the only mark it gets is the one that page opens a conversation with:
 * its name. That page draws the name in the plain text colour in both of its
 * themes, so the wordmark here is one tone with no accent. The spinner, the
 * tool rows and the user's message keep the phone's own look.
 */
import type { AgentInfo } from '../../sdk/types';

/** The generated shape `AgentInfo.style` carries. */
type AgentStyle = NonNullable<AgentInfo['style']>;

export const DEEPSEEK_STYLE: AgentStyle = {
  // "deepseek" in lowercase block letters, built from the same cell shapes
  // as the OpenCode wordmark so the two agents' logos sit at one size: four
  // cells per letter, a blank cell between letters, the `d` and `k`
  // ascenders on the first line.
  wordmark: [
    '   ▄                               ▄   ',
    '█▀▀█ █▀▀█ █▀▀█ █▀▀█ █▀▀▀ █▀▀█ █▀▀█ █ ▄▀',
    '█  █ █▀▀▀ █▀▀▀ █  █ ▀▀▀█ █▀▀▀ █▀▀▀ █▀▄ ',
    '▀▀▀▀ ▀▀▀▀ ▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀  ▀',
  ],
};
