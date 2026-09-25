/**
 * TranscriptView — the virtualized transcript (Phase 3c, bug C's cure).
 *
 * - virtua's VList: native dynamic row heights + content-shift compensation
 *   (replaces react-window + the measured-height hacks).
 * - useTranscriptPin: the SINGLE scroll owner. This component never calls
 *   scrollToBottom — it only forwards VList scroll events into the pin's
 *   reducer and renders the jump-to-bottom pill (with the missed-entry count)
 *   while unpinned.
 * - Rows come from the pure buildDisplayEntries transform over the
 *   transcriptStore, followed by the session's UNCOVERED outbox items — kept
 *   until a transcript user entry covers them (CDX-063: the input-ack lands
 *   before the SDK echo authors the entry, so ack alone must not hide the
 *   row) — plus a sync-gap placeholder while a sync cycle fills known gaps.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { VList, type VListHandle } from 'virtua';
import type { PhoneToBridgeMessage } from '../../core/nativeCoreTypes';
import { useMachines, useOutbox, usePhoneCore, useTranscript, useUi } from '../coreContext';
import { buildDisplayEntries, type DisplayEntry } from './displayEntries';
import { visibleOutboxItems } from './outboxCoverage';
import { useTranscriptPin } from './useTranscriptPin';
import type { CardActions } from './rows/types';
import { AssistantTextRow } from './rows/AssistantTextRow';
import { DiffRow } from './rows/DiffRow';
import { ErrorRow } from './rows/ErrorRow';
import { LifecycleRow } from './rows/LifecycleRow';
import { OutboxRow } from './rows/OutboxRow';
import { PermissionCard } from './rows/PermissionCard';
import { PlanApprovalCard } from './rows/PlanApprovalCard';
import { QuestionCard, QuestionGroupCard } from './rows/QuestionCard';
import { SyncGapRow } from './rows/SyncGapRow';
import { SystemRow } from './rows/SystemRow';
import { ToolGroupRow } from './rows/ToolGroupRow';
import { UserMessageRow } from './rows/UserMessageRow';
import styles from './TranscriptView.module.css';

const sessionKeyOf = (machine: string, sessionId: string): string => `${machine} ${sessionId}`;

function TranscriptRow({
  item,
  sessionId,
  expanded,
  onToggle,
  respondedCards,
  planChoices,
  actions,
}: {
  item: DisplayEntry;
  sessionId: string;
  expanded: boolean;
  onToggle: (seq: number) => void;
  respondedCards: ReadonlySet<string> | undefined;
  planChoices: Record<string, string>;
  actions: CardActions;
}) {
  switch (item.kind) {
    case 'user_message':
      return <UserMessageRow entry={item.entry} />;
    case 'assistant_message':
      return <AssistantTextRow entry={item.entry} {...(item.isPlan ? { isPlan: true } : {})} />;
    case 'tool_group':
      return (
        <ToolGroupRow
          entries={item.entries}
          summary={item.summary}
          expanded={expanded}
          onToggle={() => onToggle(item.seq)}
        />
      );
    case 'diff':
      return <DiffRow entry={item.entry} expanded={expanded} onToggle={() => onToggle(item.seq)} />;
    case 'error':
      return <ErrorRow entry={item.entry} />;
    case 'system':
      return <SystemRow entry={item.entry} />;
    case 'lifecycle':
      return <LifecycleRow entry={item.entry} />;
    case 'plan_approval':
      return (
        <PlanApprovalCard
          item={item}
          sessionId={sessionId}
          responded={!!item.toolUseId && (respondedCards?.has(item.toolUseId) ?? false)}
          choice={item.toolUseId ? planChoices[item.toolUseId] : undefined}
          actions={actions}
        />
      );
    case 'question':
      return (
        <QuestionCard
          item={item}
          sessionId={sessionId}
          responded={!!item.toolUseId && (respondedCards?.has(item.toolUseId) ?? false)}
          actions={actions}
        />
      );
    case 'question_group':
      return (
        <QuestionGroupCard
          item={item}
          sessionId={sessionId}
          respondedCards={respondedCards}
          actions={actions}
        />
      );
    case 'permission_request':
      return (
        <PermissionCard
          item={item}
          sessionId={sessionId}
          responded={respondedCards?.has(item.requestId) ?? false}
          actions={actions}
        />
      );
    default: {
      const exhaustive: never = item;
      void exhaustive;
      return null;
    }
  }
}

export function TranscriptView({
  machinePubkey,
  sessionId,
}: {
  machinePubkey: string;
  sessionId: string;
}) {
  const core = usePhoneCore();
  const sessionKey = sessionKeyOf(machinePubkey, sessionId);
  const transcript = useTranscript((s) => s.sessions[sessionKey]);
  const outboxItems = useOutbox((s) => s.items);
  const respondedCards = useUi((s) => s.respondedCards[sessionKey]);
  const planChoices = useUi((s) => s.planApprovalChoices);
  const seqHigh = useMachines(
    (s) => s.machines[machinePubkey]?.sessions[sessionId]?.info.seqHigh ?? 0,
  );

  const listRef = useRef<VListHandle>(null);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<number>>(new Set());
  const toggleGroup = useCallback((seq: number) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  }, []);

  const actions = useMemo<CardActions>(
    () => ({
      sendCommand: (msg: PhoneToBridgeMessage) => void core.api.send(machinePubkey, msg),
      markResponded: (cardId: string) =>
        core.ui.getState().markCardResponded(machinePubkey, sessionId, cardId),
      setPlanChoice: (cardId: string, key: string) =>
        core.ui.getState().setPlanApprovalChoice(cardId, key),
    }),
    [core, machinePubkey, sessionId],
  );

  const entries = useMemo(
    () =>
      transcript
        ? Object.entries(transcript.entries)
            .map(([seq, entry]) => ({ seq: Number(seq), entry }))
            .sort((a, b) => a.seq - b.seq)
        : [],
    [transcript],
  );
  const display = useMemo(() => buildDisplayEntries(entries), [entries]);

  // Sync-gap placeholder: a cycle is (re)filling ranges we know we miss.
  const syncState = transcript?.sync.state ?? 'idle';
  const hasKnownGap =
    (transcript?.localHigh ?? 0) < Math.max(seqHigh, transcript?.sync.target ?? 0) ||
    (transcript?.haveRanges.length ?? 0) > 1;
  const showSyncGap =
    hasKnownGap && (syncState === 'requested' || syncState === 'syncing' || syncState === 'failed');

  // CDX-063: the input-ack only proves the bridge RECEIVED the input — the
  // user's transcript entry is authored later by the SDK echo on ephemeral
  // 24515 and can drop. A row therefore stays until the transcript CONTAINS a
  // covering user entry (live echo or sync backfill); coverage pairing keeps
  // the row and its own echo from ever rendering together. An aged-out
  // confirmed row is dropped once the transcript is contiguous — the ack is
  // proof enough and there is no echo left to wait for (see outboxCoverage).
  const pendingOutbox = useMemo(
    () =>
      visibleOutboxItems(outboxItems, machinePubkey, sessionId, entries, {
        now: Date.now(),
        transcriptContiguous: !hasKnownGap,
      }),
    [outboxItems, machinePubkey, sessionId, entries, hasKnownGap],
  );

  const itemCount = display.length + pendingOutbox.length + (showSyncGap ? 1 : 0);
  const pin = useTranscriptPin({ listRef, itemCount, sessionKey });

  if (itemCount === 0) {
    return (
      <div className={styles.emptyView}>
        <div className={styles.emptyText}>
          {syncState === 'requested' || syncState === 'syncing'
            ? 'Syncing transcript…'
            : 'No transcript yet — send a message to start.'}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.view} role="log" aria-label="Session transcript">
      <VList
        ref={listRef}
        style={{ height: '100%' }}
        onScroll={pin.onScroll}
        onScrollEnd={pin.onScrollEnd}
      >
        {[
          ...(showSyncGap
            ? [<SyncGapRow key="sync-gap" state={syncState === 'failed' ? 'failed' : 'syncing'} />]
            : []),
          ...display.map((item) => (
            <TranscriptRow
              key={`e${item.seq}`}
              item={item}
              sessionId={sessionId}
              expanded={
                (item.kind === 'tool_group' || item.kind === 'diff') &&
                expandedGroups.has(item.seq)
              }
              onToggle={toggleGroup}
              respondedCards={respondedCards}
              planChoices={planChoices}
              actions={actions}
            />
          )),
          ...pendingOutbox.map((item) => (
            <OutboxRow
              key={`o${item.id}`}
              item={item}
              onRetry={(id) => void core.outbox.getState().retry(id)}
            />
          )),
        ]}
      </VList>
      {!pin.pinned && (
        <button className={styles.jumpPill} onClick={pin.jumpToBottom}>
          ↓{pin.missedEntries > 0 ? ` ${pin.missedEntries} new` : ' Latest'}
        </button>
      )}
    </div>
  );
}
