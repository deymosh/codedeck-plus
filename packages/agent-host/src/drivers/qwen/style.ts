/**
 * How Qwen Code draws its own sessions, so the phone can read like its
 * terminal UI.
 *
 * Everything here mirrors the CLI's Ink UI in `@qwen-code/qwen-code` 0.25.2
 * (`packages/cli/src/ui`, its default `qwen-dark` theme): the spinner its
 * responding indicator runs, the `>` its prompt line starts with, the colour
 * its approval-mode indicator wears per mode, and the "QWEN" header logo.
 * Its tool rows carry a status mark rather than one per kind, and its working
 * line cycles localized sentences, so the phone keeps its own markers and
 * words for both.
 */
import type { AgentInfo } from '../../sdk/types';

/** The generated shape `AgentInfo.style` carries. */
type AgentStyle = NonNullable<AgentInfo['style']>;

export const QWEN_STYLE: AgentStyle = {
  // cli-spinners' `dots`, the CLI's default spinner: ten braille frames, one
  // every 80ms, played forward only.
  spinner: { frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'], intervalMs: 80 },
  // The working line shows the elapsed time and an estimate of the tokens.
  workingCounter: true,
  userMessage: { shape: 'prompt', mark: '>' },
  // "QWEN" in capitals. The CLI's logo is a box-drawing font with a drop
  // shadow, which quarter cells cannot draw, so it is redrawn in the cell
  // shapes of the OpenCode and DeepSeek wordmarks: four cells per letter, a
  // blank cell between letters, cap height up to the half cell those
  // wordmarks' ascenders reach, and the Q's tail below the baseline.
  wordmark: [
    '▄▄▄▄ ▄  ▄ ▄▄▄▄ ▄▖ ▄',
    '█  █ █  █ █    █▜▖█',
    '█ ▜█ █▐▌█ █▀▀  █ ▜█',
    '▀▀▀█ ▀▀▀▀ ▀▀▀▀ ▀  ▀',
  ],
  // The gold the logo's gradient starts from (`#FFD700` to `#da7959`): the
  // phone draws a mark in one colour, and the gradient's other end is close
  // to Claude Code's orange.
  accent: '#FFD700',
  // The approval-mode indicator's colours (`approvalModeVisuals.ts`): plan in
  // the theme's green, auto-edit in its yellow, the classifier's auto mode in
  // its link blue. The default mode is drawn in the secondary text colour,
  // which is the phone's own; YOLO wears the theme's error red, which on the
  // phone is a state colour and not the agent's to set. Mode ids are written
  // bare: this module is loaded from the driver, so importing the driver's
  // constants back would be a cycle.
  modeColors: { plan: '#AAD94C', 'auto-edit': '#FFD700', auto: '#39BAE6' },
};
