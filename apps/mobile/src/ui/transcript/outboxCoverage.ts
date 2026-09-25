/**
 * outboxCoverage (CDX-063) — own messages must not vanish between the bridge's
 * input-ack and the SDK's user-entry echo.
 *
 * The wire truth: the bridge acks an input the moment `runner.sendInput`
 * accepts it (packages/core/src/bridge.ts onInput) — BEFORE any transcript
 * entry exists. The user's transcript row is only authored when the SDK echoes
 * the message back, and that echo travels as a LIVE entry on ephemeral kind
 * 24515. A dropped ephemeral (or a dead subscription) means the ack arrives
 * and the entry does not — pre-fix the TranscriptView hid the optimistic
 * outbox row on `state === 'confirmed'`, so the user's message visibly
 * disappeared until a sync backfill, or forever.
 *
 * The rule here: an outbox row stays visible until the transcript actually
 * CONTAINS a covering user entry for it. Coverage is a text match with
 * pairing (each transcript entry covers at most ONE outbox item, oldest
 * first), so the row and its own echo never render together, and two
 * identical sends need two echoes before both rows hide. The bridge appends a
 * one-shot emit-session-meta HTML comment to the first ordinary message
 * before the SDK sees it (packages/core/src/session/runner.ts:712), so the
 * echo can be the typed text plus a trailing comment — covered by the
 * prefix+comment rule, never by a bare prefix match.
 *
 * Known residuals (accepted):
 * - CDX-013 retention: confirmed items beyond the 200-item outbox cap are
 *   evictable, so an evicted-but-uncovered row disappearing is possible only
 *   beyond that cap.
 * - An input sent while the broker had a pending question is consumed as the
 *   question's ANSWER (runner.sendInput's first branch) — it surfaces in the
 *   answered question card, not as a user entry, so its row stays visible
 *   as delivered-but-unechoed. Rare, and honest about where the text went.
 *
 * Aging (the "old sends pile up at the bottom as delivered" fix): CDX-063's
 * "keep the row until an entry covers it" is about the SECONDS between the
 * input-ack and the SDK echo. A `confirmed` item that is still uncovered long
 * after that — and whose session transcript we now hold CONTIGUOUSLY, i.e. we
 * have everything the bridge has and the echo is not among it (bridge retention
 * pruned the early seqs, the echo was a lost ephemeral a completed sync could
 * not backfill, or the text was transformed so no entry can ever match) — has
 * nothing left to wait for. The ack already proved delivery, so past
 * OUTBOX_ECHO_GRACE_MS such a row is dropped instead of floating below the whole
 * transcript forever. Rows still shown regardless of age: pending / published /
 * failed, and confirmed rows while a sync gap could still deliver the echo.
 */
import type { OutputEntry } from '../../core/nativeCoreTypes';
import type { OutboxItem } from '../../core/stores/outbox';

export interface UserEntryLite {
  seq: number;
  content: string;
}

export interface SeqEntryLite {
  seq: number;
  entry: OutputEntry;
}

/** The session's user-role text entries (SDK echo / sync backfill rows). */
export function userEntriesOf(entries: readonly SeqEntryLite[]): UserEntryLite[] {
  return entries
    .filter(({ entry }) => entry.entryType === 'text' && entry.metadata?.['role'] === 'user')
    .map(({ seq, entry }) => ({ seq, content: entry.content }));
}

const normalize = (text: string): string => text.replace(/\r\n/g, '\n').trim();

/**
 * The covering rule itself, over text BOTH sides of which are already
 * normalized. Split out so the pairing loop can normalize each side once
 * instead of once per candidate pair (see `coveredOutboxIds`); the rule is
 * byte-for-byte the one `entryCovers` has always applied.
 */
function coversNormalized(entry: string, item: string): boolean {
  if (item === '') return false;
  if (entry === item) return true;
  if (!entry.startsWith(item)) return false;
  return entry.slice(item.length).trimStart().startsWith('<!--');
}

