/**
 * Session sidebar (Phase 2a of the GUI-parity rework) — the old app's
 * one-screen composition: machine-grouped session cards with state left-border
 * + breathing attention dot, pending-session cards, pull-to-refresh, and the
 * status banners that used to live on MachinesScreen. The header carries the
 * settings gear and the pair action (per-machine "+" covers new sessions).
 *
 * Phase 2b: the bottom-pinned DM section (DmSection) replaced the interim
 * "Messages" footer button, and the per-machine "+" opens NewSessionModal
 * (folder/model/effort picker, CDX-031) instead of firing a zero-option
 * createSession.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionState } from '@codedeck/protocol';
import {
  useConnection,
  useMachines,
  usePendingSessions,
  usePhoneCore,
  useSettings,
  useUi,
} from './coreContext';
import { sessionKeyOf } from '../core/stores/ui';
import { sessionNeedsAttention } from '../core/sessionNeedsAttention';
import type { MachineView, SessionView } from '../core/stores/machines';
import { DmSection } from './DmSection';
import { orderedMachines, orderedSessions } from './getOrderedSessionKeys';
import { NewSessionModal } from './NewSessionModal';
import { relativeTime } from './relativeTime';
import { cx, shared as s, stateBadge } from './shared';
import { useSwipeToDelete } from './useSwipeToDelete';
import styles from './Sidebar.module.css';

const PULL_THRESHOLD = 60;
const MAX_PULL = 100;

/** State → left-border variant (waiting=white, running=muted, error=danger). */
function stateVariant(state: SessionState | undefined): string | undefined {
  if (state === 'waiting_permission' || state === 'waiting_question') return 'waiting';
  if (state === 'running') return 'running';
  return undefined;
}

function StatusDot({ state, isUnread }: { state: SessionState | undefined; isUnread: boolean }) {
  if (sessionNeedsAttention(state, isUnread)) {
    return <div className={styles.attentionDot} aria-label="Needs attention" />;
  }
  if (state === 'running') return <div className={styles.runningDot} />;
  return null;
}

function SessionCard({
  machine,
  session,
  isSelected,
  onSelected,
}: {
  machine: string;
  session: SessionView;
  isSelected: boolean;
  onSelected?: (() => void) | undefined;
}) {
  const core = usePhoneCore();
  const { info, presence } = session;
  const isUnread = useUi((st) => st.unreadSessions.has(sessionKeyOf(machine, info.id)));
  // CDX-048: the committed badge is gated by Settings → "Show commit badge".
  const showCommitBadge = useSettings((st) => st.showCommitBadge);
  // Swipe-left ≥80px commits an optimistic delete with a 4s undo (Phase 3).
  const { ref, touchHandlers } = useSwipeToDelete<HTMLButtonElement>(() =>
    core.deleteSession(machine, info.id, info.title || info.slug || 'Session'),
  );

  return (
    <div className={styles.swipeTrack}>
      <div className={styles.swipeBackdrop} aria-hidden="true">
        <span className={styles.swipeDeleteText}>Delete</span>
      </div>
      <button
        ref={ref}
        {...touchHandlers}
        className={cx(styles.sessionCard, styles.swipeCard, isSelected && styles.selected)}
        {...(stateVariant(info.state) ? { 'data-state': stateVariant(info.state) } : {})}
        data-testid="session-card"
        onClick={() => {
          core.ui.getState().selectSession(machine, info.id);
          onSelected?.();
        }}
      >
        <div className={styles.cardInfo}>
          <div className={styles.cardName}>{info.title || info.slug || info.id.slice(0, 8)}</div>
          <div className={styles.cardMeta}>
            <span className={styles.cardMetaText}>{info.project || info.cwd}</span>
            {presence !== 'live' && <span className={s.badgeOffline}>{presence}</span>}
            {showCommitBadge && info.committed && (
              <span className={styles.badgeCommitted}>committed</span>
            )}
            <span className={styles.cardTime}>{relativeTime(info.lastActivity)}</span>
          </div>
        </div>
        <StatusDot state={info.state} isUnread={isUnread} />
      </button>
    </div>
  );
}

