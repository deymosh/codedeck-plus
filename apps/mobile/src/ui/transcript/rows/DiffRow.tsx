/**
 * Diff card (CDX-050) — a file edit rendered as the legacy app did: filename
 * header + monospace colored lines (+ green, − red, context muted).
 *
 * Long diffs collapse beyond COLLAPSE_AT lines behind an "N more lines"
 * expander (phone screens; the wire itself is already capped bridge-side).
 * Expansion state lives in the parent's expandedGroups set (like
 * ToolGroupRow) so it survives virtua unmounting the row.
 */
import type { DiffLine, OutputEntry } from '@codedeck/protocol';
import styles from './rows.module.css';

export const DIFF_COLLAPSE_AT = 40;

/** Legacy-style fallback: reconstruct lines from the +/− prefixed `content`
 *  when the structured payload is missing (defensive; should not happen). */
function linesFromContent(content: string): DiffLine[] {
  if (!content) return [];
  return content.split('\n').map((line) => {
    if (line.startsWith('+')) return { type: 'add' as const, text: line.slice(1) };
    if (line.startsWith('-')) return { type: 'del' as const, text: line.slice(1) };
    return { type: 'context' as const, text: line.startsWith(' ') ? line.slice(1) : line };
  });
}

const LINE_PREFIX: Record<DiffLine['type'], string> = { add: '+', del: '-', context: ' ' };
const LINE_CLASS = (t: DiffLine['type']): string =>
  t === 'add' ? styles.diffLineAdd! : t === 'del' ? styles.diffLineDel! : styles.diffLineContext!;

export function DiffRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: OutputEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const lines = entry.diff?.lines ?? linesFromContent(entry.content);
  const path = entry.diff?.path ?? String(entry.metadata?.filename ?? '');
  const overflow = lines.length - DIFF_COLLAPSE_AT;
  const visible = expanded || overflow <= 0 ? lines : lines.slice(0, DIFF_COLLAPSE_AT);

  return (
    <div className={styles.diff} data-row="diff">
      {path ? (
        <div className={styles.diffHeader}>
          {path}
          {entry.diff?.truncated ? <span className={styles.diffTruncated}> (truncated)</span> : null}
        </div>
      ) : null}
      <div className={styles.diffBody}>
        {visible.map((line, i) => (
          <div key={i} className={LINE_CLASS(line.type)}>
            {LINE_PREFIX[line.type]}
            {line.text}
          </div>
        ))}
      </div>
      {overflow > 0 && (
        <button className={styles.diffExpander} onClick={onToggle} aria-expanded={expanded}>
          {expanded ? 'Show less' : `${overflow} more line${overflow !== 1 ? 's' : ''}`}
        </button>
      )}
    </div>
  );
}
