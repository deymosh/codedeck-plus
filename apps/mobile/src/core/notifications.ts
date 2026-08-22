/**
 * Notifications (Phase 5c) — app-local, store-driven attention events.
 *
 * Design rules (memory: yenn-android-notifications-plan — NEVER event-sniff):
 * - Every event here is derived from state the phone core ALREADY ingested
 *   through the typed protocol (live output entries, session-failed messages,
 *   DM store inserts). No relay-event sniffing, no kind-existence checks.
 * - The decision is a PURE function of (event, app visibility): a foregrounded
 *   app never notifies — the UI itself is the notification. Per-conversation
 *   unread is respected upstream: the DM store only reports messages that
 *   count unread (active conversation suppresses them).
 * - Sync catch-up entries never notify: only the LIVE output path classifies
 *   entries, so replaying history after a reconnect can't cause a storm.
 * - The OS side is a port (`Notifier` in ports.ts): Tauri's notification
 *   plugin in production, a spy in tests, absent in the headless core.
 */
import type { OutputEntry } from '@codedeck/protocol';
import type { Notifier } from './ports';
import { sessionKeyOf } from './stores/ui';

// --- Event vocabulary ---

export type NotifyEvent =
  | { type: 'permission-request'; machine: string; sessionId: string; toolName?: string }
  | { type: 'question'; machine: string; sessionId: string }
  | { type: 'plan-approval'; machine: string; sessionId: string }
  | { type: 'session-finished'; machine: string; sessionId: string }
  | { type: 'session-failed'; machine: string; sessionId: string; reason?: string }
  | { type: 'dm-received'; peer: string; peerLabel?: string; preview?: string };

/** Cooldown/dedup scope: same key + type within the window → one notification. */
export function notifyKey(event: NotifyEvent): string {
  return event.type === 'dm-received'
    ? `dm ${event.peer}`
    : `${event.type} ${event.machine} ${event.sessionId}`;
}

// --- Cancellation tags (CDX-026c) ---
// Coarser than notifyKey on purpose: opening a session should clear EVERY
// delivered notification for it (permission answered, question read, turn
// finished), and opening a DM conversation clears that peer's.

/** Cancellation scope for all of one session's notifications. */
export const sessionNotifyTag = (machine: string, sessionId: string): string =>
  `session ${sessionKeyOf(machine, sessionId)}`;

/** Cancellation scope for one DM peer's notifications. */
export const dmNotifyTag = (peer: string): string => `dm ${peer}`;

/** The tag a given event's delivery is filed under. */
export function notifyTag(event: NotifyEvent): string {
  return event.type === 'dm-received'
    ? dmNotifyTag(event.peer)
    : sessionNotifyTag(event.machine, event.sessionId);
}

// --- The pure decision: event × app-visibility → notify or not ---

/**
 * A visible (foregrounded) app never posts OS notifications — the user is
 * looking at the UI. Everything that reaches this function already passed its
 * store-level gate (DM unread counting, live-output-only classification), so
 * hidden → notify, for every event type.
 */
export function decideNotify(_event: NotifyEvent, visible: boolean): boolean {
  return !visible;
}

/**
 * The in-app attention chime's pure decision (old-app `notifyIfNeeded` gate):
 * ping when the app is hidden OR the user is viewing a DIFFERENT session than
 * the event's — a visible user watching exactly this session needs no chime,
 * the card on screen IS the signal.
 *
 * DM events carry no session key and already passed the per-conversation
 * unread gate upstream (an open conversation's messages are never emitted at
 * all) — so any DM event that reaches this decision is by construction
 * "not currently being viewed" and pings. This mirrors how decideNotify sees
 * DM events: the store-level gate did the viewing check.
 *
 * `activeSessionKey` is sessionKeyOf(machine, sessionId) of the session the
 * user is looking at, or null when no session panel is in view.
 */
export function decidePing(
  event: NotifyEvent,
  visible: boolean,
  activeSessionKey: string | null,
): boolean {
  if (!visible) return true;
  if (event.type === 'dm-received') return true;
  return sessionKeyOf(event.machine, event.sessionId) !== activeSessionKey;
}

// --- Formatting ---

export interface NotificationContent {
  title: string;
  body: string;
}

export function formatNotifyEvent(event: NotifyEvent): NotificationContent {
  switch (event.type) {
    case 'permission-request':
      return {
        title: 'Permission needed',
        body: event.toolName
          ? `Claude wants to use ${event.toolName}`
          : 'Claude needs permission to proceed',
      };
    case 'question':
      return { title: 'Question from Claude', body: 'Claude is asking you a question' };
    case 'plan-approval':
      return { title: 'Plan ready for review', body: 'A plan is waiting for your approval' };
    case 'session-finished':
      return { title: 'Session finished', body: 'Claude finished the task' };
    case 'session-failed':
      return {
        title: 'Session failed',
        body: event.reason ?? 'The session ended with an error',
      };
    case 'dm-received':
      return {
        title: event.peerLabel ?? 'New message',
        body: event.preview ?? 'You received a direct message',
      };
    default: {
      const exhaustive: never = event;
      void exhaustive;
      return { title: 'CodeDeck', body: 'Attention needed' };
    }
  }
}

// --- Live-output entry classification (permission / question / plan / end) ---

