/**
 * Sidebar DM section (Phase 2b) — the old app's bottom-pinned `.dm-section`,
 * replacing the interim "Messages (n)" footer button + DM-list overlay:
 * border-top block with a header row (DM-subscription connection dot +
 * "Messages" + a "+" that toggles the inline new-DM input), then an own-scroll
 * list (max ~18rem) of unified NIP-17 + Marmot tiles sorted by last activity,
 * pending Marmot welcome cards on top. Tapping a tile selects the conversation
 * in the ui store (panelMode flips, MainPanel shows the chat) and closes the
 * drawer on narrow.
 *
 * Keyboard nicety (ported): [data-keyboard-open] on :root (useKeyboardInset
 * writes it) collapses the section via CSS while a session — not a DM — is in
 * view, so the session input bar keeps its room. The section marks itself
 * "active" (data-active) when a DM surface is open or the new-DM input is up.
 */
import { useEffect, useState } from 'react';
import { useDm, useMarmot, usePhoneCore, useUi } from './coreContext';
import { parsePeerInput } from '../core/stores/dm';
import { unifiedConversations } from '../core/stores/marmot';
import { DmTile, WelcomeCard, type ConversationTarget } from './DmTile';
import { cx, shared as s } from './shared';
import styles from './Sidebar.module.css';

export function DmSection({
  onConversationSelected,
}: {
  /** Narrow shell closes the drawer after a conversation tap. */
  onConversationSelected?: (() => void) | undefined;
}) {
  const core = usePhoneCore();
  const conversations = useDm((st) => st.conversations);
  const subscribed = useDm((st) => st.subscribed);
  const startConversation = useDm((st) => st.startConversation);
  const resolveAllProfiles = useDm((st) => st.resolveAllProfiles);
  const resolveProfile = useDm((st) => st.resolveProfile);

  const marmotConversations = useMarmot((st) => st.conversations);
  const marmotAvailable = useMarmot((st) => st.available);
  const pendingWelcomes = useMarmot((st) => st.pendingWelcomes);
  const startMarmotChat = useMarmot((st) => st.startChat);

  const panelMode = useUi((st) => st.panelMode);
  const activeDmPeer = useUi((st) => st.activeDmPeer);
  const activeMarmotGroup = useUi((st) => st.activeMarmotGroup);

  const [showNew, setShowNew] = useState(false);
  const [peerInput, setPeerInput] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [startingMarmot, setStartingMarmot] = useState(false);

  // Resolve (or refresh stale) profiles for every peer once mounted; Marmot
  // peers live outside the dm store — resolve them too.
  useEffect(() => {
    resolveAllProfiles();
  }, [resolveAllProfiles]);
  useEffect(() => {
    for (const conv of Object.values(marmotConversations)) {
      if (conv.peerPubkey) void resolveProfile(conv.peerPubkey);
    }
  }, [marmotConversations, resolveProfile]);

  const list = unifiedConversations(conversations, marmotConversations);
  const welcomes = Object.values(pendingWelcomes);
  // Per-row protocol tags earn their width only when the list actually mixes
  // protocols; on a single-protocol list they are noise the name pays for.
  const mixedProtocols =
    list.some((c) => c.protocol === 'marmot') && list.some((c) => c.protocol === 'nip17');

  const open = (target: ConversationTarget): void => {
    if (target.protocol === 'marmot') {
      core.ui.getState().selectMarmotGroup(target.groupId);
    } else {
      core.ui.getState().selectDmPeer(target.peer);
    }
    onConversationSelected?.();
  };

  const closeNew = (): void => {
    setShowNew(false);
    setPeerInput('');
    setInputError(null);
  };

  const beginConversation = (): void => {
    const peer = startConversation(peerInput);
    if (peer === null) {
      setInputError('Not a valid npub or hex pubkey');
      return;
    }
    closeNew();
    open({ protocol: 'nip17', peer });
  };

  const beginMarmotConversation = (): void => {
    // Pure parse (same rules as NIP-17) — deliberately NOT startConversation:
    // a Marmot chat only exists once the MLS group does.
    const peer = parsePeerInput(peerInput);
    if (peer === null) {
      setInputError('Not a valid npub or hex pubkey');
      return;
    }
    setStartingMarmot(true);
    void startMarmotChat(peer)
      .then((result) => {
        if (result.ok) {
          closeNew();
          open({ protocol: 'marmot', groupId: result.groupId });
        } else if (result.reason === 'no-key-package') {
          setInputError('Peer has no published Marmot KeyPackage — use NIP-17 instead');
        } else {
          setInputError('Could not start the Marmot chat — try again');
        }
      })
      .finally(() => setStartingMarmot(false));
  };

  const isActive = panelMode === 'dm' || panelMode === 'marmot' || showNew;
  const isSelected = (conv: { protocol: string; key: string }): boolean =>
    conv.protocol === 'marmot'
      ? panelMode === 'marmot' && activeMarmotGroup === conv.key
      : panelMode === 'dm' && activeDmPeer === conv.key;

  return (
    <div
      className={styles.dmSection}
      data-active={isActive || undefined}
      data-testid="dm-section"
    >
      <div className={styles.dmHeader}>
        <span className={styles.dmTitle}>
          <span
            className={styles.dmConnDot}
            data-connected={subscribed}
            data-testid="dm-connection-dot"
            title={subscribed ? 'DM subscription connected' : 'DM subscription not connected'}
          />
          Messages
        </span>
        <button
          className={styles.addBtn}
          aria-label="New message"
          onClick={() => (showNew ? closeNew() : setShowNew(true))}
        >
          +
        </button>
      </div>

      {showNew && (
        <div className={styles.dmNew}>
          <input
            className={cx(s.input, s.mono)}
            placeholder="npub… or 64-char hex pubkey"
            value={peerInput}
            autoFocus
            onChange={(e) => {
              setPeerInput(e.target.value);
              setInputError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') beginConversation();
            }}
          />
          {inputError && <div className={s.bannerError}>{inputError}</div>}
          <div className={s.row}>
            <button className={cx(s.btnPrimary, s.grow)} onClick={beginConversation}>
              Start conversation
            </button>
            <button className={s.btn} onClick={closeNew}>
              Cancel
            </button>
          </div>
          {marmotAvailable && (
            <button
              className={s.btn}
              disabled={startingMarmot}
              onClick={beginMarmotConversation}
              data-testid="start-marmot"
            >
              {startingMarmot ? 'Looking up KeyPackage…' : 'Start Marmot (MLS) chat instead'}
            </button>
          )}
        </div>
      )}

      <div className={styles.dmList}>
        {welcomes.map((welcome) => (
          <WelcomeCard key={welcome.welcomeId} welcome={welcome} />
        ))}

        {list.map((conversation) => (
          <DmTile
            key={`${conversation.protocol}:${conversation.key}`}
            conversation={conversation}
            isSelected={isSelected(conversation)}
            showProtocol={mixedProtocols}
            onOpen={open}
          />
        ))}

        {list.length === 0 && welcomes.length === 0 && !showNew && (
          <div className={styles.dmEmpty}>No conversations yet.</div>
        )}
      </div>
    </div>
  );
}
