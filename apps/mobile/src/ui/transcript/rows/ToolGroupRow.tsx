/**
 * Collapsed turn activity — "N actions" summary, expandable to the raw
 * tool_use commands, tool_result previews, the model's thinking and any
 * collapsed assistant text (display_hint 'collapse' / sub-agent chatter).
 * Ported interaction design from the old OutputStream's ToolGroupEntry.
 *
 * CDX-085: thinking is rendered here rather than in a row of its own. Entries
 * keep their transcript order, so reasoning appears where it actually happened
 * — before the calls it motivated.
 */
import type { OutputEntry } from '../../../core/nativeCoreTypes';
import type { SeqEntry } from '../displayEntries';
import styles from './rows.module.css';

const PREVIEW_LIMIT = 600;

function preview(text: string): string {
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text;
}

/**
 * A redacted_thinking block carries no readable text (`content: ''`), so
 * without this it renders as a blank row inside the body.
 */
function isRedactedThinking(entry: OutputEntry): boolean {
  return entry.entryType === 'thinking' && entry.metadata?.redacted === true;
}

export function ToolGroupRow({
  entries,
  summary,
  expanded,
  onToggle,
}: {
  entries: SeqEntry[];
  summary: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={styles.toolgroup} data-row="tool-group">
      <button className={styles.groupHeader} onClick={onToggle} aria-expanded={expanded}>
        <span className={expanded ? styles.chevronOpen : styles.chevron}>▸</span>
        <span>{summary}</span>
      </button>
      {expanded && (
        <div className={styles.groupBody}>
          {entries.map(({ seq, entry }) => (
            <div key={seq} className={styles.toolItem} data-kind={entry.entryType}>
              {entry.entryType === 'tool_result' && <span>↳ </span>}
              {isRedactedThinking(entry) ? 'Thinking (redacted)' : preview(entry.content)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