function MachineGroup({
  machine,
  onSelected,
  onNewSession,
}: {
  machine: MachineView;
  onSelected?: (() => void) | undefined;
  /** "+" → NewSessionModal for this machine (Phase 2b, CDX-031). */
  onNewSession(machinePubkey: string): void;
}) {
  const core = usePhoneCore();
  const selectedMachine = useUi((st) => st.selectedMachine);
  const selectedSession = useUi((st) => st.selectedSession);
  const panelMode = useUi((st) => st.panelMode);
  const pending = usePendingSessions((st) => st.pending);

  const presence = core.connection.getState().presence(machine.pubkeyHex);

  // Shared with the swipe carousel (Phase 8) — order can never diverge.
  const sessions = orderedSessions(machine);

  const machinePending = Object.values(pending)
    .filter((p) => p.machine === machine.pubkeyHex)
    .sort((a, b) => a.seenAt - b.seenAt);

  return (
    <div>
      <div className={styles.groupHeading}>
        <span className={styles.presenceDot} data-presence={presence} data-testid="machine-presence" />
        <span className={styles.groupName}>{machine.name}</span>
        {machine.host && <span className={s.badge}>{machine.host}</span>}
        <button
          className={styles.addBtn}
          aria-label={`New session on ${machine.name}`}
          onClick={() => onNewSession(machine.pubkeyHex)}
        >
          +
        </button>
      </div>

      {machinePending.map((p) =>
        p.state === 'pending' ? (
          <div key={p.pendingId} className={styles.pendingCard}>
            <div className={s.cardTitleRow}>
              <span className={s.cardName}>Starting session…</span>
              <span className={stateBadge('running')}>pending</span>
            </div>
          </div>
        ) : (
          <FailedPendingCard key={p.pendingId} pendingId={p.pendingId} reason={p.reason} />
        ),
      )}

      {sessions.map((session) => (
        <SessionCard
          key={session.info.id}
          machine={machine.pubkeyHex}
          session={session}
          isSelected={
            panelMode === 'session' &&
            selectedMachine === machine.pubkeyHex &&
            selectedSession === session.info.id
          }
          onSelected={onSelected}
        />
      ))}

      {sessions.length === 0 && machinePending.length === 0 && (
        <div className={styles.emptyHint}>No sessions — tap + to start one.</div>
      )}
    </div>
  );
}

