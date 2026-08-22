// @vitest-environment jsdom
/**
 * CDX-084: the composer's attach and mic controls are monochrome inline SVGs,
 * not colour emoji.
 *
 * The founder's report was specific — every other glyph in the chrome is a BMP
 * dingbat the text font draws monochrome, so the two emoji-presentation
 * codepoints (U+1F4CE clip, U+1F399 studio mic) were the only controls Android
 * painted in colour, and they read as pasted stickers.
 *
 * Two things are asserted, and the second is the one that actually prevents a
 * regression: the icons inherit `color` (so --text-muted / --text-dim /
 * :active keep working with no extra CSS), and NEITHER composer source
 * contains an emoji-presentation codepoint any more. A future edit that pastes
 * an emoji back into a button fails here rather than on a device.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DmBottomBar } from '../dm/DmBottomBar';
import { AttachIcon, MicIcon } from '../icons';

afterEach(cleanup);

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Emoji-presentation codepoints — the class of glyph that renders in colour. */
const EMOJI = /\p{Extended_Pictographic}/u;

describe('composer icons are monochrome SVGs', () => {
  it('both icons stroke with currentColor and carry no fill, so `color` owns them', () => {
    const { container } = render(
      <>
        <AttachIcon />
        <MicIcon />
      </>,
    );
    const svgs = [...container.querySelectorAll('svg')];
    expect(svgs).toHaveLength(2);
    for (const svg of svgs) {
      expect(svg.getAttribute('stroke')).toBe('currentColor');
      // A fill would ignore `color` and defeat the :disabled / :active states.
      expect(svg.getAttribute('fill')).toBe('none');
      // em sizing tracks the button's own font-size token rather than pinning
      // a px size the type scale cannot reach.
      expect(svg.getAttribute('width')).toMatch(/em$/);
      expect(svg.getAttribute('height')).toMatch(/em$/);
      // The buttons already own the accessible name via aria-label + title.
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('renders inside the DM bar buttons without changing their identity', () => {
    render(<DmBottomBar onSend={() => {}} onAttach={() => {}} />);
    const bar = screen.getByTestId('dm-bottom-bar');
    // The structural invariant dmUi/dmAttachmentsUi pin: controls stay DIRECT
    // children. An svg goes INSIDE the existing button, never in a wrapper.
    expect(bar.children).toHaveLength(4);

    for (const label of ['Attach image', 'Dictate with voice']) {
      const btn = screen.getByLabelText(label);
      expect(btn.tagName).toBe('BUTTON');
      expect(btn.getAttribute('title')).toBe(label);
      expect(btn.querySelector('svg')).toBeTruthy();
      expect(EMOJI.test(btn.textContent ?? '')).toBe(false);
    }
  });

  it('neither composer source carries an emoji-presentation codepoint', () => {
    for (const rel of ['../screens/SessionScreen.tsx', '../dm/DmBottomBar.tsx']) {
      const src = read(rel);
      const offender = [...src].find((ch) => EMOJI.test(ch));
      expect(offender, `${rel} still contains ${JSON.stringify(offender)}`).toBeUndefined();
    }
  });
});
