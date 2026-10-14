/**
 * How OpenCode draws its own sessions, so the phone can read like its TUI.
 *
 * The spinner frames, the tool glyphs and the logo all mirror OpenCode's own
 * TUI source (`packages/tui`): the frame set, the file/edit/search/… marks
 * its tool rows wear, and the two-tone "opencode" wordmark from its
 * `logo.ts`. Confirmed from anomalyco/opencode's TUI.
 */
import type { AgentInfo } from '../../sdk/types';

/** The generated shape `AgentInfo.style` carries. */
type AgentStyle = NonNullable<AgentInfo['style']>;

export const OPENCODE_STYLE: AgentStyle = {
  // A ten-frame braille cycle, stepped one frame every 80ms; played forward
  // only, no bounce.
  spinner: { frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'], intervalMs: 80 },
  // Each tool row wears the mark OpenCode's TUI gives that kind. `move` and
  // `switch_mode` are left out, so those keep the phone's own marker.
  toolGlyphs: { read: '→', edit: '←', delete: '←', search: '✱', fetch: '%', execute: '$', agent: '→', other: '→' },
  userMessage: { shape: 'block' },
  // The "opencode" wordmark from OpenCode's logo.ts, each line its left half
  // plus the gap plus its right half, with the logo's shading cells flattened
  // to plain text: `_` (a blank cell on the shadow) and `~` (an upper half
  // block in the shadow colour) become spaces, `^` (an upper half block on
  // the shadow) becomes a plain `▀`. The phone draws two tones, not
  // OpenCode's shadow, so the shape is kept without it.
  wordmark: [
    '                                 ▄     ',
    '█▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█',
    '█  █ █  █ █▀▀▀ █  █ █    █  █ █  █ █▀▀▀',
    '▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀  ▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀',
  ],
  // "open" and the gap are drawn muted, "code" bright.
  wordmarkSplit: 20,
  // The build agent's colour for a session that runs as itself, and the plan
  // agent's for a session that runs OpenCode's plan agent. These are the
  // driver's own mode ids (OPENCODE_MODES: `ask`, `plan`, `default`), written
  // bare on purpose — this module is loaded from the driver, so importing the
  // driver's constants back here would be a cycle.
  modeColors: { ask: '#5C9CF5', plan: '#9D7CD8', default: '#5C9CF5' },
};
