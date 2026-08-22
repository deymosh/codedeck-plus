/**
 * CDX-089: the draft-append rule shared by the session mic, the DM mic and the
 * session quick-prompt bar. It was inlined identically at all three with no test.
 *
 * Note what this canNOT test: the dictation truncation the founder reported
 * happens INSIDE Android's one-shot recognizer, which returns half a sentence.
 * This function faithfully appends whatever it is handed. The truncation oracle
 * is on-device.
 */
import { describe, expect, it } from 'vitest';
import { appendToDraft } from '../appendToDraft';

describe('appendToDraft', () => {
  it('an empty draft takes the fragment verbatim', () => {
    expect(appendToDraft('', 'hello there')).toBe('hello there');
  });

  it('joins with exactly one space, absorbing the draft trailing whitespace', () => {
    expect(appendToDraft('hello', 'there')).toBe('hello there');
    expect(appendToDraft('hello ', 'there')).toBe('hello there');
    expect(appendToDraft('hello   ', 'there')).toBe('hello there');
    expect(appendToDraft('hello\n\n', 'there')).toBe('hello there');
  });

  it('a whitespace-only draft yields no leading space', () => {
    // The pre-extraction inline version produced ' hello' here: stripping the
    // trailing whitespace left '' and the separator was still added.
    expect(appendToDraft('   ', 'hello')).toBe('hello');
    expect(appendToDraft('\n', 'hello')).toBe('hello');
  });

  it('leaves the draft interior and the fragment untouched', () => {
    // Multi-line drafts and internal spacing are the user's, not ours to tidy.
    expect(appendToDraft('line one\n\nline two', 'and three')).toBe(
      'line one\n\nline two and three',
    );
    expect(appendToDraft('a', '  spaced  ')).toBe('a   spaced  ');
  });

  it('successive appends compose, which is what repeated dictation does', () => {
    let d = '';
    for (const part of ['so can you check', 'which blossom server', 'it is using']) {
      d = appendToDraft(d, part);
    }
    expect(d).toBe('so can you check which blossom server it is using');
  });
});
