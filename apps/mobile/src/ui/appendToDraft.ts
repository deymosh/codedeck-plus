/**
 * appendToDraft — join a fragment onto an existing composer draft (CDX-089).
 *
 * The same three-part rule was inlined at three call sites (the session mic, the
 * DM mic, and the session quick-prompt bar) with no test between them: empty
 * draft takes the fragment verbatim, otherwise strip the draft's trailing
 * whitespace and join with exactly one space.
 *
 * Extracted while looking at dictation truncation. It is NOT the cause of that
 * bug — the recognizer returns half a sentence and this appends exactly what it
 * was given — but it is the one part of the mic path that host tests can own,
 * and it had zero coverage.
 *
 * ONE deliberate behaviour change while extracting: the emptiness check is now
 * `trim() === ''` rather than `=== ''`. A whitespace-only draft used to fall
 * down the join branch and produce a LEADING space (`' hello'`), because
 * stripping its trailing whitespace left an empty string that still got a
 * separator. Whitespace-only now takes the fragment verbatim like empty does.
 */

/**
 * @param draft    the current draft (may be empty or whitespace-only)
 * @param fragment text to append; callers should skip empty/null fragments
 */
export function appendToDraft(draft: string, fragment: string): string {
  if (draft.trim() === '') return fragment;
  return `${draft.replace(/\s+$/, '')} ${fragment}`;
}
