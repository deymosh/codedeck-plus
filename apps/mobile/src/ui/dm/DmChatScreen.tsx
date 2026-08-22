/**
 * DM chat screen (Phase 5b) — bubbles (sent right / received left), per-bubble
 * time, failed sends visible with a Retry action (ported UX), the peer's
 * profile in a slim header, and the rebuilt DmBottomBar composer. Opening the
 * chat marks the conversation read (activePeer suppresses unread counting
 * while it stays open).
 */
import { useEffect, useRef, useState } from 'react';
import { useDm, usePhoneCore, useSettings } from '../coreContext';
import { truncatePeerLabel, type DmMessage } from '../../core/stores/dm';
import { describeError, isCancelled } from '../../core/deadline';
import { readFileBytes } from '../imageFile';
import { buildImageRef } from '../../core/dmAttachments';
import { DEFAULT_BLOSSOM_SERVER, uploadDmImage } from '../../platform/dmImages';
import { cx, shared as s } from '../shared';
import { DmAvatar } from './DmAvatar';
import { DmBottomBar } from './DmBottomBar';
import { DmMessageContent } from './DmMessageContent';
import styles from './dm.module.css';

const EMPTY_MESSAGES: readonly DmMessage[] = [];

function formatTime(atMs: number): string {
  return new Date(atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function DmChatScreen({ peerPubkey }: { peerPubkey: string }) {
  const core = usePhoneCore();
  const messages = useDm((st) => st.messages[peerPubkey] ?? EMPTY_MESSAGES);
  const profile = useDm((st) => st.profiles[peerPubkey]);
  const profileStatus = useDm((st) => st.profileStatus[peerPubkey]);
  const setActivePeer = useDm((st) => st.setActivePeer);
  const resolveProfile = useDm((st) => st.resolveProfile);
  const send = useDm((st) => st.send);
  const retry = useDm((st) => st.retry);
  const blossomServer = useSettings((st) => st.blossomServer);
  const endRef = useRef<HTMLDivElement>(null);

  // Image attachment (CDX-011, the 5b Blossom deferral): staged file →
  // encrypt+upload on Send → ref line appended to the message content (the old
  // app's wire format). Upload failure keeps the attachment staged and offers
  // a retry with the same text.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingImage, setPendingImage] = useState<{ file: File; previewUrl: string | null } | null>(
    null,
  );
  const [uploading, setUploading] = useState(false);
  const [uploadFailed, setUploadFailed] = useState<{ text: string; message: string } | null>(null);

  /** CDX-086: same two-guard pair as the session composer — the generation ref
   *  suppresses stale write-back, the controller stops the work. */
  const attachGenerationRef = useRef(0);
  const sendAbortRef = useRef<AbortController | null>(null);

  const clearPendingImage = (): void => {
    if (pendingImage?.previewUrl) URL.revokeObjectURL(pendingImage.previewUrl);
    setPendingImage(null);
  };

  /** The ✕ handler. It used to be `disabled={uploading}` — the exact CDX-068
   *  wedge: a stalled upload left the composer with no exit but leaving the
   *  screen. Now it is always live and genuinely cancels. */
  const removePendingImage = (): void => {
    attachGenerationRef.current++;
    sendAbortRef.current?.abort();
    sendAbortRef.current = null;
    clearPendingImage();
    setUploading(false);
    setUploadFailed(null);
  };

  const pickImage = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (pendingImage?.previewUrl) URL.revokeObjectURL(pendingImage.previewUrl);
    const previewUrl =
      typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null;
    setPendingImage({ file, previewUrl });
    setUploadFailed(null);
    e.target.value = '';
  };

  /**
   * CDX-086 brings the DM path up to the session path's guarantees. It shared
   * four of the same defects and its ✕ was strictly worse — `disabled={uploading}`
   * is the exact CDX-068 wedge the session composer was rescued from.
   *
   * Also fixed here: the read was a bare `file.arrayBuffer()` with no fallback,
   * so the CDX-064 defect (a `content://`-backed File whose arrayBuffer rejects
   * in the Android WebView) was never fixed for DMs at all. It now uses the same
   * dual-path, deadline-bounded reader the session composer uses.
   */
  const sendWithAttachment = async (text: string): Promise<void> => {
    if (!pendingImage) {
      if (text !== '') void send(peerPubkey, text);
      return;
    }
    const generation = ++attachGenerationRef.current;
    const abandoned = (): boolean => generation !== attachGenerationRef.current;
    const controller = new AbortController();
    sendAbortRef.current = controller;
    setUploading(true);
    setUploadFailed(null);
    try {
      const bytes = new Uint8Array(await readFileBytes(pendingImage.file));
      if (abandoned()) return;
      const secretKey = core.identity.getState().keypair.secretKey;
      const ref = await uploadDmImage(
        bytes,
        secretKey,
        blossomServer || DEFAULT_BLOSSOM_SERVER,
        { signal: controller.signal },
      );
      if (abandoned()) return;
      const line = buildImageRef(ref);
      const content = text !== '' ? `${text}\n${line}` : line;
      clearPendingImage();
      void send(peerPubkey, content);
    } catch (err) {
      // A cancel is the user's own doing — clearPendingImage already tidied up.
      if (abandoned() || isCancelled(err)) return;
      // Attachment stays staged; the typed text is preserved on the retry.
      setUploadFailed({ text, message: describeError(err) });
    } finally {
      if (!abandoned()) setUploading(false);
      if (sendAbortRef.current === controller) sendAbortRef.current = null;
    }
  };

  // Open/close bookkeeping: activePeer marks read + suppresses unread counts.
  useEffect(() => {
    setActivePeer(peerPubkey);
    void resolveProfile(peerPubkey);
    return () => setActivePeer(null);
  }, [peerPubkey, setActivePeer, resolveProfile]);

  // Keep the newest message in view (simple chat-style follow; ported).
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ behavior: 'instant' as ScrollBehavior });
  }, [messages.length]);

  const name = profile?.displayName || profile?.name || truncatePeerLabel(peerPubkey);

  return (
    <div className={styles.chat} data-testid="dm-chat">
      <div className={styles.chatHeader}>
        <DmAvatar
          pubkey={peerPubkey}
          picture={profile?.picture}
          name={profile?.displayName || profile?.name}
          sizeRem={2}
        />
        <span className={styles.chatHeaderName}>
          {name}
          {profileStatus === 'error' && (
            <>
              {' '}
              <button
                className={styles.profileRetryText}
                onClick={() => void resolveProfile(peerPubkey, { force: true })}
                type="button"
              >
                couldn't load profile — retry
              </button>
            </>
          )}
        </span>
      </div>

      <div className={styles.messages}>
        {messages.map((msg) => {
          const sent = msg.senderPubkey !== peerPubkey;
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
                  onClick={() => void retry(peerPubkey, msg.id)}
                  type="button"
                >
                  Retry
                </button>
              )}
            </div>
          );
        })}
        {messages.length === 0 && (
          <div className={s.empty}>No messages yet — say hi.</div>
        )}
        <div ref={endRef} />
      </div>

      {pendingImage && (
        <div className={styles.attachStrip} data-testid="dm-attach-strip">
          {pendingImage.previewUrl ? (
            <img
              className={styles.attachThumb}
              src={pendingImage.previewUrl}
              alt="attachment preview"
            />
          ) : (
            <span className={styles.attachName}>{pendingImage.file.name}</span>
          )}
          <span className={styles.attachName}>
            {uploading ? 'uploading…' : `${Math.max(1, Math.round(pendingImage.file.size / 1024))} KB`}
          </span>
          <button
            className={s.btnSmall}
            onClick={removePendingImage}
            aria-label="Remove attachment"
          >
            ✕
          </button>
        </div>
      )}
      {uploadFailed && (
        <div className={s.bannerError} data-testid="dm-upload-failed">
          Image upload failed: {uploadFailed.message}{' '}
          <button className={s.btnSmall} onClick={() => void sendWithAttachment(uploadFailed.text)}>
            Retry
          </button>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={pickImage}
        data-testid="dm-file-input"
      />
      <DmBottomBar
        onSend={(text) => void sendWithAttachment(text)}
        onAttach={() => fileInputRef.current?.click()}
        canSendEmpty={pendingImage !== null && !uploading}
        disabled={uploading}
      />
    </div>
  );
}
