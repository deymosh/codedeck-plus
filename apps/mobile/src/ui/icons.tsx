/**
 * icons — the app's only inline SVGs (CDX-084).
 *
 * Every other glyph in this UI is a BMP dingbat (⊕ ⚙ ☰ ✕ ‹ › ▸ ↳ ✓) that the
 * text font renders monochrome. The composer's attach and mic buttons were the
 * two exceptions: 📎 U+1F4CE and 🎙 U+1F399 are emoji-presentation codepoints,
 * so Android always draws them in full colour and they read as pasted stickers
 * against the rest of the chrome. Unicode has no monochrome paperclip or
 * microphone to swap in, so these two are hand-drawn instead.
 *
 * The contract that keeps them consistent with the dingbats they sit beside:
 *  - `currentColor` for stroke, so a button's `color` rule owns the icon.
 *    That is what makes --text-muted / --text-dim (:disabled) / :active work
 *    with no extra CSS, and it is why there is no `fill` or `color` here.
 *  - `em` sizing, so the icon tracks the button's own `font-size` token rather
 *    than pinning a px size the type scale cannot reach. --tap-min keeps the
 *    44px hit target regardless.
 *  - `aria-hidden`: the buttons already carry aria-label + title, and the icon
 *    must not add a second, competing accessible name.
 *
 * Geometry is deliberately plain — two semicircular returns for the clip, a
 * capsule over an arc for the mic. Both are drawn on a 24-unit grid so the
 * stroke widths line up with each other.
 */

const SIZE = '1.25em';

/** Shared presentation. Stroke-only: a filled icon would ignore `color`. */
const strokeProps = {
  width: SIZE,
  height: SIZE,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
} as const;

/** Attach an image. Replaces 📎. */
export function AttachIcon(): React.ReactElement {
  return (
    <svg {...strokeProps} data-icon="attach">
      <path d="M16.5 7.25V15.5a4.5 4.5 0 0 1-9 0V6.5a2.75 2.75 0 0 1 5.5 0v9.25a1.25 1.25 0 0 1-2.5 0V8.5" />
    </svg>
  );
}

/** Dictate with voice. Replaces 🎙. */
export function MicIcon(): React.ReactElement {
  return (
    <svg {...strokeProps} data-icon="mic">
      <rect x="9.25" y="2.5" width="5.5" height="10.5" rx="2.75" />
      <path d="M5.5 11v1a6.5 6.5 0 0 0 13 0v-1" />
      <path d="M12 18.5V21.5" />
      <path d="M8.5 21.5h7" />
    </svg>
  );
}
