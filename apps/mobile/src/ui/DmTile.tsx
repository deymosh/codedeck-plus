/**
 * DmTile (Phase 2b) — ONE conversation tile for the unified NIP-17 + Marmot
 * list, extracted from the retired DmListScreen so the sidebar DM section (and
 * any future list surface) renders identical rows: avatar, resolved display
 * name (shimmer while loading, retry on error), protocol badge (NIP-17 / MLS),
 * relative last-activity time, numeric unread badge. WelcomeCard — the pending
 * Marmot invite with its Accept action — moved here with it.
 */
import { useEffect, useState } from 'react';
import { useDm, useMarmot } from './coreContext';
import { truncatePeerLabel } from '../core/stores/dm';
import type { DmProfile } from '../core/stores/dm';
import type { MarmotWelcomeInfo, UnifiedConversation } from '../core/stores/marmot';
import { previewText } from '../core/dmAttachments';
import { relativeTime } from './relativeTime';
import { cx, shared as s } from './shared';
import { DmAvatar } from './dm/DmAvatar';
import styles from './dm/dm.module.css';

/** What a tapped tile opens: the peer (NIP-17) or the MLS group (Marmot). */
export type ConversationTarget =
  | { protocol: 'nip17'; peer: string }
  | { protocol: 'marmot'; groupId: string };

export function protocolLabel(protocol: UnifiedConversation['protocol']): string {
  return protocol === 'marmot' ? 'MLS' : 'NIP-17';
}

/** What the tile calls a conversation, and whether that is a real name or a
 *  key standing in for one (the latter renders mono/dim). Same precedence as
 *  MarmotChatScreen's header — profile first, then the peer key, then the MLS
 *  group's own name — so the tile and the open chat never disagree. A group
 *  with more than two members has no single "peer", so its name leads. */
export function conversationLabel(
  conversation: UnifiedConversation,
  profile: DmProfile | undefined,
): { text: string; isKey: boolean } {
  const profileName = profile?.displayName?.trim() || profile?.name?.trim();
  const groupName = conversation.title?.trim();
  const isGroup = conversation.protocol === 'marmot' && conversation.memberCount > 2;

  if (isGroup) {
    return { text: groupName || `Marmot group · ${conversation.memberCount} members`, isKey: false };
  }
  if (profileName) return { text: profileName, isKey: false };
  if (conversation.peerPubkey) {
    return { text: truncatePeerLabel(conversation.peerPubkey), isKey: true };
  }
  return { text: groupName || 'Marmot chat', isKey: false };
}

export function DmTile({
  conversation,
  isSelected,
  showProtocol = true,
  onOpen,
}: {
  conversation: UnifiedConversation;
  /** Sidebar highlight — the conversation currently open in the main panel. */
  isSelected?: boolean;
  /** The badge only disambiguates, so the list drops it when every row is the
   *  same protocol: on a Marmot-only list it is five identical tags eating the
   *  width the peer's name needs. The chat header still states the protocol. */
  showProtocol?: boolean;
  onOpen(target: ConversationTarget): void;
}) {
  const peer = conversation.peerPubkey;
  const profile = useDm((st) => st.profiles[peer]);
  const status = useDm((st) => st.profileStatus[peer]);
  const refreshProfile = useDm((st) => st.resolveProfile);

  const label = conversationLabel(conversation, profile);

  return (
    <button
      className={cx(styles.convRow, isSelected && styles.convRowSelected)}
      data-protocol={conversation.protocol}
      data-testid="dm-tile"
      onClick={() =>
        onOpen(
          conversation.protocol === 'marmot'
            ? { protocol: 'marmot', groupId: conversation.key }
            : { protocol: 'nip17', peer: conversation.key },
        )
      }
    >
      <DmAvatar
        pubkey={peer || conversation.key}
        picture={profile?.picture}
        name={label.isKey ? undefined : label.text}
        sizeRem={2.5}
      />
      <span className={styles.convInfo}>
        <span className={styles.convTop}>
          <span
            className={cx(
              styles.convName,
              label.isKey && styles.convNameKey,
              status === 'loading' && styles.convNameLoading,
            )}
            data-testid="dm-tile-name"
            title={label.text}
          >
            {label.text}
          </span>
          {showProtocol && (
            <span
              className={cx(
                styles.protocolBadge,
                conversation.protocol === 'marmot' && styles.protocolBadgeMls,
              )}
              data-testid="protocol-badge"
            >
              {protocolLabel(conversation.protocol)}
            </span>
          )}
        </span>
        <span className={styles.convPreview}>
          {conversation.lastPreview ? previewText(conversation.lastPreview) : ' '}
        </span>
      </span>
      {status === 'error' && (
        <span
          className={styles.profileRetry}
          role="button"
          title="Couldn't load profile — retry"
          onClick={(e) => {
            e.stopPropagation();
            void refreshProfile(peer, { force: true });
          }}
        >
          ↻
        </span>
      )}
      <span className={styles.convMeta}>
        <span className={styles.convTime}>{relativeTime(conversation.lastMessageAt)}</span>
        {conversation.unreadCount > 0 && (
          <span className={styles.unreadBadge} data-testid="unread-badge">
            {conversation.unreadCount}
          </span>
        )}
      </span>
    </button>
  );
}

/** A pending Marmot group invite — accept joins the group (VEIL-117: a dead
 *  welcome drops the card instead of retrying forever). */
export function WelcomeCard({ welcome }: { welcome: MarmotWelcomeInfo }) {
  const accept = useMarmot((st) => st.acceptWelcome);
  const profile = useDm((st) => st.profiles[welcome.welcomer]);
  const resolveProfile = useDm((st) => st.resolveProfile);
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    void resolveProfile(welcome.welcomer);
  }, [welcome.welcomer, resolveProfile]);

  const name =
    profile?.displayName || profile?.name || truncatePeerLabel(welcome.welcomer);

  return (
    <div className={styles.welcomeCard} data-testid="marmot-welcome-card">
      <DmAvatar pubkey={welcome.welcomer} picture={profile?.picture} name={name} />
      <span className={styles.welcomeInfo}>
        <span className={styles.welcomeTitle}>{name}</span>
        <span className={styles.welcomeSub}>Marmot (MLS) chat invite</span>
      </span>
      <button
        className={s.btnPrimary}
        disabled={accepting}
        onClick={() => {
          setAccepting(true);
          void accept(welcome.welcomeId).finally(() => setAccepting(false));
        }}
      >
        {accepting ? 'Joining…' : 'Accept'}
      </button>
    </div>
  );
}
