/**
 * Main panel (Phase 2a) — the right pane of the one-screen shell. Switches on
 * the ui store's panelMode + selections: session → SessionScreen, dm →
 * DmChatScreen, marmot → MarmotChatScreen, else an empty-state placeholder.
 * The chat screens keep their own prop shapes; only the call site adapted.
 *
 * Phase 8: horizontal swipe carousel (touch devices). In session mode the
 * hook translates SessionScreen's slide region (header + GsdStrip +
 * transcript) while the permission/input bars stay static; sessions CLAMP at
 * the edges of the sidebar's exact display order (shared
 * getOrderedSessionKeys). In dm/marmot mode the whole chat slides and the
 * unified conversation list (DmSection's order) WRAPS. Navigation goes
 * through the ui store's selectSession/selectDmPeer/selectMarmotGroup — the
 * transcript pin's session-switch reset (CDX-024) then lands the new session
 * at the bottom; the carousel itself never scrolls the transcript.
 */
import { useMemo, type ReactNode } from 'react';
import { unifiedConversations } from '../core/stores/marmot';
import { useDm, useMachines, useMarmot, usePhoneCore, useUi } from './coreContext';
import { DmChatScreen } from './dm/DmChatScreen';
import { MarmotChatScreen } from './dm/MarmotChatScreen';
import { getOrderedSessionKeys } from './getOrderedSessionKeys';
import { SessionScreen } from './screens/SessionScreen';
import { shared as s } from './shared';
import { useSwipeToNavigate } from './useSwipeToNavigate';
import styles from './MainPanel.module.css';

/** One swipe-carousel stop: identity key + how to select it in the ui store. */
interface NavItem {
  key: string;
  select(): void;
}

export function MainPanel({
  isWide,
  onOpenSidebar,
}: {
  isWide: boolean;
  onOpenSidebar(): void;
}) {
  const core = usePhoneCore();
  const panelMode = useUi((st) => st.panelMode);
  const selectedMachine = useUi((st) => st.selectedMachine);
  const selectedSession = useUi((st) => st.selectedSession);
  const activeDmPeer = useUi((st) => st.activeDmPeer);
  const activeMarmotGroup = useUi((st) => st.activeMarmotGroup);

  const machines = useMachines((st) => st.machines);
  const dmConversations = useDm((st) => st.conversations);
  const marmotConversations = useMarmot((st) => st.conversations);

  // Session carousel order = the sidebar's exact display order (shared fn —
  // structurally incapable of diverging). Clamps at the edges.
  const sessionItems = useMemo<NavItem[]>(
    () =>
      getOrderedSessionKeys(machines).map((k) => ({
        key: `${k.machine} ${k.sessionId}`,
        select: () => core.ui.getState().selectSession(k.machine, k.sessionId),
      })),
    [machines, core],
  );

  // DM/Marmot carousel order = DmSection's unified display order. Wraps.
  const conversationItems = useMemo<NavItem[]>(
    () =>
      unifiedConversations(dmConversations, marmotConversations).map((c) => ({
        key: `${c.protocol}:${c.key}`,
        select:
          c.protocol === 'marmot'
            ? () => core.ui.getState().selectMarmotGroup(c.key)
            : () => core.ui.getState().selectDmPeer(c.key),
      })),
    [dmConversations, marmotConversations, core],
  );

  const inSession = panelMode === 'session';
  const items = inSession ? sessionItems : conversationItems;
  const currentKey = inSession
    ? selectedMachine && selectedSession
      ? `${selectedMachine} ${selectedSession}`
      : null
    : panelMode === 'dm'
      ? activeDmPeer && `nip17:${activeDmPeer}`
      : activeMarmotGroup && `marmot:${activeMarmotGroup}`;
  const currentIndex = currentKey ? items.findIndex((i) => i.key === currentKey) : -1;

  const { sliderRef, touchHandlers } = useSwipeToNavigate({
    items,
    currentIndex,
    wrap: !inSession, // sessions clamp; DM/Marmot conversations cycle
    onNavigate: (index) => items[index]?.select(),
  });

  // Chats have no own header row to host a ☰ (Phase 2b restyles them); a slim
  // bar keeps the drawer reachable on narrow.
  const chatBar = !isWide && (
    <div className={styles.chatBar}>
      <button className={styles.menuBtn} aria-label="Open sessions" onClick={onOpenSidebar}>
        ☰
      </button>
    </div>
  );

  let content: ReactNode;
  if (panelMode === 'session' && selectedMachine && selectedSession) {
    // Only SessionScreen's slide region translates — its input bar is static.
    //
    // CDX-086: the `key` scopes the composer to ONE session. Without it React
    // reuses the instance across a session switch, so `draft`, the staged
    // attachment and the upload spinner are component state while
    // machinePubkey/sessionId are props — type in session A, swipe to B, press
    // Send, and A's text is delivered to B. A wedged upload also followed the
    // user everywhere, and a late write-back could clear a DIFFERENT session's
    // composer.
    content = (
      <SessionScreen
        key={`${selectedMachine} ${selectedSession}`}
        machinePubkey={selectedMachine}
        sessionId={selectedSession}
        slideRef={sliderRef}
        {...(!isWide ? { onMenu: onOpenSidebar } : {})}
      />
    );
  } else if (panelMode === 'dm' && activeDmPeer) {
    // DM keeps the whole view in the slider (old-app behaviour: its input
    // slides along with the conversation).
    content = (
      <div ref={sliderRef} className={styles.slide} data-testid="chat-slide">
        {chatBar}
        <DmChatScreen peerPubkey={activeDmPeer} />
      </div>
    );
  } else if (panelMode === 'marmot' && activeMarmotGroup) {
    content = (
      <div ref={sliderRef} className={styles.slide} data-testid="chat-slide">
        {chatBar}
        <MarmotChatScreen groupId={activeMarmotGroup} />
      </div>
    );
  } else {
    content = (
      <div className={styles.empty} data-testid="main-panel-empty">
        <span>Select a session</span>
        {!isWide && (
          <button className={s.btn} onClick={onOpenSidebar}>
            ☰ Sessions
          </button>
        )}
      </div>
    );
  }

  // Touch handlers live on the whole panel so a swipe can start anywhere —
  // including over the static input bar (old-app design).
  return (
    <div className={styles.panel} data-testid="main-panel" {...touchHandlers}>
      {content}
    </div>
  );
}
