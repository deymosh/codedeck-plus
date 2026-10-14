/**
 * How Claude Code draws its own sessions, so the phone can read like its
 * terminal UI.
 *
 * Everything here mirrors the CLI in `@anthropic-ai/claude-code` 2.0.0's
 * `cli.js`: the spinner frame set and the working-word list its spinner
 * picks from, the "clawd" block mark its welcome header draws, and the
 * orange its `claude` theme token paints that mark with. Confirmed against
 * `claude-code-2.0.0` (cli.js).
 */
import type { AgentInfo } from '../../sdk/types';

/** The generated shape `AgentInfo.style` carries. */
type AgentStyle = NonNullable<AgentInfo['style']>;

/**
 * The words beside Claude Code's spinner while it works, one per turn, in
 * the CLI's own order. Its spinner picks one and appends "…"; the phone adds
 * its own ellipsis, so the words are stored bare.
 */
const WORKING_WORDS = [
  'Accomplishing',
  'Actioning',
  'Actualizing',
  'Baking',
  'Booping',
  'Brewing',
  'Calculating',
  'Cerebrating',
  'Channelling',
  'Churning',
  'Clauding',
  'Coalescing',
  'Cogitating',
  'Computing',
  'Combobulating',
  'Concocting',
  'Considering',
  'Contemplating',
  'Cooking',
  'Crafting',
  'Creating',
  'Crunching',
  'Deciphering',
  'Deliberating',
  'Determining',
  'Discombobulating',
  'Doing',
  'Effecting',
  'Elucidating',
  'Enchanting',
  'Envisioning',
  'Finagling',
  'Flibbertigibbeting',
  'Forging',
  'Forming',
  'Frolicking',
  'Generating',
  'Germinating',
  'Hatching',
  'Herding',
  'Honking',
  'Ideating',
  'Imagining',
  'Incubating',
  'Inferring',
  'Manifesting',
  'Marinating',
  'Meandering',
  'Moseying',
  'Mulling',
  'Mustering',
  'Musing',
  'Noodling',
  'Percolating',
  'Perusing',
  'Philosophising',
  'Pontificating',
  'Pondering',
  'Processing',
  'Puttering',
  'Puzzling',
  'Reticulating',
  'Ruminating',
  'Scheming',
  'Schlepping',
  'Shimmying',
  'Simmering',
  'Smooshing',
  'Spelunking',
  'Spinning',
  'Stewing',
  'Sussing',
  'Synthesizing',
  'Thinking',
  'Tinkering',
  'Transmuting',
  'Unfurling',
  'Unravelling',
  'Vibing',
  'Wandering',
  'Whirring',
  'Wibbling',
  'Working',
  'Wrangling',
];

export const CLAUDE_STYLE: AgentStyle = {
  // The macOS frame set, stepped one frame every 120ms and played forward
  // then backward (the CLI builds the ping-pong cycle itself). Not the
  // non-darwin set, which substitutes `*` for the third frame.
  spinner: { frames: ['·', '✢', '✳', '✶', '✻', '✽'], intervalMs: 120, bounce: true },
  workingWords: WORKING_WORDS,
  // The CLI shows the elapsed time and the token count beside the word.
  workingCounter: true,
  // Every tool row wears the same filled circle; the CLI marks a tool result
  // with the corner glyph. The circle is the CLI's own `●` (U+25CF), which it
  // draws wherever `⏺` (U+23FA) could come out as an emoji: Android draws
  // U+23FA as a coloured emoji square even with a text-presentation selector.
  toolGlyphs: { other: '●' },
  resultMark: '⎿',
  userMessage: { shape: 'prompt', mark: '>' },
  // The "clawd" mark, three lines. The CLI draws line 1 one cell short of
  // lines 2 and 3, so it is padded here to a single width. It is one tone,
  // so there is no wordmarkSplit.
  wordmark: [' ▐▛███▜▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  '],
  // The CLI's `claude` theme token, rgb(215,119,87) — the mark's own colour.
  accent: '#D77757',
  // The colours the CLI's mode indicator ("plan mode on", "accept edits
  // on") wears in its dark theme: its `planMode` and `autoAccept` tokens.
  // The default mode has none, and bypassing permissions is shown in the
  // CLI's error colour, which on the phone is a state colour and not the
  // agent's to set.
  modeColors: { plan: '#48968C', acceptEdits: '#AF87FF' },
};