/**
 * Does this transcript user entry cover this outbox item? Exact text match
 * after normalization, or the item text followed by a bridge-appended HTML
 * comment (the emit-session-meta instruction) — never a bare prefix, so an
 * older send that happens to be a prefix of a newer one cannot cover it.
 */
export function entryCovers(entryContent: string, itemText: string): boolean {
  return coversNormalized(normalize(entryContent), normalize(itemText));
}

/**
 * Pair outbox items (createdAt order) against user entries (seq order); each
 * entry consumes at most one item. Returns the ids whose row is covered —
 * regardless of outbox state: a covering entry is proof of delivery even for
 * an item the sweep had marked failed (lost ack, delivered anyway).
 *
 * Each side is normalized ONCE, up front, and the inner loop compares already-
 * normalized strings. It used to normalize both operands inside the comparison,
 * i.e. per candidate PAIR: a full 200-item outbox against a few hundred user
 * entries is ~100k regex-replace+trim pairs, and `pendingOutbox` recomputes on
 * every `entries` change — that is once per streamed output entry, during
 * exactly the moments the phone is busiest. The pairing itself is unchanged.
 */
export function coveredOutboxIds(
  items: readonly OutboxItem[],
  userEntries: readonly UserEntryLite[],
): ReadonlySet<string> {
  const orderedItems = [...items]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((i) => ({ id: i.id, text: normalize(i.text) }));
  const orderedEntries = [...userEntries]
    .sort((a, b) => a.seq - b.seq)
    .map((e) => normalize(e.content));
  const used = new Array<boolean>(orderedEntries.length).fill(false);
  const covered = new Set<string>();
  for (const item of orderedItems) {
    for (let i = 0; i < orderedEntries.length; i++) {
      if (used[i]) continue;
      if (coversNormalized(orderedEntries[i]!, item.text)) {
        used[i] = true;
        covered.add(item.id);
        break;
      }
    }
  }
  return covered;
}

/**
 * How long after the input-ack a still-uncovered `confirmed` row is kept
 * visible. Comfortably past the outbox confirm timeout (30s) so a confirmed
 * item has had a full sweep cycle plus margin to receive its echo.
 */
export const OUTBOX_ECHO_GRACE_MS = 45_000;

export interface VisibleOutboxOptions {
  /** Current time (ms). */
  now: number;
  /** True when the session transcript covers 1..seqHigh with no known gaps —
   *  i.e. a sync could no longer backfill a missing echo. */
  transcriptContiguous: boolean;
}

/**
 * The outbox rows TranscriptView renders after the transcript: every one of
 * the session's items — whatever its ack state — that no transcript user
 * entry covers yet, oldest first. (Pre-CDX-063 this was `state !==
 * 'confirmed'`, which made the ack hide the row before the entry existed.)
 *
 * With `opts`, an aged-out `confirmed`-but-uncovered row is also dropped once
 * the transcript is contiguous (see the aging note in the file header) — this
 * is what stops old sends from stacking below the whole transcript as
 * "delivered". Without `opts` the behaviour is unchanged (every uncovered item
 * is returned), so existing callers keep working.
 */
export function visibleOutboxItems(
  items: Record<string, OutboxItem>,
  machine: string,
  sessionId: string,
  entries: readonly SeqEntryLite[],
  opts?: VisibleOutboxOptions,
): OutboxItem[] {
  const sessionItems = Object.values(items)
    .filter((i) => i.machine === machine && i.sessionId === sessionId)
    .sort((a, b) => a.createdAt - b.createdAt);
  if (sessionItems.length === 0) return [];
  const covered = coveredOutboxIds(sessionItems, userEntriesOf(entries));
  return sessionItems.filter((i) => {
    if (covered.has(i.id)) return false;
    if (opts && i.state === 'confirmed' && opts.transcriptContiguous) {
      const confirmedAt = i.confirmedAt ?? i.createdAt;
      if (opts.now - confirmedAt >= OUTBOX_ECHO_GRACE_MS) return false;
    }
    return true;
  });
}
