/**
 * Permission card — the bridge's special='permission_request' entry (tool,
 * input summary, sub-agent origin), answered via a typed `permission-res`
 * command routed to the PermissionBroker. Content/interaction design ported
 * from the old PermissionRequestEntry: Allow / Always ("Allow domain" for web
 * tools) / Deny; resolved cards show the outcome inline (from the answering
 * tool_result, or the optimistic local response).
 */
import type { PermissionRequestDisplay } from '../displayEntries';
import type { CardActions } from './types';
import styles from './cards.module.css';

/** Compact one-line summary of the tool input (the card's subtitle). */
export function summarizeToolInput(toolName: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  const first = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const v = obj[key];
      if (typeof v === 'string' && v) return v;
    }
    return undefined;
  };
  const summary =
    first('command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'description') ??
    JSON.stringify(obj);
  return summary.length > 200 ? `${summary.slice(0, 200)}…` : summary;
}

export function PermissionCard({
  item,
  sessionId,
  responded,
  actions,
}: {
  item: PermissionRequestDisplay;
  sessionId: string;
  /** Optimistic local response already sent (uiStore). */
  responded: boolean;
  actions: CardActions;
}) {
  const inputSummary = summarizeToolInput(
    item.toolName,
    item.entry.metadata?.tool_input,
  );
  const originNote = item.isSubAgent
    ? `${item.agentLabel ? `${item.agentLabel} agent` : 'Sub-agent'} wants to run this`
    : null;

  // Resolved (proof: the answering tool_result reached the transcript).
  if (item.answered !== undefined) {
    const denied = /denied|deny/i.test(item.answered);
    return (
      <div className={styles.cardAnswered} data-row="permission">
        <div className={styles.title}>{item.toolName}</div>
        <div className={styles.desc}>{item.description}</div>
        <div className={denied ? styles.outcomeDenied : styles.outcomeAllowed}>
          {denied ? 'Denied' : 'Allowed'}
        </div>
      </div>
    );
  }

  if (responded) {
    return (
      <div className={styles.cardAnswered} data-row="permission">
        <div className={styles.title}>{item.toolName}</div>
        <div className={styles.desc}>{item.description}</div>
        <div className={styles.outcome}>Response sent…</div>
      </div>
    );
  }

  const isWebTool = item.toolName === 'WebFetch' || item.toolName === 'WebSearch';
  const alwaysLabel = isWebTool ? 'Allow domain' : 'Always allow';

  const respond = (allow: boolean, modifier?: 'always' | 'never'): void => {
    actions.markResponded(item.requestId);
    actions.sendCommand({
      type: 'permission-res',
      sessionId,
      requestId: item.requestId,
      allow,
      ...(modifier ? { modifier } : {}),
    });
  };

  return (
    <div className={styles.card} data-row="permission" aria-live="polite">
      <div className={styles.title}>Permission: {item.toolName}</div>
      {originNote && <div className={styles.origin}>{originNote}</div>}
      <div className={styles.desc}>{item.description}</div>
      {inputSummary && inputSummary !== item.description && (
        <div className={styles.inputSummary}>{inputSummary}</div>
      )}
      <div className={styles.actions}>
        <button className={styles.allowBtn} onClick={() => respond(true)}>
          Allow
        </button>
        <button className={styles.alwaysBtn} onClick={() => respond(true, 'always')}>
          {alwaysLabel}
        </button>
        <button className={styles.denyBtn} onClick={() => respond(false)}>
          Deny
        </button>
      </div>
    </div>
  );
}