/**
 * Map ONE live output entry to a notify event, or null. Mirrors the
 * displayEntries vocabulary (system+special cards, stream_end, error
 * specials) — the transcript renderer and the notifier must agree on what an
 * entry means.
 */
export function classifyOutputEntry(
  machine: string,
  sessionId: string,
  entry: OutputEntry,
): NotifyEvent | null {
  const special = entry.metadata?.special as string | undefined;
  if (entry.entryType === 'system') {
    if (special === 'permission_request') {
      const toolName = entry.metadata?.tool_name as string | undefined;
      return {
        type: 'permission-request',
        machine,
        sessionId,
        ...(toolName !== undefined ? { toolName } : {}),
      };
    }
    if (special === 'ask_question') return { type: 'question', machine, sessionId };
    if (special === 'plan_approval') return { type: 'plan-approval', machine, sessionId };
    // Turn complete — the same marker the transcript hides and the unread dot
    // uses. metadata.stream_end is only ever set on live entries.
    if (!special && entry.metadata?.stream_end) {
      return { type: 'session-finished', machine, sessionId };
    }
    return null;
  }
  if (entry.entryType === 'error') {
    if (special === 'session_died' || special === 'session_failed') {
      return {
        type: 'session-failed',
        machine,
        sessionId,
        ...(entry.content ? { reason: entry.content } : {}),
      };
    }
    return null;
  }
  return null;
}

/**
 * CDX-053 — does this live entry prove the agent is ACTIVELY WORKING the turn?
 * Only such entries may auto-clear a session's unread dot (the old-app "agent
 * working — not waiting on us" nuance). Everything classifyOutputEntry maps to
 * an event marks; everything here clears; the REMAINDER — trailing system
 * status/result/usage lines and error entries — does neither. Pre-fix the
 * clear fired for every unclassified entry, so the trailing system entries a
 * finished turn emits right after its stream_end silently erased the
 * "finished while you were elsewhere" dot before anyone could see it.
 */
export function isAgentActivityEntry(entry: OutputEntry): boolean {
  switch (entry.entryType) {
    case 'text':
    case 'thinking':
    case 'tool_use':
    case 'tool_result':
    case 'progress':
    case 'diff':
      return true;
    default:
      // 'system' (status lines, token/result summaries) and 'error' are turn
      // ARTIFACTS, not activity — they must never eat an attention dot.
      return false;
  }
}

// --- Coordinator: decision + cooldown + formatting → the Notifier port ---

export const NOTIFY_COOLDOWN_MS = 10_000;

export interface NotificationCoordinatorDeps {
  notifier: Notifier;
  /** App visibility — the connection FSM already tracks it (debounced). */
  visible(): boolean;
  /** Master notifications toggle (CDX-048, settings store): when it reads
   *  false, NOTHING fires — neither the OS notification nor the ping chime,
   *  and no cooldown slot is burned. Absent → always enabled. */
  enabled?(): boolean;
  /** In-app attention chime (Web Audio in the platform layer). Deliberately
   *  independent of the notifier: it fires even when the OS notification
   *  permission was never granted. Absent → no chime. */
  ping?(): void;
  /** sessionKeyOf(machine, sessionId) of the session the user is viewing, or
   *  null (no session panel / DM panel in view). Feeds decidePing. */
  activeSessionKey?(): string | null;
  now?(): number;
  cooldownMs?: number;
}

export interface NotificationCoordinator {
  emit(event: NotifyEvent): void;
}

export function createNotificationCoordinator(
  deps: NotificationCoordinatorDeps,
): NotificationCoordinator {
  const now = deps.now ?? Date.now;
  const cooldownMs = deps.cooldownMs ?? NOTIFY_COOLDOWN_MS;
  const recent = new Map<string, number>();

  return {
    emit: (event) => {
      // CDX-048 master toggle: disabled kills BOTH delivery channels at the
      // single decision seam — no notify, no ping, no cooldown burned.
      if (deps.enabled && !deps.enabled()) return;
      const visible = deps.visible();
      const wantNotify = decideNotify(event, visible);
      const wantPing =
        deps.ping !== undefined &&
        decidePing(event, visible, deps.activeSessionKey ? deps.activeSessionKey() : null);
      if (!wantNotify && !wantPing) return;

      // ONE shared cooldown for the ping+notify pair — the live-output path
      // and the heartbeat-transition path (CDX-026b) can both emit for the
      // same card; this is what prevents the double-fire.
      const key = notifyKey(event);
      const at = now();
      const last = recent.get(key);
      if (last !== undefined && at - last < cooldownMs) return;
      recent.set(key, at);
      // Bounded memory: sweep expired keys once the map grows.
      if (recent.size > 64) {
        for (const [k, t] of recent) {
          if (at - t >= cooldownMs) recent.delete(k);
        }
      }

      // Ping BEFORE notify: the chime must fire regardless of what OS
      // delivery does (permission denied, plugin failure).
      if (wantPing) deps.ping?.();
      // The tag lets the platform cancel this delivery later (CDX-026c) when
      // the user opens the session / DM conversation in-app.
      if (wantNotify) deps.notifier.notify({ ...formatNotifyEvent(event), tag: notifyTag(event) });
    },
  };
}
