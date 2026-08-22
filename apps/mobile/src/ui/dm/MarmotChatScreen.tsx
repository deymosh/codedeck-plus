/**
 * Marmot (MLS) chat screen — Phase 6 (CDX-012). Deliberately the same shell
 * as DmChatScreen (bubbles, per-bubble time, failed sends with Retry, slim
 * profile header, DmBottomBar composer) minus attachments (MIP-04 media is
 * out of Phase 6 scope) and plus the MLS protocol badge. Opening marks the
 * group read (activeGroup suppresses unread counting while open).
 */
import { useEffect, useRef } from 'react';
import { useDm, useMarmot } from '../coreContext';
import { truncatePeerLabel } from '../../core/stores/dm';
import type { MarmotMessage } from '../../core/stores/marmot';
import { cx, shared as s } from '../shared';
import { DmAvatar } from './DmAvatar';
import { DmBottomBar } from './DmBottomBar';
import { DmMessageContent } from './DmMessageContent';
import styles from './dm.module.css';

const EMPTY_MESSAGES: readonly MarmotMessage[] = [];

function formatTime(atMs: number): string {
  return new Date(atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function MarmotChatScreen({ groupId }: { groupId: string }) {
  const conversation = useMarmot((st) => st.conversations[groupId]);
  const messages = useMarmot((st) => st.messages[groupId] ?? EMPTY_MESSAGES);
  const setActiveGroup = useMarmot((st) => st.setActiveGroup);
  const send = useMarmot((st) => st.send);
  const retry = useMarmot((st) => st.retry);

  const peer = conversation?.peerPubkey ?? '';
  const profile = useDm((st) => (peer ? st.profiles[peer] : undefined));
  const resolveProfile = useDm((st) => st.resolveProfile);
  const endRef = useRef<HTMLDivElement>(null);

  // Open/close bookkeeping: activeGroup marks read + suppresses unread counts.
  useEffect(() => {
    setActiveGroup(groupId);
    if (peer) void resolveProfile(peer);
    return () => setActiveGroup(null);
  }, [groupId, peer, setActiveGroup, resolveProfile]);

  // Keep the newest message in view (same simple follow as DmChatScreen).
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ behavior: 'instant' as ScrollBehavior });
  }, [messages.length]);

  const name = profile?.displayName || profile?.name || (peer ? truncatePeerLabel(peer) : conversation?.name || 'Marmot chat');

  return (
    <div className={styles.chat} data-testid="marmot-chat">
      <div className={styles.chatHeader}>
        <DmAvatar
          pubkey={peer || groupId}
          picture={profile?.picture}
          name={profile?.displayName || profile?.name}
          sizeRem={2}
        />
        <span className={styles.chatHeaderName}>{name}</span>
        <span
          className={cx(styles.protocolBadge, styles.protocolBadgeMls)}
          data-testid="protocol-badge"
        >
          MLS
        </span>
      </div>

      <div className={styles.messages}>
        {messages.map((msg) => {
          const sent = peer === '' ? true : msg.senderPubkey !== peer;
          return (
            <div
              key={msg.id}
              className={sent ? styles.bubbleWrapSent : styles.bubbleWrapReceived}
              data-message-status={msg.status}
            >
              <div
                className={cx(
                  sent ? styles.bubbleSent : styles.bubbleReceived,
                  msg.status === 'failed' && styles.bubbleFailed,
                )}
              >
                <DmMessageContent content={msg.content} />
                <div className={styles.bubbleTime}>
                  {formatTime(msg.at)}
                  {msg.status === 'failed' && (
                    <span className={styles.sendFailed}> — send failed</span>
                  )}
                </div>
              </div>
              {msg.status === 'failed' && (
                <button
                  className={styles.retryBtn}
                  onClick={() => void retry(groupId, msg.id)}
                  type="button"
                >
                  Retry
                </button>
              )}
            </div>
          );
        })}
        {messages.length === 0 && (
          <div className={s.empty}>No messages yet — say hi (end-to-end MLS encrypted).</div>
        )}
        <div ref={endRef} />
      </div>

      <DmBottomBar onSend={(text) => void send(groupId, text)} />
    </div>
  );
}
