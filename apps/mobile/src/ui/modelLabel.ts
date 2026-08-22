/**
 * Compact model tags for the session header badge (CDX-087).
 *
 * Ported from the old app's `modelLabel` (codedeck/src/constants/models.ts:49-55),
 * which is what the founder remembers reading in the top-right rectangle:
 * `O5 · 11%`. The tag is deliberately terse — the badge shares a narrow header
 * row with the cwd, the connection state and the usage box.
 *
 * NOTE this is only a LABEL table. Unlike the old app, this one is not the
 * source of selectable models: the picker in NewSessionModal is populated from
 * what the bridge's SDK actually reports (`supportedModels()`), so a model
 * missing from the table still works — it just gets a derived tag. Adding a row
 * here changes presentation only.
 */

const TAGS: ReadonlyArray<readonly [string, string]> = [
  ['claude-opus-5', 'O5'],
  ['claude-opus-4-8', 'O4.8'],
  ['claude-opus-4-7', 'O4.7'],
  ['claude-sonnet-5', 'S5'],
  ['claude-sonnet-4-6', 'S4.6'],
  ['claude-haiku-4-5-20251001', 'H4.5'],
  ['claude-fable-5', 'F5'],
];

/**
 * The 1M-context beta variants carry a `[1m]` / `-1m` marker on the id
 * (`claude-opus-5[1m]`). The old app's table had no row for those, so they fell
 * through to the derived branch and rendered as `opus-5[1m]` — and the founder
 * is running one right now. Strip the marker before lookup: the 1M-ness is
 * already legible in the context figure beside it (`90k/1M`).
 */
const stripContextMarker = (id: string): string =>
  id.replace(/\[1m\]/i, '').replace(/-1m\b/i, '');

/**
 * Compact tag for a model id. `?` when the session has no model recorded —
 * honest rather than guessing, and the bridge capturing `init.model` is what
 * makes it rare (a session started on "Default model" reported nothing before).
 */
export function modelLabel(id: string | undefined): string {
  if (id === undefined || id === '') return '?';
  const base = stripContextMarker(id);
  const found = TAGS.find(([modelId]) => modelId === base);
  if (found) return found[1];
  // Unknown/custom model (a provider profile's id, a new release): strip the
  // vendor prefix and any date suffix for something that still fits the badge.
  return base.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}