function FailedPendingCard({ pendingId, reason }: { pendingId: string; reason?: string | undefined }) {
  const core = usePhoneCore();
  return (
    <div className={styles.pendingFailed}>
      <div className={s.cardTitleRow}>
        <span className={s.cardName}>Session failed</span>
        <span className={stateBadge('waiting_permission')}>failed</span>
      </div>
      <div className={s.cardMeta}>{reason ?? 'unknown reason'}</div>
      <div className={styles.dismissRow}>
        <button
          className={s.btnSmall}
          onClick={() => core.pendingSessions.getState().dismiss(pendingId)}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

export function Sidebar({
  onOpenSettings,
  onOpenPairing,
  onSessionSelected,
}: {
  onOpenSettings(): void;
  onOpenPairing(): void;
  /** Narrow shell closes the drawer after a card (or conversation) tap. */
  onSessionSelected?: () => void;
}) {
  const core = usePhoneCore();
  const machines = useMachines((st) => st.machines);
  const status = useConnection((st) => st.status);
  const needsPairingCheck = useConnection((st) => st.needsPairingCheck);
  const pending = usePendingSessions((st) => st.pending);
  // NewSessionModal target (Phase 2b, CDX-031) — the tapped group's machine.
  const [newSessionFor, setNewSessionFor] = useState<string | null>(null);

  // Presence is f(heartbeat age): re-evaluate periodically even without events.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  // Shared with the swipe carousel (Phase 8) — order can never diverge.
  const machineList = orderedMachines(machines);
  const hasMachines = machineList.length > 0;

  // Failed pendings that never resolved to a machine (machine === '') — shown
  // once at the top, not under every group.
  const orphanFailed = Object.values(pending)
    .filter((p) => p.machine === '' && p.state === 'failed')
    .sort((a, b) => a.seenAt - b.seenAt);

  // --- Pull-to-refresh (ref-based, ported from the old Sidebar) ---
  const listRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const iconRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const touchStartY = useRef(0);
  const pullRef = useRef(0);
  const isPullingRef = useRef(false);
  const [refreshing, setRefreshing] = useState(false);

  const updateIndicator = useCallback((distance: number) => {
    const el = indicatorRef.current;
    if (!el) return;
    if (distance > 0) {
      el.style.height = `${distance}px`;
      el.style.display = 'flex';
      if (iconRef.current) {
        iconRef.current.textContent = distance >= PULL_THRESHOLD ? '↑' : '↓';
        iconRef.current.className =
          distance >= PULL_THRESHOLD ? styles.pullIconReady! : styles.pullIcon!;
      }
      if (textRef.current) {
        textRef.current.textContent =
          distance >= PULL_THRESHOLD ? 'Release to refresh' : 'Pull to refresh';
      }
    } else {
      el.style.height = '0px';
      el.style.display = 'none';
    }
  }, []);

  const refreshAll = useCallback((): void => {
    setRefreshing(true);
    const pubkeys = Object.keys(core.machines.getState().machines);
    void Promise.all(pubkeys.map((pk) => core.api.refreshSessions(pk))).finally(() =>
      setRefreshing(false),
    );
  }, [core]);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!hasMachines) return;
      const el = listRef.current;
      // scrollTop <= 0 handles both 0 and negative values (iOS bounce).
      if (el && el.scrollTop <= 0 && e.touches[0]) {
        touchStartY.current = e.touches[0].clientY;
        isPullingRef.current = true;
      }
    },
    [hasMachines],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!isPullingRef.current) return;
      const el = listRef.current;
      if (!el || el.scrollTop > 0 || !e.touches[0]) {
        isPullingRef.current = false;
        pullRef.current = 0;
        updateIndicator(0);
        return;
      }
      const dy = Math.max(0, e.touches[0].clientY - touchStartY.current);
      const dampened = Math.min(MAX_PULL, Math.sqrt(dy) * 5);
      pullRef.current = dampened;
      updateIndicator(dampened);
    },
    [updateIndicator],
  );

  const onTouchEnd = useCallback(() => {
    if (!isPullingRef.current) return;
    if (pullRef.current >= PULL_THRESHOLD && !refreshing) refreshAll();
    pullRef.current = 0;
    isPullingRef.current = false;
    updateIndicator(0);
  }, [refreshing, refreshAll, updateIndicator]);

  return (
    <div className={styles.sidebar} data-testid="sidebar">
      <div className={styles.header}>
        <span className={styles.title}>Sessions</span>
        <button className={styles.iconBtn} aria-label="Pair a machine" onClick={onOpenPairing}>
          ⊕
        </button>
        <button className={styles.iconBtn} aria-label="Settings" onClick={onOpenSettings}>
          ⚙
        </button>
      </div>

      {(needsPairingCheck || status !== 'connected') && (
        <div className={styles.banners}>
          {needsPairingCheck && (
            <div className={s.banner}>
              Some messages could not be decrypted — check that this phone is still paired with
              its bridges.
            </div>
          )}
          {status !== 'connected' && <div className={s.banner}>connection: {status}</div>}
        </div>
      )}

      <div
        className={styles.list}
        ref={listRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {hasMachines && (
          <div
            ref={indicatorRef}
            className={styles.pullIndicator}
            style={{ height: refreshing ? 32 : 0, display: refreshing ? 'flex' : 'none' }}
          >
            <span ref={iconRef} className={refreshing ? styles.pullIconSpinning : styles.pullIcon}>
              {refreshing ? '…' : '↓'}
            </span>
            <span ref={textRef}>{refreshing ? 'Refreshing…' : 'Pull to refresh'}</span>
          </div>
        )}

        {orphanFailed.map((p) => (
          <FailedPendingCard key={p.pendingId} pendingId={p.pendingId} reason={p.reason} />
        ))}

        {machineList.map((machine) => (
          <MachineGroup
            key={machine.pubkeyHex}
            machine={machine}
            onSelected={onSessionSelected}
            onNewSession={setNewSessionFor}
          />
        ))}

        {!hasMachines && (
          <div className={styles.empty}>
            <div>
              No machines paired yet.
              <br />
              Open a pairing window on a bridge (`codedeck pair` or the VSCode pairing screen),
              then pair from here.
            </div>
            <button className={s.btnPrimary} onClick={onOpenPairing}>
              Pair a machine
            </button>
          </div>
        )}
      </div>

      <DmSection onConversationSelected={onSessionSelected} />

      {newSessionFor !== null && (
        <NewSessionModal
          machinePubkey={newSessionFor}
          onClose={() => setNewSessionFor(null)}
        />
      )}
    </div>
  );
}
