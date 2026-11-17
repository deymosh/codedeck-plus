/**
 * How Pi's sessions look on the phone, taken from Pi's own terminal UI.
 *
 * Three values are quoted from the installed package: the loader's frame set
 * and pace (`@earendil-works/pi-tui` `dist/components/loader.js`), the coral
 * of its logo (`dist/modes/interactive/components/pi-logo.js`, `rgb(228, 138,
 * 122)`) and the half-block logo itself. Pi's tool rows are bordered boxes
 * with a title line rather than a glyph per kind, so none is set; its working
 * line is the loader's message with no elapsed-time counter, so none is set
 * either.
 */
import type { AgentInfo } from '../../sdk/types';

/** The generated shape `AgentInfo.style` carries. */
type AgentStyle = NonNullable<AgentInfo['style']>;

export const PI_STYLE: AgentStyle = {
  // The loader's DEFAULT_FRAMES and DEFAULT_INTERVAL_MS: ten braille frames,
  // one every 80 ms, played forward.
  spinner: { frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'], intervalMs: 80 },
  // The logo's coral, the mark's own colour (the theme's `accent` token is a
  // violet used for selection; the brand mark stays fixed across themes).
  accent: '#E48A7A',
  // pi-logo.js draws a four-cell, two-line mark: coral and blue on the top
  // line, blue and yellow on the bottom. The phone paints a mark in one
  // colour, so it keeps the shape and not the three brand tones.
  wordmark: ['▀▀█ ', '█▀ █'],
};
